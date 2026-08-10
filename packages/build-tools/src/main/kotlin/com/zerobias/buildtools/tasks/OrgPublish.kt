package com.zerobias.buildtools.tasks

import com.zerobias.buildtools.util.CurlUtils
import com.zerobias.buildtools.util.ExecUtils
import com.zerobias.buildtools.util.PackageJsonReader
import org.gradle.api.GradleException
import java.io.File
import java.nio.file.Files
import java.nio.file.attribute.PosixFilePermissions

/**
 * Shared primitives for the org-private publish path (`publish -PorgPublish=true`).
 *
 * The org path is the SAME pipeline as a normal publish — gate, preflight,
 * image build/push, npm publish, SDK publishes — with three substitutions:
 *
 *   1. the version is `X.Y.(Z+1)-rc.<orgIdHex32>.<n>` instead of a
 *      conventional-commits bump (see [computeOrgVersion]),
 *   2. the repo-release side effects (commit / tag / push / promote /
 *      release announce) are skipped — an org publish is not a repo release,
 *   3. the post-publish catalog load is driven directly via
 *      dataloader-service `/jobs` instead of the release-event pipeline.
 *
 * Everything here is deliberately stateless so the three tasks that use it
 * ([VerifyOrgPublishTask], [ResolveOrgVersionTask], [DataloaderOrgJobTask])
 * can run at different points in the graph without threading state between
 * them — each re-reads package.json, which is cheap and keeps the tasks
 * independently runnable.
 *
 * Required env:
 *   ZB_TOKEN — ZeroBias platform API key. Must belong to an admin of the
 *              orgId declared in package.json's `zerobias.orgId`
 *              (superusers may also use it).
 *
 * Optional env (prod-default overrides, kept strippable by zbb's env seal so
 * a stale shell value can't silently redirect a prod publish):
 *   ZB_PLATFORM_URL          — platform API base URL.
 *   PUBLISH_ORG_REGISTRY_URL — npm registry to classify/publish against.
 *   PUBLISH_ORG_NPM_TOKEN    — registry token, when it differs from ZB_TOKEN
 *                              (lets a local verdaccio use a fake token while
 *                              ZB_TOKEN stays the dana/dataloader auth).
 */
object OrgPublish {

    const val DEFAULT_REGISTRY_URL = "https://pkg.zerobias.org"
    const val DEFAULT_PLATFORM_URL = "https://app.zerobias.com/api"

    val UUID_RE = Regex(
        "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}",
        RegexOption.IGNORE_CASE
    )
    val PLAIN_SEMVER_RE = Regex("""(\d+)\.(\d+)\.(\d+)""")
    val RC_VERSION_RE = Regex("""\d+\.\d+\.\d+-rc\.([0-9a-f]{32})\.(\d+)""")

    /** Registry to classify + publish against. Prod verdaccio unless overridden. */
    fun registryUrl(): String =
        (System.getenv("PUBLISH_ORG_REGISTRY_URL")?.takeIf { it.isNotBlank() }
            ?: DEFAULT_REGISTRY_URL).trimEnd('/')

    /** Platform API base. Prod unless overridden. */
    fun platformUrl(): String =
        (System.getenv("ZB_PLATFORM_URL")?.takeIf { it.isNotBlank() }
            ?: DEFAULT_PLATFORM_URL).trimEnd('/')

    /**
     * Token for `npm view` / `npm publish` against [registryUrl]. Prefers
     * `PUBLISH_ORG_NPM_TOKEN`; falls back to ZB_TOKEN, which matches the prod
     * convention (`_authToken=${'$'}{ZB_TOKEN}` in the content/module `.npmrc`s).
     */
    fun resolveNpmToken(zbToken: String): String =
        System.getenv("PUBLISH_ORG_NPM_TOKEN")?.takeIf { it.isNotBlank() } ?: zbToken

    fun requireToken(taskName: String): String =
        System.getenv("ZB_TOKEN")?.takeIf { it.isNotBlank() }
            ?: throw GradleException("$taskName: ZB_TOKEN must be set.")

