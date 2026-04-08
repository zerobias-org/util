package com.zerobias.buildtools.monorepo

import com.fasterxml.jackson.databind.ObjectMapper
import com.fasterxml.jackson.module.kotlin.readValue
import com.fasterxml.jackson.module.kotlin.registerKotlinModule
import java.io.File

/**
 * Workspace discovery, dependency graph, and topological sort for npm
 * workspace monorepos. Pure Kotlin — no Gradle dependency.
 *
 * Mirrors `org/util/packages/zbb/lib/monorepo/Workspace.ts`.
 *
 * Used by:
 * - `zb.monorepo-settings.gradle.kts` settings plugin (calls `discoverWorkspaces`
 *   and includes each as a Gradle subproject via `include(":path")`)
 * - `zb.monorepo-base.gradle.kts` (exposes the dep graph as a BuildService for
 *   ChangeDetector and the root aggregator tasks)
 */
data class WorkspacePackage(
    /** npm package name, e.g. "@zerobias-com/util-core" */
    val name: String,
    /** Absolute path to the package directory */
    val dir: File,
    /** Relative path from repo root, e.g. "packages/core" */
    val relDir: String,
    /** Version from package.json */
    val version: String,
    /** Whether the package is private */
    val private: Boolean,
    /** npm scripts from package.json */
    val scripts: Map<String, String>,
    /** Names of workspace packages this package depends on */
    val internalDeps: List<String>,
    /** Raw package.json content */
    val packageJson: Map<String, Any?>,
)

data class DependencyGraph(
    /** All workspace packages, keyed by npm package name */
    val packages: Map<String, WorkspacePackage>,
    /** Reverse adjacency: package name → set of names that depend on it */
    val dependents: Map<String, Set<String>>,
    /** Topological sort (leaves first, dependents last) */
    val buildOrder: List<String>,
)

object Workspace {
    private val mapper = ObjectMapper().registerKotlinModule()

    /**
     * Discover all workspace packages from the root package.json.
     *
     * Reads root `package.json`, expands the `workspaces` field (supports
     * glob patterns like `packages/&#42;` and literal paths), and parses each
     * workspace package's `package.json`.
     *
     * Throws if the root package.json is missing or has no workspaces.
     */
    fun discoverWorkspaces(repoRoot: File): Map<String, WorkspacePackage> {
        val rootPkgFile = File(repoRoot, "package.json")
        if (!rootPkgFile.exists()) {
            throw IllegalStateException("No package.json found at ${repoRoot.absolutePath}")
        }

        val rootPkg: Map<String, Any?> = mapper.readValue(rootPkgFile)
        @Suppress("UNCHECKED_CAST")
        val workspaceGlobs = (rootPkg["workspaces"] as? List<String>) ?: emptyList()
        if (workspaceGlobs.isEmpty()) {
            throw IllegalStateException("No workspaces defined in root package.json")
        }

        // Resolve workspace globs to package directories
        val packageDirs = mutableListOf<File>()
        for (glob in workspaceGlobs) {
            if (glob.contains("*")) {
                // Glob expansion: split on /*, walk
                val baseStr = glob.substringBefore("/*")
                val baseDir = File(repoRoot, baseStr)
                if (baseDir.isDirectory) {
                    baseDir.listFiles { f -> f.isDirectory && File(f, "package.json").exists() }
                        ?.forEach { packageDirs.add(it) }
                }
            } else {
                val absDir = File(repoRoot, glob)
                if (File(absDir, "package.json").exists()) {
                    packageDirs.add(absDir)
                }
            }
        }

        // First pass: read all package.json files, collect names
        data class PkgInfo(val dir: File, val pkg: Map<String, Any?>)
        val infos = packageDirs.mapNotNull { dir ->
            try {
                val pkgFile = File(dir, "package.json")
                val pkg: Map<String, Any?> = mapper.readValue(pkgFile)
                PkgInfo(dir, pkg)
            } catch (_: Exception) {
                null
            }
        }
        val nameSet = infos.mapNotNull { it.pkg["name"] as? String }.toSet()

        // Second pass: build WorkspacePackage objects with internal deps resolved
        val packages = linkedMapOf<String, WorkspacePackage>()
        for (info in infos) {
            val name = info.pkg["name"] as? String ?: continue
            @Suppress("UNCHECKED_CAST")
            val deps = (info.pkg["dependencies"] as? Map<String, Any?>) ?: emptyMap()
            @Suppress("UNCHECKED_CAST")
            val devDeps = (info.pkg["devDependencies"] as? Map<String, Any?>) ?: emptyMap()
            val allDepNames = (deps.keys + devDeps.keys).toSet()
            val internalDeps = allDepNames.filter { it in nameSet }

            @Suppress("UNCHECKED_CAST")
            val scriptsRaw = (info.pkg["scripts"] as? Map<String, Any?>) ?: emptyMap()
            val scripts = scriptsRaw.mapNotNull { (k, v) ->
                if (v is String) k to v else null
            }.toMap()

            packages[name] = WorkspacePackage(
                name = name,
                dir = info.dir,
                relDir = info.dir.relativeTo(repoRoot).path,
                version = info.pkg["version"] as? String ?: "0.0.0",
                private = info.pkg["private"] as? Boolean ?: false,
                scripts = scripts,
                internalDeps = internalDeps,
                packageJson = info.pkg,
            )
        }

        return packages
    }

