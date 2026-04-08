package com.zerobias.buildtools.monorepo

import com.fasterxml.jackson.databind.ObjectMapper
import com.fasterxml.jackson.module.kotlin.readValue
import com.fasterxml.jackson.module.kotlin.registerKotlinModule
import java.io.File

/**
 * Git-based change detection for monorepo workspaces.
 *
 * Mirrors `org/util/packages/zbb/lib/monorepo/ChangeDetector.ts`.
 *
 * Determines which packages have direct source changes between a base ref
 * and HEAD (including uncommitted/staged changes), then expands the set to
 * include all transitive dependents that need rebuilding.
 *
 * Pure Kotlin — no Gradle dependency. Used by `zb.monorepo-base` to
 * compute the affected set once per build invocation, exposed via a
 * BuildService to all phase tasks.
 */

data class ChangeDetectionResult(
    /** Packages with direct source changes */
    val changed: Set<String>,
    /** changed + transitive dependents (full set that needs rebuild/republish) */
    val affected: Set<String>,
    /** Affected packages in topological build order */
    val affectedOrdered: List<String>,
    /** The git ref used as the comparison base */
    val baseRef: String,
)

object ChangeDetector {
    private val mapper = ObjectMapper().registerKotlinModule()

    /** Root files that always invalidate ALL packages */
    private val ROOT_TRIGGER_ALL = setOf("tsconfig.json", ".zbb.yaml")

    /** Root files that need targeted analysis (which packages use the changed deps?) */
    private val ROOT_TRIGGER_TARGETED = setOf("package.json", "package-lock.json")

    /**
     * Detect which packages have changed and compute the full affected set.
     *
     * @param all if true, all packages are affected (for `zbb gate`/`clean`/`--all`)
     * @param overrideBase optional base ref to diff against (otherwise auto-detected)
     */
    fun detectChanges(
        repoRoot: File,
        graph: DependencyGraph,
        all: Boolean = false,
        overrideBase: String? = null,
    ): ChangeDetectionResult {
        if (all) {
            val allNames = graph.packages.keys
            return ChangeDetectionResult(
                changed = allNames,
                affected = allNames,
                affectedOrdered = graph.buildOrder,
                baseRef = "N/A (--all)",
            )
        }

        val baseRef = resolveBaseRef(repoRoot, overrideBase)
        val changedFiles = getChangedFiles(repoRoot, baseRef)

        val mapping = mapFilesToPackages(changedFiles, graph)
        val changed = mapping.changed.toMutableSet()

        if (mapping.allAffected) {
            val allNames = graph.packages.keys
            return ChangeDetectionResult(
                changed = allNames,
                affected = allNames,
                affectedOrdered = graph.buildOrder,
                baseRef = baseRef,
            )
        }

        // Root package.json changed → targeted analysis
        if (mapping.rootPkgChanged) {
            val rootAffected = findPackagesAffectedByRootDeps(repoRoot, baseRef, graph)
            changed.addAll(rootAffected)
        }

        // Expand to transitive dependents
        val affected = mutableSetOf<String>()
        affected.addAll(changed)
        for (name in changed) {
            affected.addAll(Workspace.getTransitiveDependents(name, graph))
        }

        // Also include any package missing its dist/ directory (post-clean state)
        for ((name, pkg) in graph.packages) {
            if (name in affected) continue
            val distDir = File(pkg.dir, "dist")
            if (!distDir.exists()) {
                affected.add(name)
            }
        }

        val affectedOrdered = Workspace.sortByBuildOrder(affected, graph)

        return ChangeDetectionResult(
            changed = changed,
            affected = affected,
            affectedOrdered = affectedOrdered,
            baseRef = baseRef,
        )
    }

    /**
     * Get the current git branch name.
     */
    fun getCurrentBranch(repoRoot: File): String {
        return git(repoRoot, "rev-parse", "--abbrev-ref", "HEAD")
    }

    // ── Internal helpers ─────────────────────────────────────────────

    private fun resolveBaseRef(repoRoot: File, overrideBase: String?): String {
        if (overrideBase != null) return overrideBase

        val branch = git(repoRoot, "rev-parse", "--abbrev-ref", "HEAD")

        if (branch == "main" || branch == "master") {
            // On main: diff against the last commit that touched gate-stamp.json
            try {
                val lastStampCommit = git(
                    repoRoot,
                    "log", "-1", "--format=%H", "--", "gate-stamp.json"
                )
                if (lastStampCommit.isNotEmpty()) return lastStampCommit
            } catch (_: Exception) { /* no stamp commit found */ }
            return "HEAD~1"
        }

        return "origin/main"
    }

    private fun getChangedFiles(repoRoot: File, baseRef: String): List<String> {
        val files = mutableSetOf<String>()

        // Committed changes: baseRef..HEAD
        try {
            val out = git(repoRoot, "diff", "--name-only", "$baseRef...HEAD")
            for (f in out.lines().filter { it.isNotEmpty() }) files.add(f)
        } catch (_: Exception) {
            try {
                val out = git(repoRoot, "diff", "--name-only", baseRef, "HEAD")
                for (f in out.lines().filter { it.isNotEmpty() }) files.add(f)
            } catch (_: Exception) { /* ignore */ }
        }

        // Uncommitted changes: working tree
        try {
            val out = git(repoRoot, "diff", "--name-only", "HEAD")
            for (f in out.lines().filter { it.isNotEmpty() }) files.add(f)
        } catch (_: Exception) { /* ignore */ }

        // Staged changes
        try {
            val out = git(repoRoot, "diff", "--name-only", "--cached")
            for (f in out.lines().filter { it.isNotEmpty() }) files.add(f)
        } catch (_: Exception) { /* ignore */ }

        return files.toList()
    }

