/**
 * Gate stamp logic for monorepos — ported from zb.base.gradle.kts.
 *
 * A single gate-stamp.json at the repo root tracks per-package source hashes,
 * task results, and test counts. Used to skip redundant CI builds when developers
 * have already run `zbb gate` locally.
 */

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { MonorepoConfig } from '../config.js';
import type { WorkspacePackage, DependencyGraph } from './Workspace.js';

// ── Types ────────────────────────────────────────────────────────────

export enum GateStampResult {
  /** sourceHash + tasks + test counts all match — skip all gate tasks */
  VALID = 'VALID',
  /** source OK but test file content changed — re-run tests only */
  TESTS_CHANGED = 'TESTS_CHANGED',
  /** source OK but tests failed last run — re-run tests only */
  TESTS_FAILED = 'TESTS_FAILED',
  /** hash mismatch or build task failure — full gate needed */
  INVALID = 'INVALID',
  /** no entry for this package */
  MISSING = 'MISSING',
}

export interface TestSuiteEntry {
  expected: number;
  ran: number;
  status: 'passed' | 'failed' | 'skipped' | 'not-run';
}

export interface PackageStampEntry {
  version: string;
  sourceHash: string;
  testHash: string;
  /** Resolved root deps + overrides used by this package, snapshot at gate write time */
  rootDeps?: Record<string, string>;
  tasks: Record<string, 'passed' | 'failed' | 'skipped' | 'not-found'>;
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
/**
 * Resolve which root package.json deps + overrides this package uses.
 * Runs prepublish-standalone --dry-run, parses the output, and returns the dep map.
 * Called once at gate write time (when build artifacts exist) — never at validation.
 */
export function resolveRootDeps(pkg: WorkspacePackage, repoRoot: string): Record<string, string> {
  const rootPkgPath = join(repoRoot, 'package.json');
  if (!existsSync(rootPkgPath)) return {};

  const rootPkg = JSON.parse(readFileSync(rootPkgPath, 'utf-8'));
  const allRootDeps: Record<string, string> = {
    ...(rootPkg.dependencies ?? {}),
    ...(rootPkg.devDependencies ?? {}),
  };
  const rootOverrides: Record<string, unknown> = rootPkg.overrides ?? {};

  const prepubScript = join(repoRoot, 'node_modules/@zerobias-org/devops-tools/scripts/prepublish-standalone.js');
  if (!existsSync(prepubScript)) return {};

  const resolved: Record<string, string> = {};

  try {
    const output = execFileSync('node', [prepubScript, pkg.dir, repoRoot, '--dry-run'], {
      encoding: 'utf-8',
      timeout: 30_000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    // Parse resolved deps
    const depsMatch = output.match(/Dependencies that would be included:\n([\s\S]*?)(?:\n\n|\nOverrides|$)/);
    if (depsMatch) {
      for (const line of depsMatch[1].split('\n')) {
        const m = line.match(/^\s+(\S+):\s+(\S+)/);
        if (m && allRootDeps[m[1]]) resolved[m[1]] = allRootDeps[m[1]];
      }
    }
    // Parse resolved overrides
    const overridesMatch = output.match(/Overrides that would be included:\n([\s\S]*?)(?:\n\n|$)/);
    if (overridesMatch) {
      for (const line of overridesMatch[1].split('\n')) {
        const m = line.match(/^\s+(\S+):/);
        if (m && rootOverrides[m[1]] !== undefined) {
          resolved[m[1]] = JSON.stringify(rootOverrides[m[1]]);
        }
      }
    }
  } catch { /* prepublish failed — return empty */ }

  return resolved;
}

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

  // Hash source directories — only git-tracked files to ensure consistency across environments
  for (const dirName of sourceDirs) {
    const dir = join(pkg.dir, dirName);
    if (!existsSync(dir)) continue;

    let files: string[];
    try {
      // Use git ls-files for deterministic results (ignores .gitignored files)
      const output = execFileSync('git', ['ls-files', dirName], {
        cwd: pkg.dir,
        encoding: 'utf-8',
      }).trim();
      files = output ? output.split('\n').sort().map(f => join(pkg.dir, f)) : [];
    } catch {
      // Fallback to walkDir if not in a git repo
      files = walkDir(dir).sort((a, b) => {
        const relA = relative(pkg.dir, a);
        const relB = relative(pkg.dir, b);
        return relA.localeCompare(relB);
      });
    }

    for (const filePath of files) {
      // Skip files listed in git but not present on disk (sparse checkout, deleted, etc.)
      if (!existsSync(filePath)) continue;
      const relPath = relative(pkg.dir, filePath);
      digest.update(relPath);
      digest.update(readFileSync(filePath));
    }
  }

  return digest.digest('hex');
}

/**
 * Compute SHA-256 hash of a package's test directories.
 * Detects any change to test file content, not just added/removed test cases.
 */
export function computeTestHash(pkg: WorkspacePackage): string {
  const digest = createHash('sha256');
  const testDirs = ['test'];

  for (const dirName of testDirs) {
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
  repoRoot?: string,
): GateStampResult {
  if (!stamp) return GateStampResult.MISSING;

  const entry = stamp.packages[pkg.name];
  if (!entry) return GateStampResult.MISSING;

  const shortName = pkg.name.replace(/^@[^/]+\//, '');

  // 1. Verify sourceHash — source code hasn't changed
  const currentHash = computeSourceHash(pkg, config);
  if (entry.sourceHash !== currentHash) {
    console.log(`  [stamp] ${shortName}: sourceHash mismatch`);
    console.log(`    stamp:   ${entry.sourceHash}`);
    console.log(`    current: ${currentHash}`);
    return GateStampResult.INVALID;
  }

  // 1b. Verify rootDeps — any change to a root dep this package uses invalidates the stamp
  if (entry.rootDeps && repoRoot) {
    const rootPkgPath = join(repoRoot, 'package.json');
    if (existsSync(rootPkgPath)) {
      const rootPkg = JSON.parse(readFileSync(rootPkgPath, 'utf-8'));
      const currentRootDeps: Record<string, string> = {
        ...(rootPkg.dependencies ?? {}),
        ...(rootPkg.devDependencies ?? {}),
      };
      const currentOverrides: Record<string, unknown> = rootPkg.overrides ?? {};
      for (const [depName, stampVersion] of Object.entries(entry.rootDeps)) {
        // Could be a regular dep or an override (overrides are stored as JSON.stringify'd)
        const currentDep = currentRootDeps[depName];
        const currentOverride = currentOverrides[depName] !== undefined
          ? JSON.stringify(currentOverrides[depName])
          : undefined;
        if (currentDep !== stampVersion && currentOverride !== stampVersion) {
          console.log(`  [stamp] ${shortName}: rootDep '${depName}' changed`);
          console.log(`    stamp:   ${stampVersion}`);
          console.log(`    current: ${currentDep ?? currentOverride ?? '(removed)'}`);
          return GateStampResult.INVALID;
        }
      }
    }
  }

  // 2. Verify build tasks passed (separate test task failures from build failures)
  const testPhaseSet = new Set(config.testPhases ?? ['test']);
  let buildFailed = false;
  let testTaskFailed = false;
  for (const [task, status] of Object.entries(entry.tasks)) {
    if (status !== 'passed' && status !== 'skipped' && status !== 'not-found') {
      if (testPhaseSet.has(task)) {
        testTaskFailed = true;
      } else {
        buildFailed = true;
      }
    }
  }
  if (buildFailed) return GateStampResult.INVALID;

  // 3. Verify test hash — any change to test file content triggers re-test
  const currentTestHash = computeTestHash(pkg);
  if (!entry.testHash || entry.testHash !== currentTestHash) {
    return GateStampResult.TESTS_CHANGED;
  }

  // 4. If test task or test suites show failures, re-run tests only
  if (testTaskFailed) return GateStampResult.TESTS_FAILED;
  for (const [, entry_] of Object.entries(entry.tests)) {
    if (entry_.expected > 0 && entry_.status !== 'passed' && entry_.status !== 'skipped') {
      return GateStampResult.TESTS_FAILED;
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
    results.set(name, validatePackageStamp(pkg, stamp, config, repoRoot));
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
  taskResults: Record<string, 'passed' | 'failed' | 'skipped' | 'not-found'>,
  testResults: Record<string, TestSuiteEntry>,
  repoRoot?: string,
): PackageStampEntry {
  const entry: PackageStampEntry = {
    version: pkg.version,
    sourceHash: computeSourceHash(pkg, config),
    testHash: computeTestHash(pkg),
    tasks: taskResults,
    tests: testResults,
  };
  // Resolve which root deps this package uses (only at write time, when build artifacts exist)
  if (repoRoot) {
    const rootDeps = resolveRootDeps(pkg, repoRoot);
    if (Object.keys(rootDeps).length > 0) {
      entry.rootDeps = rootDeps;
    }
  }
  return entry;
}
