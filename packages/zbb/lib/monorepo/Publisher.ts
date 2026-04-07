/**
 * Publisher for monorepo workspaces.
 * Handles per-package change detection, version resolution, prepublish-standalone,
 * npm publish, git tagging, and publish report output.
 *
 * This is monorepo-only. The existing non-monorepo publish flow is separate.
 */

import { execFileSync, execSync } from 'node:child_process';
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import type { MonorepoConfig } from '../config.js';
import { getZbbDir } from '../config.js';
import type { DependencyGraph, WorkspacePackage } from './Workspace.js';
import { getTransitiveDependents, sortByBuildOrder } from './Workspace.js';
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
  location: string;
  published: boolean;
  skipped?: string;
}

export interface PublishOptions {
  dryRun: boolean;
  force: boolean;
  verbose: boolean;
  repoRoot: string;
  graph: DependencyGraph;
  config: MonorepoConfig;
}

// ── Git Helpers ──────────────────────────────────────────────────────

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim();
}

function shortName(pkg: WorkspacePackage): string {
  return pkg.name.replace(/^@[^/]+\//, '');
}

// ── Per-Package Change Detection ─────────────────────────────────────

/**
 * Find the last published git tag for a package.
 * Tags follow the format: <shortName>@<version>
 */
function getLastPublishedTag(pkg: WorkspacePackage, repoRoot: string): string | null {
  const sn = shortName(pkg);
  try {
    return execFileSync('git', ['describe', '--tags', '--abbrev=0', `--match=${sn}@*`], {
      cwd: repoRoot,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch {
    return null;
  }
}

/**
 * Get files changed for a specific package directory since a git ref.
 * Excludes docs and CI files.
 */
function getChangedFilesSinceRef(
  repoRoot: string,
  ref: string,
  pathFilter?: string,
): string[] {
  try {
    const args = ['diff', '--name-only', `${ref}..HEAD`];
    if (pathFilter) args.push('--', pathFilter);
    const output = git(args, repoRoot);
    if (!output) return [];
    return output.split('\n').filter(f =>
      !f.endsWith('.md') &&
      !f.startsWith('.github/') &&
      !f.startsWith('.claude/'),
    );
  } catch {
    return [];
  }
}

const STACK_TRIGGER_PATTERNS = ['zbb.yaml', '.zbb.yaml', 'test/'];

/**
 * Detect which packages need publishing based on per-package tag comparison.
 * Returns packages in build order including transitive dependents.
 */
function detectPublishChanges(
  repoRoot: string,
  graph: DependencyGraph,
): { changed: Set<string>; publishOrdered: string[] } {
  const changed = new Set<string>();

  // Check each package against its last published tag
  for (const [name, pkg] of graph.packages) {
    if (pkg.private) continue;

    const lastTag = getLastPublishedTag(pkg, repoRoot);
    if (!lastTag) {
      // Never published — always include
      changed.add(name);
      continue;
    }

    const changedFiles = getChangedFilesSinceRef(repoRoot, lastTag, pkg.relDir);
    if (changedFiles.length > 0) {
      changed.add(name);
    }
  }

  // Stack special case: check root trigger files
  const stackPkg = findStackPackage(graph);
  if (stackPkg && !changed.has(stackPkg.name)) {
    const stackTag = getLastPublishedTag(stackPkg, repoRoot);
    const ref = stackTag ?? 'HEAD~1';

    for (const pattern of STACK_TRIGGER_PATTERNS) {
      const files = getChangedFilesSinceRef(repoRoot, ref, pattern);
      if (files.length > 0) {
        changed.add(stackPkg.name);
        break;
      }
    }
  }

  // Expand to transitive dependents
  const affected = new Set(changed);
  for (const name of changed) {
    const deps = getTransitiveDependents(name, graph);
    for (const dep of deps) {
      if (!graph.packages.get(dep)?.private) {
        affected.add(dep);
      }
    }
  }

  const publishOrdered = sortByBuildOrder(affected, graph);
  return { changed, publishOrdered };
}

function findStackPackage(graph: DependencyGraph): WorkspacePackage | undefined {
  for (const pkg of graph.packages.values()) {
    if (pkg.relDir === 'stack') return pkg;
  }
  return undefined;
}

// ── Version Resolution ───────────────────────────────────────────────

/**
 * Get all published versions for a package in one call.
 */
function getPublishedVersions(packageName: string, registry?: string): Set<string> {
  try {
    const args = ['view', packageName, 'versions', '--json'];
    if (registry) args.push('--registry', registry);
    const output = execFileSync('npm', args, { encoding: 'utf-8', timeout: 30_000 }).trim();
    const versions = JSON.parse(output);
    // npm returns a string for single version, array for multiple
    if (typeof versions === 'string') return new Set([versions]);
    if (Array.isArray(versions)) return new Set(versions);
    return new Set();
  } catch {
    return new Set();
  }
}

function incrementPatch(version: string): string {
  const parts = version.split('.');
  if (parts.length !== 3) throw new Error(`Invalid semver: ${version}`);
  parts[2] = String(parseInt(parts[2], 10) + 1);
  return parts.join('.');
}

/**
 * Resolve the version to publish:
 * - If the current version is NOT published, use it
 * - If it IS published, auto-patch-bump until we find an unpublished version
 */
function resolvePublishVersion(
  pkg: WorkspacePackage,
  publishedVersions: Set<string>,
): { version: string; bumped: boolean } {
  let version = pkg.version;

  if (!publishedVersions.has(version)) {
    return { version, bumped: false };
  }

  let attempts = 0;
  while (attempts < 50) {
    version = incrementPatch(version);
    if (!publishedVersions.has(version)) {
      return { version, bumped: true };
    }
    attempts += 1;
  }

  throw new Error(`${pkg.name}: could not find unpublished version after 50 patch bumps from ${pkg.version}`);
}

// ── Package.json Manipulation ────────────────────────────────────────

function patchPackageJsonVersion(pkg: WorkspacePackage, newVersion: string): void {
  const pkgJsonPath = join(pkg.dir, 'package.json');
  const content = readFileSync(pkgJsonPath, 'utf-8');
  const updated = content.replace(
    /"version"\s*:\s*"[^"]+"/,
    `"version": "${newVersion}"`,
  );
  writeFileSync(pkgJsonPath, updated);
}

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
      const prefix = current.match(/^[^0-9]*/)?.[0] ?? '^';
      pkgJson[section][depName] = `${prefix}${newVersion}`;
      changed = true;
    }
  }

  if (changed) {
    writeFileSync(pkgJsonPath, JSON.stringify(pkgJson, null, 2) + '\n');
  }
}

