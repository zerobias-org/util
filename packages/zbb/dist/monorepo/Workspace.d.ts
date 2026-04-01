/**
 * Workspace discovery, dependency graph, and topological sort for npm workspaces monorepos.
 */
export interface WorkspacePackage {
    /** npm package name, e.g. "@zerobias-com/hub-core" */
    name: string;
    /** Absolute path to the package directory */
    dir: string;
    /** Relative path from repo root, e.g. "core" */
    relDir: string;
    /** Version from package.json */
    version: string;
    /** Whether the package is private */
    private: boolean;
    /** npm scripts from package.json */
    scripts: Record<string, string>;
    /** Names of workspace packages this depends on */
    internalDeps: string[];
    /** Raw package.json content */
    packageJson: Record<string, any>;
}
export interface DependencyGraph {
    /** All workspace packages, keyed by npm name */
    packages: Map<string, WorkspacePackage>;
    /** Reverse adjacency: package name → set of package names that depend on it */
    dependents: Map<string, Set<string>>;
    /** Topological sort order (leaves/dependencies first, dependents last) */
    buildOrder: string[];
}
/**
 * Discover all workspace packages from the root package.json.
 */
export declare function discoverWorkspaces(repoRoot: string): Map<string, WorkspacePackage>;
/**
 * Build the dependency graph from discovered workspace packages.
 */
export declare function buildDependencyGraph(packages: Map<string, WorkspacePackage>): DependencyGraph;
/**
 * Get all transitive dependents of a package (BFS through reverse adjacency).
 * Does NOT include the starting package itself.
 */
export declare function getTransitiveDependents(packageName: string, graph: DependencyGraph): Set<string>;
/**
 * Filter and sort a set of package names by the graph's build order.
 */
export declare function sortByBuildOrder(names: Set<string>, graph: DependencyGraph): string[];