    /**
     * Build the dependency graph from discovered workspace packages.
     */
    fun buildDependencyGraph(packages: Map<String, WorkspacePackage>): DependencyGraph {
        // Reverse adjacency
        val dependents = mutableMapOf<String, MutableSet<String>>()
        for (name in packages.keys) dependents[name] = mutableSetOf()
        for ((name, pkg) in packages) {
            for (dep in pkg.internalDeps) {
                dependents[dep]?.add(name)
            }
        }

        // Topological sort (Kahn's algorithm: leaves first)
        val buildOrder = topologicalSort(packages, dependents)

        return DependencyGraph(
            packages = packages,
            dependents = dependents.mapValues { it.value.toSet() },
            buildOrder = buildOrder,
        )
    }

    private fun topologicalSort(
        packages: Map<String, WorkspacePackage>,
        dependents: Map<String, Set<String>>,
    ): List<String> {
        // Compute in-degree (number of internal deps each package has,
        // restricted to packages in the workspace)
        val inDegree = mutableMapOf<String, Int>()
        for ((name, pkg) in packages) {
            inDegree[name] = pkg.internalDeps.count { it in packages }
        }

        // Start with all packages with no internal deps
        val queue = ArrayDeque<String>()
        for ((name, degree) in inDegree) {
            if (degree == 0) queue.add(name)
        }

        val sorted = mutableListOf<String>()
        while (queue.isNotEmpty()) {
            val current = queue.removeFirst()
            sorted.add(current)
            for (dependent in dependents[current] ?: emptySet()) {
                val newDegree = (inDegree[dependent] ?: 0) - 1
                inDegree[dependent] = newDegree
                if (newDegree == 0) queue.add(dependent)
            }
        }

        if (sorted.size != packages.size) {
            val remaining = packages.keys - sorted.toSet()
            throw IllegalStateException(
                "Circular dependency detected among workspace packages: ${remaining.joinToString(", ")}"
            )
        }

        return sorted
    }

    /**
     * Get all transitive dependents of a package via BFS through the reverse graph.
     * Does NOT include the starting package itself.
     */
    fun getTransitiveDependents(packageName: String, graph: DependencyGraph): Set<String> {
        val visited = mutableSetOf<String>()
        val queue = ArrayDeque<String>()
        queue.add(packageName)
        while (queue.isNotEmpty()) {
            val current = queue.removeFirst()
            for (dep in graph.dependents[current] ?: emptySet()) {
                if (dep !in visited) {
                    visited.add(dep)
                    queue.add(dep)
                }
            }
        }
        return visited
    }

    /**
     * Filter and sort a set of package names by the graph's build order.
     */
    fun sortByBuildOrder(names: Set<String>, graph: DependencyGraph): List<String> {
        return graph.buildOrder.filter { it in names }
    }
}