// ── Prepublish-Standalone ────────────────────────────────────────────

/**
 * Backup package.json, run prepublish-standalone, return backup path.
 */
function runPrepublishStandalone(pkg: WorkspacePackage, repoRoot: string, verbose: boolean): string {
  const pkgJsonPath = join(pkg.dir, 'package.json');
  const backupPath = pkgJsonPath + '.zbb-publish-backup';

  // Backup current (versioned) package.json
  copyFileSync(pkgJsonPath, backupPath);

  try {
    execFileSync('npx', ['prepublish-standalone'], {
      cwd: pkg.dir,
      stdio: verbose ? 'inherit' : ['pipe', 'pipe', 'pipe'],
      env: process.env,
      timeout: 120_000,
    });
  } catch (error: any) {
    // Restore on failure
    copyFileSync(backupPath, pkgJsonPath);
    rmSync(backupPath);
    throw new Error(`prepublish-standalone failed for ${pkg.name}: ${error.message}`);
  }

  return backupPath;
}

function restorePrepublishBackup(backupPath: string): void {
  const pkgJsonPath = backupPath.replace('.zbb-publish-backup', '');
  if (existsSync(backupPath)) {
    copyFileSync(backupPath, pkgJsonPath);
    rmSync(backupPath);
  }
}

// ── Stack Artifact Handling ──────────────────────────────────────────

