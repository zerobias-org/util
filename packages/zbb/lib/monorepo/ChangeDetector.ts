/**
 * Git-based change detection for monorepo workspaces.
 * Determines which packages changed and expands to affected set (including transitive dependents).
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DependencyGraph, WorkspacePackage } from './Workspace.js';
import { getTransitiveDependents, sortByBuildOrder } from './Workspace.js';

// ── Types ────────────────────────────────────────────────────────────

export interface ChangeDetectionResult {
  /** Packages with direct source changes */
  changed: Set<string>;
  /** changed + transitive dependents (full set that needs rebuild/republish) */
  affected: Set<string>;
  /** Affected packages sorted in topological build order */
  affectedOrdered: string[];
  /** The git ref used as the comparison base */
  baseRef: string;
}

// ── Root-level files that trigger full rebuild ────────────────────────

/** Root files that always invalidate all packages */
const ROOT_TRIGGER_ALL = new Set([
  'tsconfig.json',
  '.zbb.yaml',
]);

/** Root files that need targeted analysis */
const ROOT_TRIGGER_TARGETED = new Set([
  'package.json',
  'package-lock.json',
]);

// ── Implementation ───────────────────────────────────────────────────

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim();
}

/**
 * Determine the base ref for change detection.
 */
function resolveBaseRef(repoRoot: string, overrideBase?: string): string {
  if (overrideBase) return overrideBase;

  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD'], repoRoot);

  if (branch === 'main' || branch === 'master') {
    // On main: diff against the last commit that touched gate-stamp.json
    try {
      const lastStampCommit = git(
        ['log', '-1', '--format=%H', '--', 'gate-stamp.json'],
        repoRoot,
      );
      if (lastStampCommit) return lastStampCommit;
    } catch { /* no stamp commit found */ }

    // Fallback: diff against previous commit
    return 'HEAD~1';
  }

  // On feature branches: diff against origin/main
  return 'origin/main';
}

/**
 * Get the list of files changed between baseRef and HEAD, including uncommitted changes.
 */
function getChangedFiles(repoRoot: string, baseRef: string): string[] {
  const files = new Set<string>();

  // Committed changes: baseRef..HEAD
  try {
    const output = git(['diff', '--name-only', `${baseRef}...HEAD`], repoRoot);
    if (output) for (const f of output.split('\n').filter(Boolean)) files.add(f);
  } catch {
    try {
      const output = git(['diff', '--name-only', baseRef, 'HEAD'], repoRoot);
      if (output) for (const f of output.split('\n').filter(Boolean)) files.add(f);
    } catch { /* ignore */ }
  }

  // Uncommitted changes: staged + unstaged working tree
  try {
    const output = git(['diff', '--name-only', 'HEAD'], repoRoot);
    if (output) for (const f of output.split('\n').filter(Boolean)) files.add(f);
  } catch { /* ignore */ }
  try {
    const output = git(['diff', '--name-only', '--cached'], repoRoot);
    if (output) for (const f of output.split('\n').filter(Boolean)) files.add(f);
  } catch { /* ignore */ }

  return [...files];
}

/**
 * Map changed files to workspace packages.
 */
function mapFilesToPackages(
  changedFiles: string[],
  graph: DependencyGraph,
): { changed: Set<string>; allAffected: boolean; rootPkgChanged: boolean } {
  const changed = new Set<string>();
  let allAffected = false;
  let rootPkgChanged = false;

  // Build a lookup: relDir → package name
  const dirToName = new Map<string, string>();
  for (const [name, pkg] of graph.packages) {
    dirToName.set(pkg.relDir, name);
  }

  // Sort dirs by length descending so nested packages match before parents
  const sortedDirs = [...dirToName.keys()].sort((a, b) => b.length - a.length);

  for (const file of changedFiles) {
    // Skip gate-stamp.json itself
    if (file === 'gate-stamp.json') continue;

    // Check root-level trigger files
    if (!file.includes('/')) {
      if (ROOT_TRIGGER_ALL.has(file)) {
        allAffected = true;
        continue;
      }
      if (ROOT_TRIGGER_TARGETED.has(file)) {
        rootPkgChanged = true;
        continue;
      }
    }

    // Map to a workspace package
    for (const dir of sortedDirs) {
      if (file.startsWith(dir + '/') || file === dir) {
        changed.add(dirToName.get(dir)!);
        break;
      }
    }
  }

  return { changed, allAffected, rootPkgChanged };
}

// ── Root package.json targeted analysis ─────────────────────────────

/**
 * Get the root package.json dependencies + overrides at a specific git ref.
 */
function getRootDepsAt(repoRoot: string, ref: string): { deps: Record<string, string>; overrides: Record<string, unknown> } {
  try {
    const content = git(['show', `${ref}:package.json`], repoRoot);
    const pkg = JSON.parse(content);
    return {
      deps: { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) },
      overrides: pkg.overrides ?? {},
    };
  } catch {
    return { deps: {}, overrides: {} };
  }
}

/**
 * Find which root dependencies/overrides changed between baseRef and HEAD.
 */
