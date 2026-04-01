/**
 * Publisher for monorepo workspaces.
 * Handles version validation, npm publish, Docker workflow dispatch, and git tagging.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { MonorepoConfig } from '../config.js';
import type { DependencyGraph, WorkspacePackage } from './Workspace.js';
import {
  type GateStamp,
  GateStampResult,
  readGateStamp,
  validatePackageStamp,
  writeGateStamp,
  computeSourceHash,
} from './GateStamp.js';
import { getCurrentBranch } from './ChangeDetector.js';
import { build, install } from './Builder.js';

// ── Types ────────────────────────────────────────────────────────────

interface PublishResult {
  name: string;
  version: string;
  previousVersion: string;
  published: boolean;
  skipped?: string;
}

interface PublishOptions {
  dryRun: boolean;
  force: boolean;
  verbose: boolean;
  repoRoot: string;
  graph: DependencyGraph;
  affectedOrdered: string[];
  config: MonorepoConfig;
}

// ── Helpers ──────────────────────────────────────────────────────────

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim();
}

/**
 * Check if a specific version of a package is already published on the registry.
 */
function isVersionPublished(
  packageName: string,
  version: string,
  registry?: string,
): boolean {
  try {
    const args = ['view', `${packageName}@${version}`, 'version'];
    if (registry) args.push('--registry', registry);
    const result = execFileSync('npm', args, { encoding: 'utf-8', timeout: 15_000 }).trim();
    return result === version;
  } catch {
    // npm view exits non-zero if version doesn't exist
    return false;
  }
}

/**
 * Get the latest published version of a package from the registry.
 */
function getLatestPublishedVersion(
  packageName: string,
  registry?: string,
): string | null {
  try {
    const args = ['view', packageName, 'version'];
    if (registry) args.push('--registry', registry);
    return execFileSync('npm', args, { encoding: 'utf-8', timeout: 15_000 }).trim() || null;
  } catch {
    return null;
  }
}

/**
 * Increment the patch version.
 */
function incrementPatch(version: string): string {
  const parts = version.split('.');
  if (parts.length !== 3) throw new Error(`Invalid semver: ${version}`);
  parts[2] = String(parseInt(parts[2], 10) + 1);
  return parts.join('.');
}

/**
 * Resolve the version to publish:
 * - If the current version is NOT on the registry, use it
 * - If it IS on the registry, auto-patch-bump until we find an unpublished version
 */
function resolvePublishVersion(
  pkg: WorkspacePackage,
  registry?: string,
): { version: string; bumped: boolean } {
  let version = pkg.version;

  if (!isVersionPublished(pkg.name, version, registry)) {
    return { version, bumped: false };
  }

  // Version exists — auto-patch-bump
  let attempts = 0;
  while (attempts < 50) {
    version = incrementPatch(version);
    if (!isVersionPublished(pkg.name, version, registry)) {
      return { version, bumped: true };
    }

    attempts += 1;
  }

  throw new Error(`${pkg.name}: could not find unpublished version after 50 patch bumps from ${pkg.version}`);
}

/**
 * Write the resolved version to a package's package.json.
 */
function patchPackageJsonVersion(pkg: WorkspacePackage, newVersion: string): void {
  const pkgJsonPath = join(pkg.dir, 'package.json');
  const content = readFileSync(pkgJsonPath, 'utf-8');
  // Replace version field precisely
  const updated = content.replace(
    /"version"\s*:\s*"[^"]+"/,
    `"version": "${newVersion}"`,
  );
  writeFileSync(pkgJsonPath, updated);
}

/**
 * Update internal dependency references in a package's package.json.
 */
function updateDependencyVersion(
  pkg: WorkspacePackage,
  depName: string,
  newVersion: string,
): void {
  const pkgJsonPath = join(pkg.dir, 'package.json');
  const content = readFileSync(pkgJsonPath, 'utf-8');
  const pkgJson = JSON.parse(content);
  let changed = false;

  for (const section of ['dependencies', 'devDependencies', 'peerDependencies']) {
    if (pkgJson[section]?.[depName]) {
      const current = pkgJson[section][depName];
      // Preserve range prefix (^, ~, etc.)
      const prefix = current.match(/^[^0-9]*/)?.[0] ?? '^';
      pkgJson[section][depName] = `${prefix}${newVersion}`;
      changed = true;
    }
  }

  if (changed) {
    writeFileSync(pkgJsonPath, JSON.stringify(pkgJson, null, 2) + '\n');
  }
}

/**
 * Detect the GitHub repository from git remote.
 */
function detectGithubRepo(repoRoot: string): string | null {
  try {
    const remote = git(['remote', 'get-url', 'origin'], repoRoot);
    // Handle SSH: git@github.com:owner/repo.git
    const sshMatch = remote.match(/github\.com[:/]([^/]+\/[^/.]+)/);
    if (sshMatch) return sshMatch[1];
    // Handle HTTPS: https://github.com/owner/repo.git
    const httpsMatch = remote.match(/github\.com\/([^/]+\/[^/.]+)/);
    if (httpsMatch) return httpsMatch[1];
    return null;
  } catch {
    return null;
  }
}

