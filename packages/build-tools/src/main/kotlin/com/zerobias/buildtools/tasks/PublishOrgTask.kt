package com.zerobias.buildtools.tasks

import com.zerobias.buildtools.util.CurlUtils
import com.zerobias.buildtools.util.ExecUtils
import com.zerobias.buildtools.util.PackageJsonReader
import org.gradle.api.DefaultTask
import org.gradle.api.GradleException
import org.gradle.api.file.DirectoryProperty
import org.gradle.api.tasks.InputDirectory
import org.gradle.api.tasks.Optional
import org.gradle.api.tasks.TaskAction
import java.io.File
import java.nio.file.Files
import java.nio.file.attribute.PosixFilePermissions

/**
 * Gradle task that publishes a brand-new org-private content artifact to
 * the ZeroBias verdaccio (`https://pkg.zerobias.org`) and queues a
 * dataloader-service job to load it as org-owned content. Blocks until
 * the dataloader job terminates.
 *
 * Differs from the regular content `publishNpm` task in three ways:
 *   - Only `ZB_TOKEN` is required (no NPM_TOKEN, no NEON creds).
 *   - Refuses any artifact name that already has catalog versions OR
 *     versions owned by a different org. Same-org republishes are
 *     allowed and auto-increment.
 *   - Drives the post-publish load via dataloader-service `/jobs` and
 *     waits for the job to reach a terminal status.
 *
 * Required env (resolved via slot/vault refs in the consuming repo's
 * zbb.yaml):
 *   ZB_TOKEN  — ZeroBias platform API key. Must be an org-admin of the
 *               orgId declared in package.json's `zerobias.orgId`
 *               (superusers may also use it).
 *
 * Optional env:
 *   ZB_PLATFORM_URL — override the platform API base URL.
 *                     Defaults to `https://app.zerobias.com/api`.
 *
 * Conventionally wired with `dependsOn(tasks.named("gate"))` so the
 * artifact is validated against an ephemeral Neon branch before publish.
 */
abstract class PublishOrgTask : DefaultTask() {

    @get:InputDirectory
    @get:Optional
    abstract val packageDir: DirectoryProperty

    init {
        group = "publishing"
        description = "Publish a brand-new org-private content artifact and queue a dataloader load."
        outputs.upToDateWhen { false }
        onlyIf {
            val hasToken = System.getenv("ZB_TOKEN")?.isNotBlank() == true
            if (!hasToken) {
                logger.lifecycle("${name}: ZB_TOKEN not set — skipping")
            }
            hasToken
        }
    }