function copyStackArtifacts(repoRoot: string): string[] {
  const copied: string[] = [];
  const stackDir = join(repoRoot, 'stack');

  if (!existsSync(stackDir)) return copied;

  // Copy zbb.yaml
  const zbbYaml = join(repoRoot, 'zbb.yaml');
  if (existsSync(zbbYaml)) {
    copyFileSync(zbbYaml, join(stackDir, 'zbb.yaml'));
    copied.push('stack/zbb.yaml');
  }

  // Copy .zbb.yaml
  const dotZbbYaml = join(repoRoot, '.zbb.yaml');
  if (existsSync(dotZbbYaml)) {
    copyFileSync(dotZbbYaml, join(stackDir, '.zbb.yaml'));
    copied.push('stack/.zbb.yaml');
  }

  // Copy test/ directory
  const testDir = join(repoRoot, 'test');
  if (existsSync(testDir)) {
    const stackTestDir = join(stackDir, 'test');
    mkdirSync(stackTestDir, { recursive: true });
    cpSync(testDir, stackTestDir, { recursive: true });
    copied.push('stack/test');
  }

  // Validate stack/zbb.yaml
  const stackZbbYaml = join(stackDir, 'zbb.yaml');
  if (existsSync(stackZbbYaml)) {
    try {
      const content = readFileSync(stackZbbYaml, 'utf-8');
      // Simple YAML name field check — matches publish-hoisted validation
      if (!content.includes('name:')) {
        console.error('  ✗ stack/zbb.yaml missing required "name" field');
        process.exit(1);
      }
    } catch (err: any) {
      console.error(`  ✗ stack/zbb.yaml validation failed: ${err.message}`);
      process.exit(1);
    }
  }

  return copied;
}

// ── Docker Image Dispatch ────────────────────────────────────────────

function detectGithubRepo(repoRoot: string): string | null {
  try {
    const remote = git(['remote', 'get-url', 'origin'], repoRoot);
    const sshMatch = remote.match(/github\.com[:/]([^/]+\/[^/.]+)/);
    if (sshMatch) return sshMatch[1];
    const httpsMatch = remote.match(/github\.com\/([^/]+\/[^/.]+)/);
    if (httpsMatch) return httpsMatch[1];
    return null;
  } catch {
    return null;
  }
}

function dispatchImageWorkflows(
  results: PublishResult[],
  config: MonorepoConfig,
  graph: DependencyGraph,
  repoRoot: string,
  verbose: boolean,
): void {
  const images = config.images ?? {};
  if (Object.keys(images).length === 0) return;

  const githubRepo = config.githubRepo ?? detectGithubRepo(repoRoot);
  if (!githubRepo) {
    console.warn('  ⚠ could not detect GitHub repo — skipping image dispatch');
    return;
  }

  const publishedWithImage = results.filter(r => {
    if (!r.published) return false;
    const pkg = graph.packages.get(r.name);
    return pkg && images[pkg.relDir]?.workflow;
  });

  if (publishedWithImage.length === 0) return;

  console.log('\n── image dispatch ──');
  for (const result of publishedWithImage) {
    const pkg = graph.packages.get(result.name)!;
    const img = images[pkg.relDir];
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
      console.log('\x1b[32m✓\x1b[0m');
    } catch (error: any) {
      console.log('\x1b[31m✗\x1b[0m');
      if (verbose) {
        console.error(`    ${error.stderr?.toString().slice(0, 300) ?? error.message}`);
      }
    }
  }
}

// ── Publish Report ───────────────────────────────────────────────────

function writePublishReport(results: PublishResult[], repoRoot: string): string {
  const published = results
    .filter(r => r.published)
    .map(r => ({
      name: r.name,
      version: r.version,
      location: r.location,
    }));

  const reportPath = '/tmp/published-packages.json';
  writeFileSync(reportPath, JSON.stringify(published, null, 2) + '\n');
  return reportPath;
}

