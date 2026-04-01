/**
 * Gate stamp logic for monorepos — ported from zb.base.gradle.kts.
 *
 * A single gate-stamp.json at the repo root tracks per-package source hashes,
 * task results, and test counts. Used to skip redundant CI builds when developers
 * have already run `zbb gate` locally.
 */

import { createHash } from 'node:crypto';
import { readFileSync, existsSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { MonorepoConfig } from '../config.js';
import type { WorkspacePackage, DependencyGraph } from './Workspace.js';

// ── Types ────────────────────────────────────────────────────────────

export enum GateStampResult {
  /** sourceHash + tasks + test counts all match — skip all gate tasks */
  VALID = 'VALID',
  /** source OK but test count mismatch — need to re-run tests */
  TESTS_CHANGED = 'TESTS_CHANGED',
  /** hash mismatch or task failure — full gate needed */
  INVALID = 'INVALID',
  /** no entry for this package */
  MISSING = 'MISSING',
}

export interface TestSuiteEntry {
  expected: number;
  ran: number;
  status: 'passed' | 'skipped' | 'not-run';
}

export interface PackageStampEntry {
  version: string;
  sourceHash: string;
  tasks: Record<string, 'passed' | 'skipped' | 'not-found'>;
  tests: Record<string, TestSuiteEntry>;
}

export interface GateStamp {
  version: number;
  branch: string;
  timestamp: string;
  packages: Record<string, PackageStampEntry>;
}

// ── Hashing (ported from zb.base.gradle.kts hashFiles) ──────────────

/**
 * Walk a directory recursively and return all files sorted by relative path.
 */
function walkDir(dir: string): string[] {
  const results: string[] = [];
  if (!existsSync(dir)) return results;

  const entries = readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      // Skip node_modules and hidden dirs
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      results.push(...walkDir(fullPath));
    } else if (entry.isFile()) {
      results.push(fullPath);
    }
  }

  return results;
}

/**
 * Compute SHA-256 hash of a package's source files and directories.
 * Mirrors the Gradle `hashFiles()` function.
 */
export function computeSourceHash(pkg: WorkspacePackage, config: MonorepoConfig): string {
  const digest = createHash('sha256');
  const sourceFiles = config.sourceFiles ?? ['tsconfig.json'];
  const sourceDirs = config.sourceDirs ?? ['src'];

  // Hash individual source files
  for (const name of sourceFiles) {
    const filePath = join(pkg.dir, name);
    if (existsSync(filePath)) {
      digest.update(name);
      digest.update(readFileSync(filePath));
    }
  }

  // Hash source directories
  for (const dirName of sourceDirs) {
    const dir = join(pkg.dir, dirName);
    if (!existsSync(dir)) continue;

    const files = walkDir(dir).sort((a, b) => {
      const relA = relative(pkg.dir, a);
      const relB = relative(pkg.dir, b);
      return relA.localeCompare(relB);
    });

    for (const filePath of files) {
      const relPath = relative(pkg.dir, filePath);
      digest.update(relPath);
      digest.update(readFileSync(filePath));
    }
  }

  return digest.digest('hex');
}

// ── Test Counting (ported from zb.base.gradle.kts countExpectedTests) ─

