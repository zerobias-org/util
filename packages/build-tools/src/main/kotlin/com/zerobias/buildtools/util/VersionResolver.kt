package com.zerobias.buildtools.util

import java.net.HttpURLConnection
import java.net.URI

/**
 * Resolves the next available patch version for a Maven coordinate by
 * checking what's already published to Maven Central and GitHub Packages.
 *
 * Intended usage from a consumer's build.gradle(.kts):
 *
 *   import com.zerobias.buildtools.util.VersionResolver
 *   group = "com.zerobias"
 *   version = VersionResolver.autoBumpPatch("com.zerobias", "lite-filter", "1.0")
 *
 * Both sources are queried because the repo historically published to
 * GitHub Packages and has since pivoted to Maven Central — taking max
 * across both avoids accidentally reusing a version that already exists
 * on one side. GitHub Packages requires GITHUB_TOKEN; if absent, that
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

        val githubToken = System.getenv("GITHUB_TOKEN")?.takeIf { it.isNotEmpty() }
        val githubMax = if (githubToken != null) {
            queryMetadata(
                "https://maven.pkg.github.com/zerobias-org/util/$groupPath/$artifact/maven-metadata.xml",
                authHeader = "Bearer $githubToken",
                baseVersion = baseVersion,
            )
        } else {
            -1
        }

        val max = maxOf(centralMax, githubMax)
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
            val pattern = Regex("""\Q$baseVersion\E\.(\d+)""")
            pattern.findAll(xml)
                .mapNotNull { it.groupValues[1].toIntOrNull() }
                .maxOrNull() ?: -1
        } catch (_: Exception) {
            -1
        }
    }
}
