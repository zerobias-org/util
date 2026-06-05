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

        val newVersion = firstUnpublishedPatch(currentVersion) { isPublished(name, it, packageDir) }
        return Decision(name, currentVersion, newVersion, bumped = newVersion != currentVersion)
    }

    /**
     * Returns the first patch version at or above [currentVersion] that
     * [isPublished] reports as NOT on the registry. If [currentVersion] itself
     * is unpublished it is returned unchanged; otherwise the patch component is
     * walked forward until an unpublished version is found.
     *
     * This is also what keeps a branch pre-release sorting ABOVE the latest
     * release: a branch build off an already-published base (e.g. main shipped
     * 2.0.2 while the branch is still on 2.0.2) must target 2.0.3, so the cut
     * `2.0.3-dev.0` sorts above `2.0.2` — instead of `2.0.2-dev.0`, which sorts
     * BELOW it and drags the branch dist-tag backwards relative to `latest`.
     *
     * Bounded at 100 iterations so a permanently registry-broken state can't
     * spin forever. Pure — the registry check is injected as [isPublished] — so
     * the walk can be unit-tested without hitting npm.
     */
    fun firstUnpublishedPatch(currentVersion: String, isPublished: (String) -> Boolean): String {
        var candidate = currentVersion
        var iterations = 0
        while (isPublished(candidate)) {
            val parts = candidate.split(".")
            candidate = "${parts[0]}.${parts[1]}.${parts[2].toInt() + 1}"
            iterations += 1
            if (iterations >= 100) break
        }
        return candidate
    }

    /**
     * Resolve the full pre-release version a branch publish should use.
     *
     * @param base        the package's release version with no suffix (e.g. "2.0.2")
     * @param suffix      the branch pre-release label (e.g. "dev", "rc", "uat")
     * @param startCounter the counter to begin numbering from (normally 0)
     * @param isPublished registry check — true if that exact version exists
     *
     * Rules, all driven purely by what [isPublished] reports:
     *  - The result never sorts below an already-published release. If [base] is
     *    itself published, the base is advanced to the first unpublished patch
     *    first (so a dev push AFTER main shipped 2.0.2 cuts `2.0.3-dev.0`, not
     *    `2.0.2-dev.0`, which would sort below 2.0.2 and move the dist-tag back).
     *  - While the release is still unpublished the patch is preserved and only
     *    the counter advances on a collision:
     *      • another dev push on an unreleased 2.0.2 → `2.0.2-dev.1`, `…dev.2`
     *      • promoting dev→qa swaps the suffix and restarts the counter, so
     *        `2.0.2-dev.2` becomes `2.0.2-qa.0` (the patch is untouched).
     *  - The counter walk is bounded at 50 increments.
     */
    fun resolvePreRelease(
        base: String,
        suffix: String,
        startCounter: Int,
        isPublished: (String) -> Boolean,
    ): String {
        val effectiveBase = firstUnpublishedPatch(base, isPublished)
        var counter = startCounter
        var candidate = "$effectiveBase-$suffix.$counter"
        var iterations = 0
        while (isPublished(candidate) && iterations < 50) {
            counter += 1
            candidate = "$effectiveBase-$suffix.$counter"
            iterations += 1
        }
        return candidate
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