    @TaskAction
    fun execute() {
        val pkgDir: File = if (packageDir.isPresent) packageDir.get().asFile else project.projectDir
        val workingDir = project.projectDir
        val pkgJson = File(pkgDir, "package.json")
        if (!pkgJson.isFile) {
            throw GradleException("${name}: package.json not found at ${pkgJson.absolutePath}")
        }

        val token = System.getenv("ZB_TOKEN")?.takeIf { it.isNotBlank() }
            ?: throw GradleException("${name}: ZB_TOKEN must be set.")

        val pkgRaw = pkgJson.readText()
        val pkgName = PackageJsonReader.extractString(pkgRaw, "name")
            ?: throw GradleException("${name}: package.json missing 'name'.")
        val pkgVersion = PackageJsonReader.extractString(pkgRaw, "version")
            ?: throw GradleException("${name}: package.json missing 'version'.")

        val orgId = PackageJsonReader.extractZerobiasOrgId(pkgRaw)
            ?: throw GradleException(
                "${name}: package.json must declare `zerobias.orgId` (or legacy `auditmation.orgId`)."
            )
        if (!UUID_RE.matches(orgId)) {
            throw GradleException("${name}: zerobias.orgId \"$orgId\" is not a valid UUID.")
        }
        val orgIdStripped = PackageJsonReader.stripUuidHyphens(orgId)

        val semverMatch = PLAIN_SEMVER_RE.matchEntire(pkgVersion)
            ?: throw GradleException(
                "${name}: package.json version \"$pkgVersion\" must be plain semver (no prerelease/build metadata)."
            )

        // Step 1: gate runs via dependsOn wiring on the registration site.
        logger.lifecycle("${name}: orgId = $orgId")

        // Step 2: brand-new-name check
        logger.lifecycle("${name}: classifying existing versions of $pkgName in ${registryUrl()}...")
        val existing = npmViewVersions(pkgName, token, workingDir)
        val maxOwnIncrement = classifyExistingVersions(pkgName, existing, orgIdStripped)
        if (maxOwnIncrement == null) {
            logger.lifecycle("${name}: no existing versions — brand new.")
        } else {
            logger.lifecycle(
                "${name}: ${existing.size} existing org-owned version(s); max increment = $maxOwnIncrement."
            )
        }

        // Step 3: admin check via dana /me
        logger.lifecycle("${name}: verifying principal is admin of $orgId...")
        val whoAmI = danaMe(token, orgId, workingDir)
        when (PackageJsonReader.extractBoolean(whoAmI, "isAdmin")) {
            null -> throw GradleException(
                "${name}: dana /me response does not include `isAdmin`. " +
                "Deployed dana may be older than this feature; upgrade before using publishOrg."
            )
            false -> throw GradleException("${name}: principal is not an admin of org $orgId.")
            true -> { /* allowed */ }
        }

        // Step 4: compute version
        val bumpedPatch = "${semverMatch.groupValues[1]}." +
            "${semverMatch.groupValues[2]}." +
            "${semverMatch.groupValues[3].toInt() + 1}"
        val nextIncrement = if (maxOwnIncrement == null) 0 else maxOwnIncrement + 1
        val newVersion = "$bumpedPatch-rc.$orgIdStripped.$nextIncrement"
        logger.lifecycle("${name}: new version = $newVersion")

        // Step 5: npm publish (in-place version bump with restore)
        logger.lifecycle("${name}: publishing $pkgName@$newVersion to ${registryUrl()}...")
        publishWithVersionBump(pkgJson, pkgRaw, newVersion, token, pkgDir)
        logger.lifecycle("${name}: published.")

        // Step 6: queue dataloader job
        logger.lifecycle("${name}: queueing dataloader job...")
        val jobJson = postDataloaderJob(pkgName, newVersion, token, workingDir)
        val jobId = PackageJsonReader.extractString(jobJson, "id")
            ?: throw GradleException("${name}: dataloader /jobs response missing 'id':\n$jobJson")
        logger.lifecycle("${name}: job id = $jobId")

        // Step 7: poll job to terminal status
        logger.lifecycle("${name}: polling job $jobId for completion...")
        pollDataloaderJob(jobId, token, workingDir)
    }

    // ─── Helpers ───────────────────────────────────────────────────────