    /** package.json contents for [projectDir], or a clear failure. */
    fun readPackageJson(taskName: String, projectDir: File): String {
        val pkgJson = File(projectDir, "package.json")
        if (!pkgJson.isFile) {
            throw GradleException("$taskName: package.json not found at ${pkgJson.absolutePath}")
        }
        return pkgJson.readText()
    }

    /** Validated `zerobias.orgId`, hyphenated. */
    fun readOrgId(taskName: String, pkgRaw: String): String {
        val orgId = PackageJsonReader.extractZerobiasOrgId(pkgRaw)
            ?: throw GradleException(
                "$taskName: package.json must declare `zerobias.orgId` (or legacy `auditmation.orgId`)."
            )
        if (!UUID_RE.matches(orgId)) {
            throw GradleException("$taskName: zerobias.orgId \"$orgId\" is not a valid UUID.")
        }
        return orgId
    }

    /**
     * Existing versions of [pkgName] on [registryUrl], or empty when the name
     * is brand new.
     */
    fun npmViewVersions(pkgName: String, token: String, workingDir: File): List<String> {
        val npmrc = writeTempNpmrc(resolveNpmToken(token))
        try {
            val output = ExecUtils.execCapture(
                command = listOf(
                    "npm", "view", pkgName, "versions", "--json",
                    "--registry", registryUrl(),
                    "--userconfig", npmrc.absolutePath
                ),
                workingDir = workingDir,
                throwOnError = false
            )
            val trimmed = output.trim()
            if (trimmed.isEmpty()) return emptyList()
            // npm view on a missing package writes an E404 error message to
            // stdout (with throwOnError=false we'd otherwise treat that as
            // output). Detect and treat as brand-new.
            if (trimmed.contains("E404") || trimmed.contains("\"code\": \"E404\"")) return emptyList()
            return parseVersionsArray(trimmed)
        } finally {
            try { npmrc.delete() } catch (_: Exception) { /* ignore */ }
        }
    }