const TEST_PATTERN = /(?:^|\s)(?:it|it\.only|test)\s*\(/;

/**
 * Count expected test cases by scanning for it( / it.only( / test( in test files.
 */
export function countExpectedTests(testDir: string): number {
  if (!existsSync(testDir)) return 0;

  const files = walkDir(testDir);
  let count = 0;

  for (const file of files) {
    if (!file.endsWith('.ts') && !file.endsWith('.js')) continue;
    const content = readFileSync(file, 'utf-8');
    for (const line of content.split('\n')) {
      if (TEST_PATTERN.test(line)) {
        count += 1;
      };
    }
  }

  return count;
}

/**
 * Get test suite directories for a workspace package.
 */
function getTestSuites(pkg: WorkspacePackage): Record<string, string> {
  return {
    unit: join(pkg.dir, 'test', 'unit'),
    integration: join(pkg.dir, 'test', 'integration'),
    e2e: join(pkg.dir, 'test', 'e2e'),
  };
}

// ── Stamp Read/Write ─────────────────────────────────────────────────

const STAMP_FILE = 'gate-stamp.json';

export function readGateStamp(repoRoot: string): GateStamp | null {
  const stampPath = join(repoRoot, STAMP_FILE);
  if (!existsSync(stampPath)) return null;

  try {
    return JSON.parse(readFileSync(stampPath, 'utf-8'));
  } catch {
    return null;
  }
}

export function writeGateStamp(repoRoot: string, stamp: GateStamp): void {
  const stampPath = join(repoRoot, STAMP_FILE);
  writeFileSync(stampPath, JSON.stringify(stamp, null, 2) + '\n');
}

// ── Stamp Validation ─────────────────────────────────────────────────

/**
 * Validate the gate stamp entry for a single package.
 * Returns one of 4 states (ported from Gradle checkGateStamp).
 */
export function validatePackageStamp(
  pkg: WorkspacePackage,
  stamp: GateStamp | null,
  config: MonorepoConfig,
): GateStampResult {
  if (!stamp) return GateStampResult.MISSING;

  const entry = stamp.packages[pkg.name];
  if (!entry) return GateStampResult.MISSING;

  // 1. Verify sourceHash — source code hasn't changed
  const currentHash = computeSourceHash(pkg, config);
  if (entry.sourceHash !== currentHash) {
    return GateStampResult.INVALID;
  }

  // 2. Verify all tasks passed, were skipped, or not-found (package doesn't have that script)
  for (const [, status] of Object.entries(entry.tasks)) {
    if (status !== 'passed' && status !== 'skipped' && status !== 'not-found') {
      return GateStampResult.INVALID;
    }
  }

  // 3. Verify test counts
  const testSuites = getTestSuites(pkg);
  for (const [suite, dir] of Object.entries(testSuites)) {
    const currentExpected = countExpectedTests(dir);
    if (currentExpected === 0) continue;

    const stampEntry = entry.tests[suite];
    if (!stampEntry) return GateStampResult.TESTS_CHANGED;

    // Skipped tests are valid — the package intentionally disables them
    if (stampEntry.status === 'skipped') continue;

    if (stampEntry.status !== 'passed') {
      return GateStampResult.TESTS_CHANGED;
    }
    if (currentExpected !== stampEntry.expected) {
      return GateStampResult.TESTS_CHANGED;
    }
    if (stampEntry.ran !== stampEntry.expected) {
      return GateStampResult.TESTS_CHANGED;
    }
  }

  return GateStampResult.VALID;
}

/**
 * Validate the gate stamp for all affected packages.
 * Returns a map of package name → validation result.
 */
export function validateStamp(
  affectedPackages: string[],
  graph: DependencyGraph,
  repoRoot: string,
  config: MonorepoConfig,
): Map<string, GateStampResult> {
  const stamp = readGateStamp(repoRoot);
  const results = new Map<string, GateStampResult>();

  for (const name of affectedPackages) {
    const pkg = graph.packages.get(name);
    if (!pkg) continue;
    results.set(name, validatePackageStamp(pkg, stamp, config));
  }

  return results;
}

/**
 * Check if all affected packages have valid stamps (for --check mode).
 */
export function isStampValid(
  affectedPackages: string[],
  graph: DependencyGraph,
  repoRoot: string,
  config: MonorepoConfig,
): boolean {
  const results = validateStamp(affectedPackages, graph, repoRoot, config);
  return [...results.values()].every(r => r === GateStampResult.VALID);
}

/**
 * Build a stamp entry for a package after successful gate execution.
 */
export function buildPackageStampEntry(
  pkg: WorkspacePackage,
  config: MonorepoConfig,
  taskResults: Record<string, 'passed' | 'skipped' | 'not-found'>,
  testResults: Record<string, TestSuiteEntry>,
): PackageStampEntry {
  return {
    version: pkg.version,
    sourceHash: computeSourceHash(pkg, config),
    tasks: taskResults,
    tests: testResults,
  };
}