function getChangedRootDeps(repoRoot: string, baseRef: string): Set<string> {
  const old = getRootDepsAt(repoRoot, baseRef);
  const current = getRootDepsAt(repoRoot, 'HEAD');
  const changed = new Set<string>();

  // Check deps: added, removed, or version changed
  const allDepKeys = new Set([...Object.keys(old.deps), ...Object.keys(current.deps)]);
  for (const key of allDepKeys) {
    if (old.deps[key] !== current.deps[key]) {
      changed.add(key);
    }
  }

  // Check overrides: added, removed, or value changed
  const allOverrideKeys = new Set([...Object.keys(old.overrides), ...Object.keys(current.overrides)]);
  for (const key of allOverrideKeys) {
    if (JSON.stringify(old.overrides[key]) !== JSON.stringify(current.overrides[key])) {
      changed.add(key);
    }
  }

  return changed;
}

/**
 * Run prepublish-standalone --dry-run for a package and return its resolved root deps.
 */
function getResolvedRootDeps(pkg: WorkspacePackage, repoRoot: string): Set<string> {
  const prepubScript = join(repoRoot, 'node_modules/@zerobias-org/devops-tools/scripts/prepublish-standalone.js');
  if (!existsSync(prepubScript)) return new Set();

  try {
    const output = execFileSync('node', [prepubScript, pkg.dir, repoRoot, '--dry-run'], {
      encoding: 'utf-8',
      timeout: 30_000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    // Parse "Dependencies that would be included:" section
    const resolved = new Set<string>();
    const depsMatch = output.match(/Dependencies that would be included:\n([\s\S]*?)(?:\n\n|\nOverrides|$)/);
    if (depsMatch) {
      for (const line of depsMatch[1].split('\n')) {
        const match = line.match(/^\s+(\S+):/);
        if (match) resolved.add(match[1]);
      }
    }
    // Also parse overrides
    const overridesMatch = output.match(/Overrides that would be included:\n([\s\S]*?)(?:\n\n|$)/);
    if (overridesMatch) {
      for (const line of overridesMatch[1].split('\n')) {
        const match = line.match(/^\s+(\S+):/);
        if (match) resolved.add(match[1]);
      }
    }
    return resolved;
  } catch {
    return new Set();
  }
}

/**
 * Determine which packages are affected by root package.json changes.
 * Only marks packages that actually use the changed root dependencies.
 */
function findPackagesAffectedByRootDeps(
  repoRoot: string,
  baseRef: string,
  graph: DependencyGraph,
): Set<string> {
  const changedDeps = getChangedRootDeps(repoRoot, baseRef);
  if (changedDeps.size === 0) return new Set();

  console.log(`Root package.json changed — checking ${changedDeps.size} dep(s): ${[...changedDeps].join(', ')}`);

  const affected = new Set<string>();
  for (const [name, pkg] of graph.packages) {
    const resolved = getResolvedRootDeps(pkg, repoRoot);
    for (const dep of changedDeps) {
      if (resolved.has(dep)) {
        affected.add(name);
        break;
      }
    }
  }

  if (affected.size > 0) {
    const shortNames = [...affected].map(n => graph.packages.get(n)!.name.replace(/^@[^/]+\//, ''));
    console.log(`  Affected by root dep changes: ${shortNames.join(', ')}`);
  } else {
    console.log('  No packages affected by root dep changes');
  }

  return affected;
}

/**
 * Detect which packages have changed and compute the full affected set.
 */
export function detectChanges(
  repoRoot: string,
  graph: DependencyGraph,
  options?: { all?: boolean; base?: string },
): ChangeDetectionResult {
  // --all flag: everything is affected
  if (options?.all) {
    const allNames = new Set(graph.packages.keys());
    return {
      changed: allNames,
      affected: allNames,
      affectedOrdered: graph.buildOrder,
      baseRef: 'N/A (--all)',
    };
  }

  const baseRef = resolveBaseRef(repoRoot, options?.base);
  const changedFiles = getChangedFiles(repoRoot, baseRef);

  const { changed, allAffected, rootPkgChanged } = mapFilesToPackages(changedFiles, graph);

  if (allAffected) {
    const allNames = new Set(graph.packages.keys());
    return {
      changed: allNames,
      affected: allNames,
      affectedOrdered: graph.buildOrder,
      baseRef,
    };
  }

  // If root package.json changed, do targeted analysis
  if (rootPkgChanged) {
    const rootAffected = findPackagesAffectedByRootDeps(repoRoot, baseRef, graph);
    for (const name of rootAffected) {
      changed.add(name);
    }
  }

  // Expand changed to include transitive dependents
  const affected = new Set(changed);
  for (const name of changed) {
    const transitive = getTransitiveDependents(name, graph);
    for (const dep of transitive) {
      affected.add(dep);
    }
  }

  // Include packages with missing build artifacts (e.g. after clean).
  // A package without dist/ needs to be rebuilt even if git shows no source changes.
  for (const [name, pkg] of graph.packages) {
    if (affected.has(name)) continue;
    const distDir = join(pkg.dir, 'dist');
    if (!existsSync(distDir)) {
      affected.add(name);
    }
  }

  const affectedOrdered = sortByBuildOrder(affected, graph);

  return { changed, affected, affectedOrdered, baseRef };
}

/**
 * Get the current git branch name.
 */
export function getCurrentBranch(repoRoot: string): string {
  return git(['rev-parse', '--abbrev-ref', 'HEAD'], repoRoot);
}
