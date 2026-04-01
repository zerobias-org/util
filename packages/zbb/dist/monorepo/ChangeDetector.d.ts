/**
 * Git-based change detection for monorepo workspaces.
 * Determines which packages changed and expands to affected set (including transitive dependents).
 */
import type { DependencyGraph } from './Workspace.js';
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
/**
 * Detect which packages have changed and compute the full affected set.
 */
export declare function detectChanges(repoRoot: string, graph: DependencyGraph, options?: {
    all?: boolean;
    base?: string;
}): ChangeDetectionResult;
/**
 * Get the current git branch name.
 */
export declare function getCurrentBranch(repoRoot: string): string;