// ── Main Publish Flow ────────────────────────────────────────────────

export async function publish(opts: PublishOptions): Promise<void> {
  const { dryRun, force, verbose, repoRoot, graph, config } = opts;
  const registry = config.registry;

  // ── 1. Branch guard ──
  const branch = getCurrentBranch(repoRoot);
  if (branch !== 'main' && branch !== 'master' && !force && !dryRun) {
    console.error(`\nCannot publish from branch '${branch}'. Switch to main or use --force.`);
    process.exit(1);
  }

  // ── 2. Registry guard ──
  const slotName = process.env.ZB_SLOT;
  if (slotName) {
    const publishManifest = join(getZbbDir(), 'slots', slotName, 'stacks', 'registry', 'publishes.json');
    if (existsSync(publishManifest)) {
      const publishes = JSON.parse(readFileSync(publishManifest, 'utf-8'));
      if (Array.isArray(publishes) && publishes.length > 0) {
        console.error('\nCannot publish — local registry packages in use:');
        for (const pkg of publishes) {
          console.error(`  ${pkg.name}@${pkg.version}`);
        }
        console.error('Run: zbb registry clear');
        process.exit(1);
      }
    }
  }

  // ── 3. Validate gate stamp ──
  console.log('\n── validate gate stamp ──');
  const stamp = readGateStamp(repoRoot);

  // Gate stamp must exist
  if (!stamp) {
    console.error('  ✗ gate-stamp.json not found');
    console.error('\nRun `zbb gate` and commit the stamp before publishing.');
    process.exit(1);
  }

  // Validate all non-private packages in the stamp
  let stampValid = true;
  for (const [name, pkg] of graph.packages) {
    if (pkg.private) continue;
    const result = validatePackageStamp(pkg, stamp, config);
    const sn = shortName(pkg);

    if (result === GateStampResult.VALID) {
      console.log(`  \x1b[32m✓\x1b[0m ${sn}`);
    } else {
      console.log(`  \x1b[31m✗\x1b[0m ${sn} (${result})`);
      stampValid = false;
    }
  }

  if (!stampValid && !force) {
    console.error(
      '\ngate-stamp.json is invalid for the above packages.\n' +
      'Run `zbb gate` locally and commit the stamp before publishing.',
    );
    process.exit(1);
  }

  // ── 4. Per-package change detection ──
  console.log('\n── detect changes ──');
  const { changed, publishOrdered } = detectPublishChanges(repoRoot, graph);

  // Filter out skipPublish packages
  const skipPublish = new Set(config.skipPublish ?? []);
  const publishable = publishOrdered.filter(name => {
    const pkg = graph.packages.get(name)!;
    return !skipPublish.has(pkg.relDir);
  });

  if (publishable.length === 0) {
    console.log('  No packages have changed since their last published tag.');
    return;
  }

  for (const name of publishable) {
    const pkg = graph.packages.get(name)!;
    const sn = shortName(pkg);
    const isDirectChange = changed.has(name);
    if (isDirectChange) {
      console.log(`  \x1b[31m✗\x1b[0m ${sn} \x1b[31m— changed\x1b[0m`);
    } else {
      console.log(`  \x1b[33m~\x1b[0m ${sn} \x1b[33m— dependency changed\x1b[0m`);
    }
  }

  // ── 5. Version resolution ──
  console.log('\n── version resolution ──');
  const versionMap = new Map<string, { version: string; bumped: boolean; previous: string }>();

  for (const name of publishable) {
    const pkg = graph.packages.get(name)!;
    const sn = shortName(pkg);

    process.stdout.write(`  ${sn}: checking registry... `);
    const publishedVersions = getPublishedVersions(pkg.name, registry);
    const { version, bumped } = resolvePublishVersion(pkg, publishedVersions);
    versionMap.set(name, { version, bumped, previous: pkg.version });

    if (bumped) {
      console.log(`${pkg.version} → ${version} (auto-bumped)`);
    } else {
      console.log(version);
    }
  }

  // ── Dry run exit ──
  if (dryRun) {
    console.log('\n── dry run ──');
    console.log('Would publish:');
    for (const name of publishable) {
      const info = versionMap.get(name)!;
      const pkg = graph.packages.get(name)!;
      console.log(`  ${shortName(pkg)}@${info.version}`);
    }
    const images = config.images ?? {};
    const imagePackages = publishable.filter(name => {
      const pkg = graph.packages.get(name)!;
      return images[pkg.relDir]?.workflow;
    });
    if (imagePackages.length > 0) {
      console.log('\nWould trigger image builds:');
      for (const name of imagePackages) {
        const pkg = graph.packages.get(name)!;
        const img = images[pkg.relDir];
        console.log(`  ${img.name} → ${img.workflow}`);
      }
    }

    console.log('\n(dry run — no changes made)');
    return;
  }

  // ── 6. Patch versions in package.json ──
  console.log('\n── patch versions ──');
  for (const name of publishable) {
    const pkg = graph.packages.get(name)!;
    const { version: newVersion } = versionMap.get(name)!;

    if (newVersion !== pkg.version) {
      patchPackageJsonVersion(pkg, newVersion);
    }

    // Update dependents' references to this package
    const depNames = graph.dependents.get(name) ?? new Set();
    for (const depName of depNames) {
      const depPkg = graph.packages.get(depName);
      if (depPkg) {
        updateDependencyVersion(depPkg, name, newVersion);
      }
    }
  }
  console.log('  ✓ package.json files patched');

  // ── 7. Stack artifact copy ──
  const stackPkg = findStackPackage(graph);
  let stackArtifacts: string[] = [];
  if (stackPkg && publishable.includes(stackPkg.name)) {
    console.log('\n── stack artifacts ──');
    stackArtifacts = copyStackArtifacts(repoRoot);
    if (stackArtifacts.length > 0) {
      console.log(`  ✓ copied: ${stackArtifacts.join(', ')}`);
    }
  }

  // ── 8. Build ──
  console.log('\n── build ──');
  install(repoRoot);
  await build({
    repoRoot,
    graph,
    affectedOrdered: publishable,
    config,
    verbose,
  });

  // ── 9. Prepublish-standalone ──
  console.log('\n── prepublish-standalone ──');
  const backupPaths: string[] = [];

  for (const name of publishable) {
    const pkg = graph.packages.get(name)!;
    const sn = shortName(pkg);
    process.stdout.write(`  ${sn}... `);
    try {
      const backupPath = runPrepublishStandalone(pkg, repoRoot, verbose);
      backupPaths.push(backupPath);
      console.log('✓');
    } catch (error: any) {
      console.log('FAILED');
      console.error(`    ${error.message}`);
      // Restore all backups on failure
      for (const bp of backupPaths) restorePrepublishBackup(bp);
      process.exit(1);
    }
  }

  // ── 10. Git commit ──
  console.log('\n── git commit ──');
  const filesToStage: string[] = [];

  // Stage gate stamp
  if (existsSync(join(repoRoot, 'gate-stamp.json'))) {
    // Update stamp with new versions
    const currentStamp = readGateStamp(repoRoot);
    if (currentStamp) {
      currentStamp.timestamp = new Date().toISOString();
      for (const name of publishable) {
        const pkg = graph.packages.get(name)!;
        const info = versionMap.get(name)!;
        if (currentStamp.packages[name]) {
          currentStamp.packages[name].version = info.version;
          currentStamp.packages[name].sourceHash = computeSourceHash(pkg, config);
        }
      }
      writeGateStamp(repoRoot, currentStamp);
    }
    filesToStage.push('gate-stamp.json');
  }

  // Stage package.json files (published packages + their dependents)
  for (const name of publishable) {
    const pkg = graph.packages.get(name)!;
    filesToStage.push(join(pkg.relDir, 'package.json'));

    const depNames = graph.dependents.get(name) ?? new Set();
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

  // Stage stack artifacts
  for (const artifact of stackArtifacts) {
    filesToStage.push(artifact);
  }

  const versions = publishable.map(name => {
    const pkg = graph.packages.get(name)!;
    const info = versionMap.get(name)!;
    return `${shortName(pkg)}@${info.version}`;
  });

  try {
    git(['add', ...filesToStage], repoRoot);
    git(['commit', '-m', `chore(release): publish ${versions.join(', ')}`], repoRoot);
    console.log('  ✓ committed version bumps');
  } catch (error: any) {
    console.error(`  ✗ git commit failed: ${error.message}`);
    // Restore all backups
    for (const bp of backupPaths) restorePrepublishBackup(bp);
    process.exit(1);
  }

  // ── 11. Git tag ──
  for (const name of publishable) {
    const pkg = graph.packages.get(name)!;
    const info = versionMap.get(name)!;
    const tag = `${shortName(pkg)}@${info.version}`;
    try {
      git(['tag', '-f', tag, '-m', `Published ${pkg.name} version ${info.version}`], repoRoot);
    } catch { /* tag may already exist */ }
  }
  console.log(`  ✓ tagged ${publishable.length} packages`);

  // ── 12. npm publish ──
  console.log('\n── publish ──');
  const results: PublishResult[] = [];

  for (const name of publishable) {
    const pkg = graph.packages.get(name)!;
    const sn = shortName(pkg);
    const { version, previous } = versionMap.get(name)!;

    process.stdout.write(`  ${sn}@${version}... `);

    try {
      const publishArgs = ['publish', '--tag', 'latest'];
      if (registry) publishArgs.push('--registry', registry);

      execFileSync('npm', publishArgs, {
        cwd: pkg.dir,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: process.env,
        timeout: 120_000,
      });

      console.log('\x1b[32m✓\x1b[0m');
      results.push({ name, version, previousVersion: previous, location: pkg.dir, published: true });
    } catch (error: any) {
      const stderr = error.stderr?.toString() ?? '';

      if (stderr.includes('cannot publish over the previously published version')) {
        console.log('already published');
        results.push({ name, version, previousVersion: previous, location: pkg.dir, published: false, skipped: 'already published' });
      } else {
        console.log('\x1b[31m✗ FAILED\x1b[0m');
        console.error(`    ${stderr.slice(0, 500)}`);
        results.push({ name, version, previousVersion: previous, location: pkg.dir, published: false, skipped: 'error' });
      }
    }
  }

  // ── 13. Restore package.json from prepublish-standalone backup ──
  for (const bp of backupPaths) {
    restorePrepublishBackup(bp);
  }

  // ── 14. Git push ──
  console.log('\n── git push ──');
  try {
    git(['push', '--follow-tags'], repoRoot);
    console.log('  ✓ pushed to remote');
  } catch (error: any) {
    console.warn(`  ⚠ git push failed: ${error.message}`);
    console.warn('    Run manually: git push --follow-tags');
  }

  // ── 15. Write publish report ──
  const reportPath = writePublishReport(results, repoRoot);
  console.log(`\nPUBLISHED_PACKAGES_FILE=${reportPath}`);

  // ── 15b. Dispatch image build workflows ──
  dispatchImageWorkflows(results, config, graph, repoRoot, verbose);

  // ── 16. Summary ──
  const publishedResults = results.filter(r => r.published);
  console.log('\n── summary ──');
  console.log(`  Published: ${publishedResults.length}/${publishable.length}`);
  for (const result of results) {
    const pkg = graph.packages.get(result.name)!;
    const sn = shortName(pkg);
    const status = result.published
      ? `\x1b[32m✓\x1b[0m`
      : `\x1b[31m✗\x1b[0m (${result.skipped})`;
    const bump = result.version !== result.previousVersion
      ? ` (${result.previousVersion} → ${result.version})`
      : '';
    console.log(`  ${status} ${sn}@${result.version}${bump}`);
  }

  if (publishedResults.length === 0) {
    process.exit(1);
  }
}
