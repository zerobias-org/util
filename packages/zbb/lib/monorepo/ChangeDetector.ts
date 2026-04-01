/**
 * Git-based change detection for monorepo workspaces.
 * Determines which packages changed and expands to affected set (including transitive dependents).
 */

import { execFileSync } from 'node:child_process';
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

const ROOT_TRIGGER_FILES = new Set([
  'package.json',
  'package-lock.json',
  'tsconfig.json',
  '.zbb.yaml',
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
 * Get the list of files changed between baseRef and HEAD.
 */
function getChangedFiles(repoRoot: string, baseRef: string): string[] {
  try {
    const output = git(['diff', '--name-only', `${baseRef}...HEAD`], repoRoot);
    if (!output) return [];
    return output.split('\n').filter(Boolean);
  } catch {
    // Three-dot diff may fail if baseRef isn't reachable; fall back to two-dot
    try {
      const output = git(['diff', '--name-only', baseRef, 'HEAD'], repoRoot);
      if (!output) return [];
      return output.split('\n').filter(Boolean);
    } catch {
      return [];
    }
  }
}

/**
 * Map changed files to workspace packages.
 */
function mapFilesToPackages(
  changedFiles: string[],
  graph: DependencyGraph,
): { changed: Set<string>; allAffected: boolean } {
  const changed = new Set<string>();
  let allAffected = false;

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

    // Check if it's a root-level trigger file
    if (!file.includes('/') && ROOT_TRIGGER_FILES.has(file)) {
      allAffected = true;
      continue;
    }

    // Map to a workspace package
    for (const dir of sortedDirs) {
      if (file.startsWith(dir + '/') || file === dir) {
        changed.add(dirToName.get(dir)!);
        break;
      }
    }
  }

  return { changed, allAffected };
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

  const { changed, allAffected } = mapFilesToPackages(changedFiles, graph);

  if (allAffected) {
    const allNames = new Set(graph.packages.keys());
    return {
      changed: allNames,
      affected: allNames,
      affectedOrdered: graph.buildOrder,
      baseRef,
    };
  }

  // Expand changed to include transitive dependents
  const affected = new Set(changed);
  for (const name of changed) {
    const transitive = getTransitiveDependents(name, graph);
    for (const dep of transitive) {
      affected.add(dep);
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