    private data class FileMapping(
        val changed: Set<String>,
        val allAffected: Boolean,
        val rootPkgChanged: Boolean,
    )

    private fun mapFilesToPackages(changedFiles: List<String>, graph: DependencyGraph): FileMapping {
        val changed = mutableSetOf<String>()
        var allAffected = false
        var rootPkgChanged = false

        // Build a lookup: relDir → package name
        val dirToName = graph.packages.entries.associate { (name, pkg) -> pkg.relDir to name }
        // Sort by length descending so nested packages match before their parents
        val sortedDirs = dirToName.keys.sortedByDescending { it.length }

        for (file in changedFiles) {
            // Skip the gate-stamp itself
            if (file == "gate-stamp.json") continue

            // Root-level files (no slash)
            if (!file.contains("/")) {
                if (file in ROOT_TRIGGER_ALL) {
                    allAffected = true
                    continue
                }
                if (file in ROOT_TRIGGER_TARGETED) {
                    rootPkgChanged = true
                    continue
                }
            }

            // Map to a workspace package by longest prefix match
            for (dir in sortedDirs) {
                if (file.startsWith("$dir/") || file == dir) {
                    dirToName[dir]?.let { changed.add(it) }
                    break
                }
            }
        }

        return FileMapping(changed, allAffected, rootPkgChanged)
    }

    /**
     * Determine which root deps + overrides changed between baseRef and HEAD.
     */
    private fun getChangedRootDeps(repoRoot: File, baseRef: String): Set<String> {
        val old = getRootDepsAt(repoRoot, baseRef)
        val current = getRootDepsAt(repoRoot, "HEAD")
        val changed = mutableSetOf<String>()

        // Deps: added, removed, or version changed
        val allDepKeys = (old.deps.keys + current.deps.keys)
        for (key in allDepKeys) {
            if (old.deps[key] != current.deps[key]) changed.add(key)
        }

        // Overrides: added, removed, or value changed (compare via JSON stringification)
        val allOverrideKeys = (old.overrides.keys + current.overrides.keys)
        for (key in allOverrideKeys) {
            val a = jsonStringify(old.overrides[key])
            val b = jsonStringify(current.overrides[key])
            if (a != b) changed.add(key)
        }

        return changed
    }

    private data class RootDepsSnapshot(
        val deps: Map<String, String>,
        val overrides: Map<String, Any?>,
    )

    private fun getRootDepsAt(repoRoot: File, ref: String): RootDepsSnapshot {
        return try {
            val content = git(repoRoot, "show", "$ref:package.json")
            val pkg: Map<String, Any?> = mapper.readValue(content)
            @Suppress("UNCHECKED_CAST")
            val deps = mutableMapOf<String, String>()
            (pkg["dependencies"] as? Map<String, Any?>)?.forEach { (k, v) ->
                if (v is String) deps[k] = v
            }
            (pkg["devDependencies"] as? Map<String, Any?>)?.forEach { (k, v) ->
                if (v is String) deps[k] = v
            }
            @Suppress("UNCHECKED_CAST")
            val overrides = (pkg["overrides"] as? Map<String, Any?>) ?: emptyMap()
            RootDepsSnapshot(deps, overrides)
        } catch (_: Exception) {
            RootDepsSnapshot(emptyMap(), emptyMap())
        }
    }

    /**
     * Find which packages are affected by changes to root package.json deps.
     * Only marks packages whose resolved deps include the changed root deps.
     */
    private fun findPackagesAffectedByRootDeps(
        repoRoot: File,
        baseRef: String,
        graph: DependencyGraph,
    ): Set<String> {
        val changedDeps = getChangedRootDeps(repoRoot, baseRef)
        if (changedDeps.isEmpty()) return emptySet()

        val affected = mutableSetOf<String>()
        for ((name, pkg) in graph.packages) {
            // Use in-process Kotlin Prepublish to resolve this package's root deps
            val resolved = try {
                Prepublish.resolveRootDeps(pkg.dir, repoRoot)
            } catch (_: Exception) {
                emptyMap()
            }
            for (dep in changedDeps) {
                if (resolved.containsKey(dep)) {
                    affected.add(name)
                    break
                }
            }
        }
        return affected
    }

    private fun jsonStringify(value: Any?): String {
        return mapper.writeValueAsString(value)
    }

    /**
     * Run a git command in `repoRoot` and return trimmed stdout.
     * Throws on non-zero exit.
     */
    private fun git(repoRoot: File, vararg args: String): String {
        val process = ProcessBuilder("git", *args)
            .directory(repoRoot)
            .redirectErrorStream(false)
            .start()
        val out = process.inputStream.bufferedReader().readText()
        val err = process.errorStream.bufferedReader().readText()
        val finished = process.waitFor(30, java.util.concurrent.TimeUnit.SECONDS)
        if (!finished) {
            process.destroyForcibly()
            throw RuntimeException("git timed out: ${args.joinToString(" ")}")
        }
        if (process.exitValue() != 0) {
            throw RuntimeException("git failed (exit ${process.exitValue()}): ${args.joinToString(" ")}\n$err")
        }
        return out.trim()
    }
}
