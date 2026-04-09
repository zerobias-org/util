package com.zerobias.buildtools.monorepo

import java.io.File

/**
 * Tag-based change detection for monorepo publish.
 *
 * Mirrors `lib/monorepo/Publisher.ts detectPublishChanges`:
 *   1. For each non-private package, find the last git tag `<shortName>@*`
 *   2. If no tag → never published → always include
 *   3. If tag found → git diff since that tag for the package's dir
 *   4. Filter out docs (.md) and CI (.github/, .claude/) changes
 *   5. Stack package: also check root trigger files (zbb.yaml, test/)
 *   6. Expand to transitive dependents
 *
 * Then version resolution per package:
 *   - Query npm registry for published versions (`npm view <pkg> versions --json`)
 *   - If current version is NOT published → use it
 *   - If IS published → auto-patch-bump until an unpublished version is found
 *   - Also cross-updates workspace dependency versions
 */
object PublishChangeDetector {

    data class PublishPlan(
        /** Packages that have changes since their last published tag */
        val changed: Set<String>,
        /** changed + transitive dependents, in build order */
        val publishOrdered: List<String>,
        /** Resolved versions per package name (may differ from package.json if auto-bumped) */
        val resolvedVersions: Map<String, ResolvedVersion>,
    )

    data class ResolvedVersion(
        val version: String,
        val bumped: Boolean,
    )

    private val STACK_TRIGGER_PATTERNS = listOf("zbb.yaml", "test/")

    /**
     * Detect which packages need publishing and resolve their versions.
     */
    fun detectChanges(
        repoRoot: File,
        graph: DependencyGraph,
        config: MonorepoConfig,
        registry: String? = null,
    ): PublishPlan {
        val changed = mutableSetOf<String>()

        for ((name, pkg) in graph.packages) {
            if (pkg.private) continue
            if (config.skipPublish.contains(name)) continue

            val lastTag = getLastPublishedTag(pkg, repoRoot)
            if (lastTag == null) {
                // Never published
                changed.add(name)
                continue
            }

            val changedFiles = getChangedFilesSinceRef(repoRoot, lastTag, pkg.relDir)
            if (changedFiles.isNotEmpty()) {
                changed.add(name)
            }
        }

        // Stack special case: check root trigger files
        val stackPkg = graph.packages.values.find { it.relDir == "stack" }
        if (stackPkg != null && !changed.contains(stackPkg.name)) {
            val stackTag = getLastPublishedTag(stackPkg, repoRoot)
            val ref = stackTag ?: "HEAD~1"
            for (pattern in STACK_TRIGGER_PATTERNS) {
                val files = getChangedFilesSinceRef(repoRoot, ref, pattern)
                if (files.isNotEmpty()) {
                    changed.add(stackPkg.name)
                    break
                }
            }
        }

        // Expand to transitive dependents (non-private only)
        val affected = mutableSetOf<String>()
        affected.addAll(changed)
        for (name in changed) {
            val deps = Workspace.getTransitiveDependents(name, graph)
            for (dep in deps) {
                val pkg = graph.packages[dep] ?: continue
                if (!pkg.private && !config.skipPublish.contains(dep)) {
                    affected.add(dep)
                }
            }
        }

        val publishOrdered = Workspace.sortByBuildOrder(affected, graph)

        // Resolve versions against the registry
        val resolvedVersions = mutableMapOf<String, ResolvedVersion>()
        for (name in publishOrdered) {
            val pkg = graph.packages[name] ?: continue
            val publishedVersions = getPublishedVersions(name, registry)
            resolvedVersions[name] = resolvePublishVersion(pkg.version, publishedVersions)
        }

        return PublishPlan(
            changed = changed,
            publishOrdered = publishOrdered,
            resolvedVersions = resolvedVersions,
        )
    }

    // ── Git helpers ──────────────────────────────────────────────────

    /**
     * Find the last published git tag for a package.
     * Tags follow the format: `<shortName>@<version>` (e.g. `util-core@1.0.27`)
     */
    private fun getLastPublishedTag(pkg: WorkspacePackage, repoRoot: File): String? {
        val sn = pkg.name.replace(Regex("^@[^/]+/"), "")
        return try {
            val proc = ProcessBuilder(
                "git", "describe", "--tags", "--abbrev=0", "--match=$sn@*"
            )
                .directory(repoRoot)
                .redirectErrorStream(false)
                .start()
            val output = proc.inputStream.bufferedReader().readText().trim()
            val finished = proc.waitFor(10, java.util.concurrent.TimeUnit.SECONDS)
            if (!finished || proc.exitValue() != 0 || output.isEmpty()) null
            else output
        } catch (_: Exception) {
            null
        }
    }

