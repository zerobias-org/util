/**
 * Gate stamp logic for monorepos — ported from zb.base.gradle.kts.
 *
 * A single gate-stamp.json at the repo root tracks per-package source hashes,
 * task results, and test counts. Used to skip redundant CI builds when developers
 * have already run `zbb gate` locally.
 */
import type { MonorepoConfig } from '../config.js';
import type { WorkspacePackage, DependencyGraph } from './Workspace.js';
export declare enum GateStampResult {
    /** sourceHash + tasks + test counts all match — skip all gate tasks */
    VALID = "VALID",
    /** source OK but test count mismatch — need to re-run tests */
    TESTS_CHANGED = "TESTS_CHANGED",
    /** hash mismatch or task failure — full gate needed */
    INVALID = "INVALID",
    /** no entry for this package */
    MISSING = "MISSING"
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
/**
 * Compute SHA-256 hash of a package's source files and directories.
 * Mirrors the Gradle `hashFiles()` function.
 */
export declare function computeSourceHash(pkg: WorkspacePackage, config: MonorepoConfig): string;
/**
 * Count expected test cases by scanning for it( / it.only( / test( in test files.
 */
export declare function countExpectedTests(testDir: string): number;
export declare function readGateStamp(repoRoot: string): GateStamp | null;
export declare function writeGateStamp(repoRoot: string, stamp: GateStamp): void;
/**
 * Validate the gate stamp entry for a single package.
 * Returns one of 4 states (ported from Gradle checkGateStamp).
 */
export declare function validatePackageStamp(pkg: WorkspacePackage, stamp: GateStamp | null, config: MonorepoConfig): GateStampResult;
/**
 * Validate the gate stamp for all affected packages.
 * Returns a map of package name → validation result.
 */
export declare function validateStamp(affectedPackages: string[], graph: DependencyGraph, repoRoot: string, config: MonorepoConfig): Map<string, GateStampResult>;
/**
 * Check if all affected packages have valid stamps (for --check mode).
 */
export declare function isStampValid(affectedPackages: string[], graph: DependencyGraph, repoRoot: string, config: MonorepoConfig): boolean;
/**
 * Build a stamp entry for a package after successful gate execution.
 */
export declare function buildPackageStampEntry(pkg: WorkspacePackage, config: MonorepoConfig, taskResults: Record<string, 'passed' | 'skipped' | 'not-found'>, testResults: Record<string, TestSuiteEntry>): PackageStampEntry;