    private fun parseVersionsArray(stdout: String): List<String> {
        if (stdout.startsWith("[")) {
            return Regex(""""([^"]+)"""").findAll(stdout).map { it.groupValues[1] }.toList()
        }
        if (stdout.startsWith("\"")) {
            return Regex(""""([^"]+)"""").find(stdout)?.let { listOf(it.groupValues[1]) } ?: emptyList()
        }
        return emptyList()
    }

    /**
     * Highest existing org-owned increment for [pkgName], or null when the
     * name is brand new.
     *
     * Refuses names that already carry catalog (plain-semver) versions, and
     * names whose rc versions belong to a different org — an org publish must
     * never be able to squat or shadow a shared catalog artifact.
     */
    fun classifyExistingVersions(
        taskName: String,
        pkgName: String,
        versions: List<String>,
        orgIdStripped: String,
    ): Int? {
        if (versions.isEmpty()) return null
        var maxOwn = -1
        for (v in versions) {
            if (PLAIN_SEMVER_RE.matches(v)) {
                throw GradleException(
                    "$taskName: artifact \"$pkgName\" already has catalog versions (e.g. $v). " +
                    "Org publish is for artifacts that exist only inside your org."
                )
            }
            val m = RC_VERSION_RE.matchEntire(v)
                ?: throw GradleException(
                    "$taskName: artifact \"$pkgName\" has existing version \"$v\" that doesn't fit the " +
                    "org-publish format. Org publish is for artifacts that exist only inside your org."
                )
            val hex = m.groupValues[1].lowercase()
            val inc = m.groupValues[2].toInt()
            if (hex != orgIdStripped) {
                throw GradleException(
                    "$taskName: artifact \"$pkgName\" is already owned by a different org (version $v). " +
                    "Org publish cannot reuse names owned by other orgs."
                )
            }
            if (inc > maxOwn) maxOwn = inc
        }
        return maxOwn
    }

    /**
     * `X.Y.(Z+1)-rc.<orgIdHex32>.<n>` — patch-bumped off the package.json
     * version so the org line always sorts above the base version, with a
     * per-org increment so repeat publishes of the same base don't collide.
     */
    fun computeOrgVersion(
        taskName: String,
        pkgVersion: String,
        orgIdStripped: String,
        maxOwnIncrement: Int?,
    ): String {
        val semverMatch = PLAIN_SEMVER_RE.matchEntire(pkgVersion)
            ?: throw GradleException(
                "$taskName: package.json version \"$pkgVersion\" must be plain semver " +
                "(no prerelease/build metadata)."
            )
        val bumpedPatch = "${semverMatch.groupValues[1]}." +
            "${semverMatch.groupValues[2]}." +
            "${semverMatch.groupValues[3].toInt() + 1}"
        val nextIncrement = if (maxOwnIncrement == null) 0 else maxOwnIncrement + 1
        return "$bumpedPatch-rc.$orgIdStripped.$nextIncrement"
    }

    /**
     * `npm publish` args for the current publish mode.
     *
     * A catalog publish stages on the `next` dist-tag and is promoted to
     * dev/qa/uat/latest once every artifact in the release has landed. An org
     * publish is never promoted, so it takes no dist-tag at all — npm doesn't
     * auto-promote a prerelease to `latest`, and tagging one would surface a
     * single org's private artifact as the default for every consumer.
     *
     * `--registry` is added only when `PUBLISH_ORG_REGISTRY_URL` is set (local
     * verdaccio testing). In prod the repo's `.npmrc` and package.json
     * `publishConfig.registry` already point at the ZeroBias verdaccio, and
     * overriding the target here would diverge from what a catalog publish does.
     */
    fun npmPublishArgs(isOrgPublish: Boolean): List<String> {
        if (!isOrgPublish) return listOf("--tag", "next")
        val override = System.getenv("PUBLISH_ORG_REGISTRY_URL")?.takeIf { it.isNotBlank() }
        return if (override != null) listOf("--registry", override.trimEnd('/')) else emptyList()
    }

    /**
     * Temp `.npmrc` carrying auth for the target host only.
     *
     * Scope-to-registry mappings live in the project's own `.npmrc` (pointing
     * at prod for dependency installs); rewriting them here would redirect
     * every scoped lookup to the (potentially empty) target registry, breaking
     * pre-publish steps when the target is a local verdaccio.
     */
    fun writeTempNpmrc(token: String): File {
        val path = Files.createTempFile(".npmrc-org-publish-", ".tmp")
        try {
            Files.setPosixFilePermissions(path, PosixFilePermissions.fromString("rw-------"))
        } catch (_: Exception) {
            // Non-POSIX FS (Windows CI) — best-effort only.
        }
        val authHost = registryUrl()
            .removePrefix("https://")
            .removePrefix("http://")
            .trimEnd('/')
        Files.writeString(
            path,
            """
                //$authHost/:always-auth=true
                //$authHost/:_authToken=$token
            """.trimIndent() + "\n"
        )
        return path.toFile()
    }

    fun curlGet(
        label: String,
        url: String,
        headers: List<String>,
        workingDir: File,
        log: (String) -> Unit,
    ): String {
        val cmd = mutableListOf("curl", "-s", "--fail-with-body")
        cmd.addAll(headers)
        cmd.add(url)
        return CurlUtils.withRetry(cmd, workingDir, "$label: GET $url", onRetry = log)
    }

    fun curlPost(
        label: String,
        url: String,
        body: String,
        token: String,
        workingDir: File,
        log: (String) -> Unit,
    ): String {
        val cmd = mutableListOf("curl", "-s", "--fail-with-body")
        cmd.addAll(listOf(
            "-H", "Authorization: APIKey $token",
            "-H", "Content-Type: application/json",
            "-H", "Accept: application/json",
            "-X", "POST",
            "-d", body
        ))
        cmd.add(url)
        return CurlUtils.withRetry(cmd, workingDir, "$label: POST $url", onRetry = log)
    }

    fun elapsed(startMs: Long): String {
        val sec = (System.currentTimeMillis() - startMs) / 1000
        if (sec < 60) return "${sec}s"
        val min = sec / 60
        val remSec = sec % 60
        return "${min}m${remSec}s"
    }
}