    /**
     * Get files changed for a specific path filter since a git ref.
     * Excludes docs and CI files.
     */
    private fun getChangedFilesSinceRef(
        repoRoot: File,
        ref: String,
        pathFilter: String? = null,
    ): List<String> {
        return try {
            val args = mutableListOf("git", "diff", "--name-only", "$ref..HEAD")
            if (pathFilter != null) {
                args.add("--")
                args.add(pathFilter)
            }
            val proc = ProcessBuilder(args)
                .directory(repoRoot)
                .redirectErrorStream(false)
                .start()
            val output = proc.inputStream.bufferedReader().readText().trim()
            val finished = proc.waitFor(10, java.util.concurrent.TimeUnit.SECONDS)
            if (!finished || proc.exitValue() != 0 || output.isEmpty()) {
                emptyList()
            } else {
                output.lines().filter { f ->
                    !f.endsWith(".md") &&
                    !f.startsWith(".github/") &&
                    !f.startsWith(".claude/")
                }
            }
        } catch (_: Exception) {
            emptyList()
        }
    }

    // ── Version resolution ───────────────────────────────────────────

    /**
     * Get all published versions for a package from the npm registry.
     */
    private fun getPublishedVersions(packageName: String, registry: String? = null): Set<String> {
        return try {
            val args = mutableListOf("npm", "view", packageName, "versions", "--json")
            if (registry != null) {
                args.addAll(listOf("--registry", registry))
            }
            val proc = ProcessBuilder(args)
                .redirectErrorStream(false)
                .start()
            val output = proc.inputStream.bufferedReader().readText().trim()
            val finished = proc.waitFor(30, java.util.concurrent.TimeUnit.SECONDS)
            if (!finished || proc.exitValue() != 0 || output.isEmpty()) {
                return emptySet()
            }

            // npm returns a JSON string for single version, array for multiple
            if (output.startsWith("[")) {
                // Array: ["1.0.0", "1.0.1", ...]
                output.removeSurrounding("[", "]")
                    .split(",")
                    .map { it.trim().removeSurrounding("\"") }
                    .filter { it.isNotEmpty() }
                    .toSet()
            } else if (output.startsWith("\"")) {
                // Single string: "1.0.0"
                setOf(output.removeSurrounding("\""))
            } else {
                emptySet()
            }
        } catch (_: Exception) {
            emptySet()
        }
    }

    /**
     * Resolve the version to publish:
     * - If the current version is NOT published, use it
     * - If it IS published, auto-patch-bump until we find an unpublished version
     */
    private fun resolvePublishVersion(
        currentVersion: String,
        publishedVersions: Set<String>,
    ): ResolvedVersion {
        if (!publishedVersions.contains(currentVersion)) {
            return ResolvedVersion(version = currentVersion, bumped = false)
        }

        var version = currentVersion
        for (attempt in 0 until 50) {
            version = incrementPatch(version)
            if (!publishedVersions.contains(version)) {
                return ResolvedVersion(version = version, bumped = true)
            }
        }

        throw RuntimeException(
            "Could not find unpublished version after 50 patch bumps from $currentVersion"
        )
    }

    private fun incrementPatch(version: String): String {
        val parts = version.split(".")
        if (parts.size != 3) throw RuntimeException("Invalid semver: $version")
        return "${parts[0]}.${parts[1]}.${parts[2].toInt() + 1}"
    }

    // ── Package.json manipulation ────────────────────────────────────

    /**
     * Patch a package.json version field in place.
     */
    fun patchPackageJsonVersion(pkgDir: File, newVersion: String) {
        val pkgJsonFile = File(pkgDir, "package.json")
        val content = pkgJsonFile.readText()
        val updated = content.replace(
            Regex(""""version"\s*:\s*"[^"]+""""),
            """"version": "$newVersion""""
        )
        pkgJsonFile.writeText(updated)
    }

    /**
     * Update a workspace dependency version reference across
     * dependencies/devDependencies/peerDependencies.
     */
    fun updateDependencyVersion(pkgDir: File, depName: String, newVersion: String) {
        val pkgJsonFile = File(pkgDir, "package.json")
        var content = pkgJsonFile.readText()
        var changed = false

        for (section in listOf("dependencies", "devDependencies", "peerDependencies")) {
            // Match: "depName": "^1.0.0" or "depName": "1.0.0" etc.
            val pattern = Regex(""""$depName"\s*:\s*"([^"]*?)"""")
            val match = pattern.find(content) ?: continue
            val currentValue = match.groupValues[1]
            // Preserve the version prefix (^, ~, etc.)
            val prefix = currentValue.replace(Regex("[0-9].*"), "")
            val newValue = "$prefix$newVersion"
            content = content.replaceFirst(
                """"$depName": "$currentValue"""",
                """"$depName": "$newValue""""
            )
            changed = true
        }

        if (changed) {
            pkgJsonFile.writeText(content)
        }
    }
}