    private fun npmViewVersions(pkgName: String, token: String, workingDir: File): List<String> {
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

    private fun classifyExistingVersions(
        pkgName: String,
        versions: List<String>,
        orgIdStripped: String,
    ): Int? {
        if (versions.isEmpty()) return null
        var maxOwn = -1
        for (v in versions) {
            if (PLAIN_SEMVER_RE.matches(v)) {
                throw GradleException(
                    "${name}: artifact \"$pkgName\" already has catalog versions (e.g. $v). " +
                    "publishOrg is for brand-new artifacts only."
                )
            }
            val m = RC_VERSION_RE.matchEntire(v)
                ?: throw GradleException(
                    "${name}: artifact \"$pkgName\" has existing version \"$v\" that doesn't fit the publishOrg format. " +
                    "publishOrg is for brand-new artifacts only."
                )
            val hex = m.groupValues[1].lowercase()
            val inc = m.groupValues[2].toInt()
            if (hex != orgIdStripped) {
                throw GradleException(
                    "${name}: artifact \"$pkgName\" is already owned by a different org (version $v). " +
                    "publishOrg cannot reuse names owned by other orgs."
                )
            }
            if (inc > maxOwn) maxOwn = inc
        }
        return maxOwn
    }

    private fun danaMe(token: String, orgId: String, workingDir: File): String {
        val url = "${platformUrl()}/dana/me"
        return curlGet(
            url,
            listOf(
                "-H", "Authorization: APIKey $token",
                "-H", "dana-org-id: $orgId",
                "-H", "Accept: application/json"
            ),
            workingDir
        )
    }

    private fun postDataloaderJob(
        pkgName: String,
        version: String,
        token: String,
        workingDir: File,
    ): String {
        val url = "${platformUrl()}/dataloader/jobs"
        val body = """{"artifactName":${PackageJsonReader.jsonEscape(pkgName)},"artifactVersion":${PackageJsonReader.jsonEscape(version)}}"""
        return curlPost(url, body, token, workingDir)
    }

    private fun pollDataloaderJob(jobId: String, token: String, workingDir: File) {
        val url = "${platformUrl()}/dataloader/jobs/$jobId"
        val startMs = System.currentTimeMillis()
        var lastStatus = ""
        var lastHeartbeatMs = startMs
        while (true) {
            val resp = curlGet(
                url,
                listOf(
                    "-H", "Authorization: APIKey $token",
                    "-H", "Accept: application/json"
                ),
                workingDir
            )
            val status = (PackageJsonReader.extractString(resp, "status") ?: "").lowercase()
            val elapsedStr = elapsed(startMs)

            if (status != lastStatus) {
                logger.lifecycle("${name}: status = $status ($elapsedStr)")
                lastStatus = status
                lastHeartbeatMs = System.currentTimeMillis()
            } else if (System.currentTimeMillis() - lastHeartbeatMs >= HEARTBEAT_INTERVAL_MS) {
                logger.lifecycle("${name}: still $status... ($elapsedStr)")
                lastHeartbeatMs = System.currentTimeMillis()
            }

            if (status == "completed") {
                logger.lifecycle("${name}: dataloader job completed in $elapsedStr.")
                return
            }
            if (status == "failed" || status == "errored") {
                val errMsg = PackageJsonReader.extractString(resp, "errorMessage")
                if (errMsg != null) logger.lifecycle("${name}: error: $errMsg")
                throw GradleException("${name}: dataloader job $status ($elapsedStr).")
            }

            Thread.sleep(POLL_INTERVAL_MS)
        }
    }

    private fun publishWithVersionBump(
        pkgJson: File,
        originalRaw: String,
        newVersion: String,
        token: String,
        workingDir: File,
    ) {
        // In-place bump with try/finally restore. Cleaner than a temp-dir
        // copy because npm publish reads the real source tree (files: globs,
        // prepublish hooks, repo links). A hard kill mid-publish would leave
        // the bumped version on disk; `git checkout package.json` recovers it.
        val bumped = bumpVersionInPackageJson(originalRaw, newVersion)
        val npmrc = writeTempNpmrc(resolveNpmToken(token))
        try {
            pkgJson.writeText(bumped)
            // No --tag — npm doesn't auto-promote prerelease versions to latest.
            ExecUtils.exec(
                command = listOf(
                    "npm", "publish",
                    "--registry", registryUrl(),
                    "--userconfig", npmrc.absolutePath
                ),
                workingDir = workingDir,
                throwOnError = true
            )
        } finally {
            try { pkgJson.writeText(originalRaw) } catch (_: Exception) { /* user can recover via git */ }
            try { npmrc.delete() } catch (_: Exception) { /* ignore */ }
        }
    }

    private fun bumpVersionInPackageJson(raw: String, newVersion: String): String {
        // Replace the first top-level "version" string. Anchor on
        // start-of-line + indent to avoid matching nested "version" fields
        // (e.g. in a `dependencies` block).
        val regex = Regex("""(^\s*"version"\s*:\s*")[^"]+(")""", RegexOption.MULTILINE)
        val m = regex.find(raw)
            ?: throw GradleException("${name}: failed to locate top-level \"version\" field in package.json")
        return raw.substring(0, m.range.first) +
            m.groupValues[1] +
            newVersion +
            m.groupValues[2] +
            raw.substring(m.range.last + 1)
    }

    private fun writeTempNpmrc(token: String): File {
        val path = Files.createTempFile(".npmrc-publishOrg-", ".tmp")
        try {
            Files.setPosixFilePermissions(path, PosixFilePermissions.fromString("rw-------"))
        } catch (_: Exception) {
            // Non-POSIX FS (Windows CI) — best-effort only.
        }
        // Only emit auth lines for the target host. Scope-to-registry
        // mappings live in the project's own .npmrc (pointing at prod for
        // dependency installs); rewriting them here would redirect every
        // scoped lookup during publish to the (potentially empty) target
        // registry, breaking pre-publish steps when the target is a local
        // verdaccio. The actual publish destination is set by the
        // `--registry` flag passed to `npm publish`.
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

    /**
     * Resolve the token used for `npm publish` / `npm view` against the
     * resolved registry. Prefers `PUBLISH_ORG_NPM_TOKEN` (lets local
     * verdaccio use `fake-local-token` while ZB_TOKEN remains the auth
     * for dana / dataloader-service); falls back to the passed-in
     * ZB_TOKEN, which matches the prod convention (`_authToken=${'$'}{ZB_TOKEN}`
     * in content-repo `.npmrc`s).
     */
    private fun resolveNpmToken(zbToken: String): String =
        System.getenv("PUBLISH_ORG_NPM_TOKEN")?.takeIf { it.isNotBlank() } ?: zbToken

    private fun platformUrl(): String =
        (System.getenv("ZB_PLATFORM_URL")?.takeIf { it.isNotBlank() } ?: DEFAULT_PLATFORM_URL).trimEnd('/')

    private fun curlGet(url: String, headers: List<String>, workingDir: File): String {
        val cmd = mutableListOf("curl", "-s", "--fail-with-body")
        cmd.addAll(headers)
        cmd.add(url)
        return CurlUtils.withRetry(cmd, workingDir, "${name}: GET $url") { msg ->
            logger.lifecycle(msg)
        }
    }

    private fun curlPost(url: String, body: String, token: String, workingDir: File): String {
        val cmd = mutableListOf("curl", "-s", "--fail-with-body")
        cmd.addAll(listOf(
            "-H", "Authorization: APIKey $token",
            "-H", "Content-Type: application/json",
            "-H", "Accept: application/json",
            "-X", "POST",
            "-d", body
        ))
        cmd.add(url)
        return CurlUtils.withRetry(cmd, workingDir, "${name}: POST $url") { msg ->
            logger.lifecycle(msg)
        }
    }

    private fun elapsed(startMs: Long): String {
        val sec = (System.currentTimeMillis() - startMs) / 1000
        if (sec < 60) return "${sec}s"
        val min = sec / 60
        val remSec = sec % 60
        return "${min}m${remSec}s"
    }

    companion object {
        const val PUBLISH_ORG_TASK_NAME = "publishOrg"

        private const val DEFAULT_REGISTRY_URL = "https://pkg.zerobias.org"
        private const val DEFAULT_PLATFORM_URL = "https://app.zerobias.com/api"
        private const val POLL_INTERVAL_MS = 10_000L
        private const val HEARTBEAT_INTERVAL_MS = 60_000L
        private val UUID_RE = Regex(
            "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}",
            RegexOption.IGNORE_CASE
        )
        private val PLAIN_SEMVER_RE = Regex("""(\d+)\.(\d+)\.(\d+)""")
        private val RC_VERSION_RE = Regex("""\d+\.\d+\.\d+-rc\.([0-9a-f]{32})\.(\d+)""")

        /**
         * Resolve the npm registry to publish into. Reads
         * `PUBLISH_ORG_REGISTRY_URL` if set (lets local testing point at a
         * local verdaccio); otherwise the prod ZeroBias verdaccio.
         */
        private fun registryUrl(): String =
            (System.getenv("PUBLISH_ORG_REGISTRY_URL")?.takeIf { it.isNotBlank() }
                ?: DEFAULT_REGISTRY_URL).trimEnd('/')
    }
}
