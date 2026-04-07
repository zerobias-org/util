/**
 * Workspace discovery, dependency graph, and topological sort for npm workspaces monorepos.
 */

import { readFileSync, existsSync } from 'node:fs';
import { join, resolve, relative } from 'node:path';
import { globSync } from 'node:fs';

// ── Types ────────────────────────────────────────────────────────────

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

// ── Discovery ────────────────────────────────────────────────────────

/**
 * Discover all workspace packages from the root package.json.
 */
export function discoverWorkspaces(repoRoot: string): Map<string, WorkspacePackage> {
  const rootPkgPath = join(repoRoot, 'package.json');
  if (!existsSync(rootPkgPath)) {
    throw new Error(`No package.json found at ${repoRoot}`);
  }

  const rootPkg = JSON.parse(readFileSync(rootPkgPath, 'utf-8'));
  const workspaceGlobs: string[] = rootPkg.workspaces ?? [];
  if (workspaceGlobs.length === 0) {
    throw new Error('No workspaces defined in root package.json');
  }

  // Resolve workspace globs to directories
  const packageDirs: string[] = [];
  for (const glob of workspaceGlobs) {
    if (glob.includes('*')) {
      // Expand glob patterns like "packages/*"
      const expanded = globSync(glob, { cwd: repoRoot });
      for (const entry of expanded) {
        const absDir = resolve(repoRoot, entry);
        if (existsSync(join(absDir, 'package.json'))) {
          packageDirs.push(absDir);
        }
      }
    } else {
      // Plain directory name like "core" or "server"
      const absDir = resolve(repoRoot, glob);
      if (existsSync(join(absDir, 'package.json'))) {
        packageDirs.push(absDir);
      }
    }
  }

  // Read each workspace package.json
  const packages = new Map<string, WorkspacePackage>();
  const nameSet = new Set<string>();

  // First pass: collect all package names
  const pkgInfos: { dir: string; pkg: Record<string, any> }[] = [];
  for (const dir of packageDirs) {
    const pkgPath = join(dir, 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
    pkgInfos.push({ dir, pkg });
    nameSet.add(pkg.name);
  }

  // Second pass: resolve internal deps
  for (const { dir, pkg } of pkgInfos) {
    const allDeps = {
      ...pkg.dependencies,
      ...pkg.devDependencies,
    };

    const internalDeps: string[] = [];
    for (const depName of Object.keys(allDeps)) {
      if (nameSet.has(depName)) {
        internalDeps.push(depName);
      }
    }

    const wp: WorkspacePackage = {
      name: pkg.name,
      dir,
      relDir: relative(repoRoot, dir),
      version: pkg.version ?? '0.0.0',
      private: pkg.private ?? false,
      scripts: pkg.scripts ?? {},
      internalDeps,
      packageJson: pkg,
    };

    packages.set(pkg.name, wp);
  }

  return packages;
}

// ── Dependency Graph ─────────────────────────────────────────────────

/**
 * Build the dependency graph from discovered workspace packages.
 */
export function buildDependencyGraph(packages: Map<string, WorkspacePackage>): DependencyGraph {
  // Build reverse adjacency list (dependents)
  const dependents = new Map<string, Set<string>>();
  for (const [name] of packages) {
    dependents.set(name, new Set());
  }

  for (const [name, pkg] of packages) {
    for (const dep of pkg.internalDeps) {
      dependents.get(dep)?.add(name);
    }
  }

  // Topological sort using Kahn's algorithm
  const buildOrder = topologicalSort(packages, dependents);

  return { packages, dependents, buildOrder };
}

/**
 * Kahn's algorithm: BFS topological sort. Returns packages in dependency order
 * (leaves first, so they can be built before their dependents).
 */
function topologicalSort(
  packages: Map<string, WorkspacePackage>,
  dependents: Map<string, Set<string>>,
): string[] {
  // Compute in-degree (number of internal deps each package has)
  const inDegree = new Map<string, number>();
  for (const [name, pkg] of packages) {
    // Only count deps that are actually in the workspace
    const count = pkg.internalDeps.filter(d => packages.has(d)).length;
    inDegree.set(name, count);
  }

  // Start with packages that have no internal deps
  const queue: string[] = [];
  for (const [name, degree] of inDegree) {
    if (degree === 0) queue.push(name);
  }

  const sorted: string[] = [];

  while (queue.length > 0) {
    const current = queue.shift()!;
    sorted.push(current);

    // Reduce in-degree for all dependents of current
    const deps = dependents.get(current) ?? new Set();
    for (const dependent of deps) {
      const newDegree = (inDegree.get(dependent) ?? 0) - 1;
      inDegree.set(dependent, newDegree);
      if (newDegree === 0) {
        queue.push(dependent);
      }
    }
  }

  // Detect cycles
  if (sorted.length !== packages.size) {
    const remaining = [...packages.keys()].filter(n => !sorted.includes(n));
    throw new Error(
      `Circular dependency detected among workspace packages: ${remaining.join(', ')}`
    );
  }

  return sorted;
}

/**
 * Get all transitive dependents of a package (BFS through reverse adjacency).
 * Does NOT include the starting package itself.
 */
export function getTransitiveDependents(
  packageName: string,
  graph: DependencyGraph,
): Set<string> {
  const visited = new Set<string>();
  const queue = [packageName];

  while (queue.length > 0) {
    const current = queue.shift()!;
    const deps = graph.dependents.get(current) ?? new Set();
    for (const dep of deps) {
      if (!visited.has(dep)) {
        visited.add(dep);
        queue.push(dep);
      }
    }
  }

  return visited;
}

/**
 * Filter and sort a set of package names by the graph's build order.
 */
export function sortByBuildOrder(names: Set<string>, graph: DependencyGraph): string[] {
  return graph.buildOrder.filter(n => names.has(n));
}
