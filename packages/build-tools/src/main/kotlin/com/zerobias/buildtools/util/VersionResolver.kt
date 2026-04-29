package com.zerobias.buildtools.util

import java.net.HttpURLConnection
import java.net.URI

/**
 * Resolves the next available patch version for a Maven coordinate by
 * checking what's already published to Maven Central, GitHub Packages,
 * the developer's local Maven repository (`~/.m2`), and local git tags.
 *
 * Intended usage from a consumer's build.gradle(.kts):
 *
 *   import com.zerobias.buildtools.util.VersionResolver
 *   group = "com.zerobias"
 *   version = VersionResolver.autoBumpPatch("com.zerobias", "lite-filter", "1.0")
 *
 * All four sources are queried because:
 *   - The repo historically published to GitHub Packages and has since
 *     pivoted to Maven Central — taking max across both avoids reusing
 *     a version that already exists on one side.
 *   - mavenLocal is included so `publishToMavenLocal` always ratchets
 *     above whatever was last published anywhere. Without it, an offline
 *     dev (no `*_TOKEN` env var) would emit `<baseVersion>.0` on every
 *     publish and never beat the latest GitHub version, leaving root
 *     builds resolving the stale GitHub jar instead of local edits.
 *   - Git tags (`<artifact>-v<base>.<patch>`) are the only source that
 *     reflects a successful publish *immediately* — Sonatype Central can
 *     take 10–30 min to propagate to repo1.maven.org, and during that
 *     window the registries return a stale max. The publish flow tags
 *     in the same run as the registry push, so the tag list is the
 *     fast-path source of truth.
 *
 * GitHub Packages requires a token. The credential chain matches
 * settings.gradle.kts's github maven repo block:
 * `READ_TOKEN ?: NPM_TOKEN ?: GITHUB_TOKEN`. If none is set, that
 * source is skipped.
 *
 * Any network/parse failure falls back to `<baseVersion>.0`. Failing
 * loud would block publish pipelines on a transient outage; the
 * subsequent `publishAndReleaseToMavenCentral` call will fail cleanly
 * on a genuine version collision at the staging step.
 */
object VersionResolver {

    @JvmStatic
    fun autoBumpPatch(group: String, artifact: String, baseVersion: String): String {
        val groupPath = group.replace('.', '/')

        val centralMax = queryMetadata(
            "https://repo1.maven.org/maven2/$groupPath/$artifact/maven-metadata.xml",
            authHeader = null,
            baseVersion = baseVersion,
        )

        val githubToken = sequenceOf("READ_TOKEN", "NPM_TOKEN", "GITHUB_TOKEN")
            .mapNotNull { System.getenv(it)?.takeIf { v -> v.isNotEmpty() } }
            .firstOrNull()
        val githubMax = if (githubToken != null) {
            queryMetadata(
                "https://maven.pkg.github.com/zerobias-org/util/$groupPath/$artifact/maven-metadata.xml",
                authHeader = "Bearer $githubToken",
                baseVersion = baseVersion,
            )
        } else {
            -1
        }

        val localMax = queryMavenLocal(groupPath, artifact, baseVersion)
        val gitTagMax = queryGitTags(artifact, baseVersion)

        val max = maxOf(centralMax, githubMax, localMax, gitTagMax)
        return if (max < 0) "$baseVersion.0" else "$baseVersion.${max + 1}"
    }

    private fun queryMetadata(url: String, authHeader: String?, baseVersion: String): Int {
        return try {
            val conn = URI(url).toURL().openConnection() as HttpURLConnection
            if (authHeader != null) conn.setRequestProperty("Authorization", authHeader)
            conn.connectTimeout = 5000
            conn.readTimeout = 5000
            conn.connect()
            val code = conn.responseCode
            if (code != 200) {
                conn.disconnect()
                return -1
            }
            val xml = conn.inputStream.bufferedReader().use { it.readText() }
            conn.disconnect()
            parseMaxPatch(xml, baseVersion)
        } catch (_: Exception) {
            -1
        }
    }

    private fun queryMavenLocal(groupPath: String, artifact: String, baseVersion: String): Int {
        val home = System.getProperty("user.home") ?: return -1
        val metadata = java.io.File("$home/.m2/repository/$groupPath/$artifact/maven-metadata-local.xml")
        return if (metadata.exists()) parseMaxPatch(metadata.readText(), baseVersion) else -1
    }

    /**
     * Scans local git tags of the form `<artifact>-v<baseVersion>.<patch>` and
     * returns the highest patch number seen, or -1 on any failure / no match.
     *
     * Tags are the only registry-equivalent source that gets written *during*
     * a successful publish run, before Sonatype Central indexing catches up.
     * Walks up from `user.dir` until it finds a `.git/` so it works whether
     * gradle was invoked from the repo root or a subproject dir.
     */
    private fun queryGitTags(artifact: String, baseVersion: String): Int {
        val repoRoot = findGitRoot() ?: return -1
        return try {
            val proc = ProcessBuilder(
                "git", "tag", "-l", "$artifact-v$baseVersion.*",
            )
                .directory(repoRoot)
                .redirectErrorStream(false)
                .start()
            val finished = proc.waitFor(5, java.util.concurrent.TimeUnit.SECONDS)
            if (!finished) {
                proc.destroyForcibly()
                return -1
            }
            if (proc.exitValue() != 0) return -1
            val out = proc.inputStream.bufferedReader().readText()
            val pattern = Regex("""\Q$artifact-v$baseVersion\E\.(\d+)""")
            pattern.findAll(out)
                .mapNotNull { it.groupValues[1].toIntOrNull() }
                .maxOrNull() ?: -1
        } catch (_: Exception) {
            -1
        }
    }

    private fun findGitRoot(): java.io.File? {
        var dir: java.io.File? = java.io.File(System.getProperty("user.dir") ?: return null)
        while (dir != null) {
            if (java.io.File(dir, ".git").exists()) return dir
            dir = dir.parentFile
        }
        return null
    }

    private fun parseMaxPatch(xml: String, baseVersion: String): Int {
        val pattern = Regex("""\Q$baseVersion\E\.(\d+)""")
        return pattern.findAll(xml)
            .mapNotNull { it.groupValues[1].toIntOrNull() }
            .maxOrNull() ?: -1
    }
}