// ── Main Publish Flow ────────────────────────────────────────────────

export function publish(opts: PublishOptions): void {
  const { dryRun, force, verbose, repoRoot, graph, affectedOrdered, config } = opts;
  const registry = config.registry;

  // 1. Guard: must be on main
  const branch = getCurrentBranch(repoRoot);
  if (branch !== 'main' && branch !== 'master' && !force) {
    console.error(`Cannot publish from branch '${branch}'. Switch to main or use --force.`);
    process.exit(1);
  }

  // 2. Validate gate stamp
  console.log('\n── validate gate stamp ──');
  const stamp = readGateStamp(repoRoot);
  const invalidPackages: string[] = [];

  for (const name of affectedOrdered) {
    const pkg = graph.packages.get(name)!;
    const result = validatePackageStamp(pkg, stamp, config);
    const shortName = pkg.name.replace(/^@[^/]+\//, '');

    if (result === GateStampResult.VALID) {
      console.log(`  ✓ ${shortName}`);
    } else {
      console.log(`  ✗ ${shortName} (${result})`);
      invalidPackages.push(name);
    }
  }

  if (invalidPackages.length > 0) {
    console.error(
      '\ngate-stamp.json is invalid for the above packages.\n' +
      'Run `zbb gate` locally and commit the stamp before publishing.'
    );
    process.exit(1);
  }

  // 3. Filter publishable packages
  const skipPublish = new Set(config.skipPublish ?? []);
  const publishable = affectedOrdered.filter(name => {
    const pkg = graph.packages.get(name)!;
    if (pkg.private) return false;
    if (skipPublish.has(pkg.relDir)) return false;
    return true;
  });

  if (publishable.length === 0) {
    console.log('\nNothing to publish — all affected packages are private or skipped.');
    return;
  }

  // 4. Version resolution
  console.log('\n── version resolution ──');
  const versionMap = new Map<string, { version: string; bumped: boolean; previous: string }>();

  for (const name of publishable) {
    const pkg = graph.packages.get(name)!;
    const shortName = pkg.name.replace(/^@[^/]+\//, '');
    const { version, bumped } = resolvePublishVersion(pkg, registry);

    versionMap.set(name, { version, bumped, previous: pkg.version });

    if (bumped) {
      console.log(`  ${shortName}: ${pkg.version} → ${version} (auto-bumped, ${pkg.version} already published)`);
    } else {
      console.log(`  ${shortName}: ${version}`);
    }
  }

  if (dryRun) {
    console.log('\n── dry run ──');
    console.log('Would publish:');
    for (const name of publishable) {
      const info = versionMap.get(name)!;
      const pkg = graph.packages.get(name)!;
      const shortName = pkg.name.replace(/^@[^/]+\//, '');
      console.log(`  ${shortName}@${info.version}`);
    }

    const images = config.images ?? {};
    const imagePackages = publishable.filter(name => {
      const pkg = graph.packages.get(name)!;
      return images[pkg.relDir];
    });
    if (imagePackages.length > 0) {
      console.log('\nWould trigger Docker builds:');
      for (const name of imagePackages) {
        const pkg = graph.packages.get(name)!;
        const img = images[pkg.relDir];
        console.log(`  ${img.name} (workflow: ${img.workflow ?? 'N/A'})`);
      }
    }

    console.log('\n(dry run — no changes made)');
    return;
  }

  // 5. Patch versions in package.json files
  console.log('\n── patch versions ──');
  for (const name of publishable) {
    const pkg = graph.packages.get(name)!;
    const { version: newVersion } = versionMap.get(name)!;

    // Patch this package's version
    if (newVersion !== pkg.version) {
      patchPackageJsonVersion(pkg, newVersion);
    }

    // Update dependents' references
    const depNames = graph.dependents.get(name) ?? new Set();
    for (const depName of depNames) {
      const depPkg = graph.packages.get(depName);
      if (depPkg) {
        updateDependencyVersion(depPkg, name, newVersion);
      }
    }
  }
  console.log('  ✓ package.json files patched');

  // 6. Build (if needed — ensure dist/ is fresh with new versions)
  console.log('\n── build ──');
  install(repoRoot);
  build({
    repoRoot,
    graph,
    affectedOrdered: publishable,
    config,
    verbose,
  });

  // 7. npm publish
  console.log('\n── publish ──');
  const results: PublishResult[] = [];

  for (const name of publishable) {
    const pkg = graph.packages.get(name)!;
    const shortName = pkg.name.replace(/^@[^/]+\//, '');
    const { version, previous } = versionMap.get(name)!;

    process.stdout.write(`  ${shortName}@${version}... `);

    try {
      const publishArgs = ['publish'];
      if (registry) publishArgs.push('--registry', registry);

      execFileSync('npm', publishArgs, {
        cwd: pkg.dir,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: process.env,
        timeout: 60_000,
      });

      console.log('✓');
      results.push({ name, version, previousVersion: previous, published: true });
    } catch (error: any) {
      const stderr = error.stderr?.toString() ?? '';

      // Check if it's an "already exists" error (idempotent)
      if (stderr.includes('cannot publish over the previously published version')) {
        console.log('already published');
        results.push({ name, version, previousVersion: previous, published: false, skipped: 'already published' });
      } else {
        console.log('FAILED');
        console.error(`    ${stderr.slice(0, 500)}`);
        results.push({ name, version, previousVersion: previous, published: false, skipped: 'error' });
      }
    }
  }

  // 8. Docker image dispatch
  const images = config.images ?? {};
  const githubRepo = config.githubRepo ?? detectGithubRepo(repoRoot);
  const imagePackages = results.filter(r => {
    const pkg = graph.packages.get(r.name)!;
    return r.published && images[pkg.relDir]?.workflow;
  });

  if (imagePackages.length > 0 && githubRepo) {
    console.log('\n── docker image dispatch ──');
    for (const result of imagePackages) {
      const pkg = graph.packages.get(result.name)!;
      const img = images[pkg.relDir];
      const shortName = pkg.name.replace(/^@[^/]+\//, '');

      process.stdout.write(`  ${img.name} (${img.workflow})... `);
      try {
        execFileSync('gh', [
          'workflow', 'run', img.workflow!,
          '--repo', githubRepo,
          '-f', `version=${result.version}`,
        ], {
          cwd: repoRoot,
          stdio: ['pipe', 'pipe', 'pipe'],
          timeout: 30_000,
        });
        console.log('dispatched');
      } catch (error: any) {
        console.log('failed');
        if (verbose) {
          console.error(`    ${error.stderr?.toString().slice(0, 300) ?? error.message}`);
        }
      }
    }
  }

  // 9. Git tag + commit
  console.log('\n── git ──');
  const publishedResults = results.filter(r => r.published);

  if (publishedResults.length > 0) {
    // Create tags
    for (const result of publishedResults) {
      const pkg = graph.packages.get(result.name)!;
      const shortName = pkg.name.replace(/^@[^/]+\//, '');
      const tag = `${shortName}@${result.version}`;
      try {
        git(['tag', tag], repoRoot);
      } catch { /* tag may already exist */ }
    }

    // Update gate stamp hashes post-publish
    const currentStamp = readGateStamp(repoRoot);
    if (currentStamp) {
      currentStamp.timestamp = new Date().toISOString();
      for (const result of publishedResults) {
        const pkg = graph.packages.get(result.name)!;
        if (currentStamp.packages[result.name]) {
          currentStamp.packages[result.name].version = result.version;
          currentStamp.packages[result.name].sourceHash = computeSourceHashForPublish(pkg, config);
        }
      }
      writeGateStamp(repoRoot, currentStamp);
    }

    // Stage and commit
    const filesToStage = ['gate-stamp.json'];
    for (const result of publishedResults) {
      const pkg = graph.packages.get(result.name)!;
      filesToStage.push(join(pkg.relDir, 'package.json'));
    }
    // Also stage any dependents whose package.json was updated
    for (const result of publishedResults) {
      const depNames = graph.dependents.get(result.name) ?? new Set();
      for (const depName of depNames) {
        const depPkg = graph.packages.get(depName);
        if (depPkg) {
          const relPath = join(depPkg.relDir, 'package.json');
          if (!filesToStage.includes(relPath)) {
            filesToStage.push(relPath);
          }
        }
      }
    }

    try {
      git(['add', ...filesToStage], repoRoot);
      const versions = publishedResults.map(r => {
        const shortName = graph.packages.get(r.name)!.name.replace(/^@[^/]+\//, '');
        return `${shortName}@${r.version}`;
      });
      git(['commit', '-m', `chore(release): publish ${versions.join(', ')}`], repoRoot);
      console.log('  ✓ committed version bumps + gate stamp');
    } catch (error: any) {
      console.warn(`  ⚠ git commit failed: ${error.message}`);
    }

    // Push tags + commit
    try {
      git(['push', '--follow-tags'], repoRoot);
      console.log('  ✓ pushed to remote');
    } catch (error: any) {
      console.warn(`  ⚠ git push failed: ${error.message}`);
      console.warn('    Run manually: git push --follow-tags');
    }
  }

  // 10. Summary
  console.log('\n── summary ──');
  console.log(`  Published: ${publishedResults.length}/${publishable.length}`);
  for (const result of results) {
    const shortName = graph.packages.get(result.name)!.name.replace(/^@[^/]+\//, '');
    const status = result.published ? '✓' : `✗ (${result.skipped})`;
    const bump = result.version !== result.previousVersion
      ? ` (${result.previousVersion} → ${result.version})`
      : '';
    console.log(`  ${status} ${shortName}@${result.version}${bump}`);
  }
}

// Re-export for use in git operations
function computeSourceHashForPublish(pkg: WorkspacePackage, config: MonorepoConfig): string {
  return computeSourceHash(pkg, config);
}
