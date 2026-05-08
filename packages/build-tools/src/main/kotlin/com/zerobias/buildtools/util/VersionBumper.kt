package com.zerobias.buildtools.util

import java.io.File

/**
 * Decides whether a package needs its version bumped before publish, by
 * checking the registry for the version currently in package.json.
 *
 * Extracted from `zb.base.gradle.kts:bumpVersion` so the per-module publish
 * task and the root `versionStandardPackages` task share one implementation.
 *
 * Stateless and Gradle-free — pass in the package dir + the file that holds
 * the version.
 */
object VersionBumper {

    data class Decision(
        val name: String,
        val currentVersion: String,
        val newVersion: String,
        /** True when [currentVersion] was already on the registry → patch incremented. */
        val bumped: Boolean,
    )

    /**
     * Reads the package's name + base version (no pre-release suffix), checks
     * the npm registry for that exact name@version, and returns either:
     *   - bumped=true with newVersion = first UNPUBLISHED patch above currentVersion, or
     *   - bumped=false with newVersion = currentVersion (registry doesn't have it yet).
     *
     * Walks forward through patch versions until it finds one the registry
     * doesn't have. This handles the case where a previous run staged a
     * version with `--tag next` and rolled back, leaving the patch above
     * `currentVersion` orphaned on the registry — without the loop, the
     * bumper would land on that orphaned patch and the next publish would
     * fail with "version already published".
     *
     * Bounded at 100 iterations so a permanent registry-broken state can't
     * spin forever.
     *
     * @param packageDir directory containing package.json
     * @return Decision, or null if package.json is missing/malformed
     */
    fun decide(packageDir: File): Decision? {
        val pkgJson = File(packageDir, "package.json")
        if (!pkgJson.exists()) return null
        val text = pkgJson.readText()
        val name = Regex(""""name"\s*:\s*"([^"]+)"""")
            .find(text)?.groupValues?.get(1) ?: return null
        val rawVersion = Regex(""""version"\s*:\s*"([^"]+)"""")
            .find(text)?.groupValues?.get(1) ?: return null
        // Strip pre-release suffix (e.g. "1.2.3-rc.0" → "1.2.3") so the
        // registry check looks at the published-base version, not the
        // working-tree pre-release tag.
        val currentVersion = rawVersion.replace(Regex("-.*"), "")

        if (!isPublished(name, currentVersion, packageDir)) {
            return Decision(name, currentVersion, currentVersion, bumped = false)
        }

        var candidate = currentVersion
        var iterations = 0
        while (isPublished(name, candidate, packageDir)) {
            val parts = candidate.split(".")
            candidate = "${parts[0]}.${parts[1]}.${parts[2].toInt() + 1}"
            iterations += 1
            if (iterations >= 100) break
        }
        return Decision(name, currentVersion, candidate, bumped = true)
    }

    /**
     * Patches the version field in package.json. Idempotent — does nothing
     * if the version is already at [newVersion].
     */
    fun writeVersion(packageDir: File, newVersion: String) {
        val pkgJson = File(packageDir, "package.json")
        val content = pkgJson.readText()
        val updated = content.replace(
            Regex(""""version"\s*:\s*"[^"]+""""),
            """"version": "$newVersion""""
        )
        if (content != updated) {
            pkgJson.writeText(updated)
        }
    }

    private fun isPublished(name: String, version: String, workingDir: File): Boolean {
        return try {
            val output = ExecUtils.execCapture(
                command = listOf("npm", "view", "$name@$version", "version"),
                workingDir = workingDir,
                throwOnError = false,
            ).trim()
            output == version
        } catch (_: Exception) {
            false
        }
    }
}
