/**
 * Workspace discovery, dependency graph, and topological sort for npm workspaces monorepos.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join, resolve, relative } from 'node:path';
import { globSync } from 'node:fs';
// ── Discovery ────────────────────────────────────────────────────────
/**
 * Discover all workspace packages from the root package.json.
 */
export function discoverWorkspaces(repoRoot) {
    const rootPkgPath = join(repoRoot, 'package.json');
    if (!existsSync(rootPkgPath)) {
        throw new Error(`No package.json found at ${repoRoot}`);
    }
    const rootPkg = JSON.parse(readFileSync(rootPkgPath, 'utf-8'));
    const workspaceGlobs = rootPkg.workspaces ?? [];
    if (workspaceGlobs.length === 0) {
        throw new Error('No workspaces defined in root package.json');
    }
    // Resolve workspace globs to directories
    const packageDirs = [];
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
        }
        else {
            // Plain directory name like "core" or "server"
            const absDir = resolve(repoRoot, glob);
            if (existsSync(join(absDir, 'package.json'))) {
                packageDirs.push(absDir);
            }
        }
    }
    // Read each workspace package.json
    const packages = new Map();
    const nameSet = new Set();
    // First pass: collect all package names
    const pkgInfos = [];
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
        const internalDeps = [];
        for (const depName of Object.keys(allDeps)) {
            if (nameSet.has(depName)) {
                internalDeps.push(depName);
            }
        }
        const wp = {
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
export function buildDependencyGraph(packages) {
    // Build reverse adjacency list (dependents)
    const dependents = new Map();
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
function topologicalSort(packages, dependents) {
    // Compute in-degree (number of internal deps each package has)
    const inDegree = new Map();
    for (const [name, pkg] of packages) {
        // Only count deps that are actually in the workspace
        const count = pkg.internalDeps.filter(d => packages.has(d)).length;
        inDegree.set(name, count);
    }
    // Start with packages that have no internal deps
    const queue = [];
    for (const [name, degree] of inDegree) {
        if (degree === 0)
            queue.push(name);
    }
    const sorted = [];
    while (queue.length > 0) {
        const current = queue.shift();
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
        throw new Error(`Circular dependency detected among workspace packages: ${remaining.join(', ')}`);
    }
    return sorted;
}
/**
 * Get all transitive dependents of a package (BFS through reverse adjacency).
 * Does NOT include the starting package itself.
 */
export function getTransitiveDependents(packageName, graph) {
    const visited = new Set();
    const queue = [packageName];
    while (queue.length > 0) {
        const current = queue.shift();
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
export function sortByBuildOrder(names, graph) {
    return graph.buildOrder.filter(n => names.has(n));
}
