package com.zerobias.buildtools.tasks

import com.zerobias.buildtools.util.ExecUtils
import org.gradle.api.DefaultTask
import org.gradle.api.GradleException
import org.gradle.api.file.DirectoryProperty
import org.gradle.api.file.RegularFileProperty
import org.gradle.api.provider.Property
import org.gradle.api.tasks.Input
import org.gradle.api.tasks.InputDirectory
import org.gradle.api.tasks.Optional
import org.gradle.api.tasks.OutputFile
import org.gradle.api.tasks.TaskAction
import java.io.File
import kotlin.random.Random

/**
 * Gradle task that runs the platform `dataloader` CLI against an ephemeral
 * Neon Postgres branch.
 *
 * The branch is provisioned by the platform `dataloader-service` at
 * `https://app.zerobias.com/api/dataloader-service/branches`, which both
 * creates the branch (with a 3-hour `expires_at` backstop) and exposes its
 * Postgres credentials. We do NOT talk to Neon directly anymore — the service
 * owns the Neon API key.
 *
 * Required env:
 *   ZB_TOKEN — required for ZeroBias production authentication against the
 *              dataloader-service. Failure to set it is fatal (no silent skip).
 *
 * Optional env (passed through to the service):
 *   NEON_PARENT_BRANCH    — override server default
 *   NEON_DB_ROLE / NEON_DB_NAME are no longer read here; the service owns them.
 *
 * Usage:
 *   tasks.register<NeonDataloaderTask>("testIntegrationDataloader") {
 *       packageDir.set(layout.projectDirectory)
 *   }
 */
abstract class NeonDataloaderTask : DefaultTask() {

    @get:InputDirectory
    @get:Optional
    abstract val packageDir: DirectoryProperty

    /**
     * Identifier for this run. The service prepends `test/` and appends a
     * timestamp, so the final branch name is `test/{testName}-{epochMs}`.
     * Defaults to the package.json `name` with `@` stripped and `/` → `-`.
     */
    @get:Input
    @get:Optional
    abstract val testName: Property<String>

    /**
     * Optional parent branch name (default branch the new branch is forked
     * from). When unset, the service uses its configured default
     * (typically `content-master`).
     */
    @get:Input
    @get:Optional
    abstract val parentBranch: Property<String>

    /**
     * Backstop expiry in seconds. If unset, the service uses its default
     * (10800 = 3h).
     */
    @get:Input
    @get:Optional
    abstract val ttlSeconds: Property<Int>

    /**
     * Pass `-f` to the dataloader CLI. Needed when the parent branch's
     * snapshot may already contain the artifact at the same version — without
     * `-f` the loader exits 0 after a no-op skip and the gate stamps green
     * without ever validating the new bits.
     */
    @get:Input
    @get:Optional
    abstract val force: Property<Boolean>

    /**
     * Optional path to write the captured dataloader output to. When set,
     * matches the `.zbb-monorepo/logs/<task>.log` convention used by other
     * Exec tasks so zbb's failure reporter finds the log.
     */
    @get:OutputFile
    @get:Optional
    abstract val displayLogPath: RegularFileProperty

    init {
        group = "lifecycle"
        description = "Run dataloader against an ephemeral Neon branch (provisioned via dataloader-service)"
        outputs.upToDateWhen { false }
    }

    @TaskAction
    fun execute() {
        val pkgDir: File = if (packageDir.isPresent) packageDir.get().asFile else project.projectDir
        val workingDir = project.projectDir

        val token = System.getenv("ZB_TOKEN")?.takeIf { it.isNotBlank() }
            ?: throw GradleException(
                "${name}: ZB_TOKEN is not set. testDataloader requires ZB_TOKEN " +
                "for ZeroBias production authentication against the dataloader-service /branches endpoint."
            )

        val resolvedTestName = (testName.orNull?.takeIf { it.isNotBlank() } ?: run {
            val (pkgName, _) = readPackageNameVersion(File(pkgDir, "package.json"))
            pkgName.replace("@", "").replace("/", "-")
        }).replace(Regex("[^a-zA-Z0-9_-]"), "-")

        // ── 1: Ask dataloader-service for an ephemeral branch ──
        val createBody = buildCreateBody(resolvedTestName, parentBranch.orNull, ttlSeconds.orNull)
        logger.lifecycle("${name}: Requesting Neon branch via dataloader-service for '$resolvedTestName'")
        val createOutput = curlWithRetry(
            listOf(
                "curl", "-s", "--fail-with-body",
                "-H", "Authorization: APIKey $token",
                "-H", "Content-Type: application/json",
                "-X", "POST",
                "-d", createBody,
                "$SERVICE_BASE_URL/branches"
            ),
            workingDir
        )

        val creds = parseBranchCredentials(createOutput)
        logger.lifecycle("${name}: Neon branch ready")
        logger.lifecycle("  branchId   = ${creds.branchId}")
        logger.lifecycle("  branchName = ${creds.branchName}")
        logger.lifecycle("  PGHOST     = ${creds.host}")
        logger.lifecycle("  PGPORT     = ${creds.port}")
        logger.lifecycle("  PGUSER     = ${creds.user}")
        logger.lifecycle("  PGDATABASE = ${creds.database}")
        logger.lifecycle("  PGSSLMODE  = ${creds.sslMode}")
        logger.lifecycle("  expiresAt  = ${creds.expiresAt}")

        try {
            // ── 2: Run dataloader against the branch ──
            val pgEnv = mapOf(
                "PGHOST" to creds.host,
                "PGPORT" to creds.port.toString(),
                "PGUSER" to creds.user,
                "PGPASSWORD" to creds.password,
                "PGDATABASE" to creds.database,
                "PGSSLMODE" to creds.sslMode
            )

            val cmd = mutableListOf("dataloader")
            if (force.getOrElse(false)) cmd.add("-f")
            cmd.addAll(listOf("-d", pkgDir.absolutePath))

            logger.lifecycle("${name}: Running ${cmd.joinToString(" ")}")
            val dl = ProcessBuilder(cmd)
                .directory(pkgDir)
                .redirectErrorStream(true)
                .apply { environment().putAll(pgEnv) }
                .start()

            val output = StringBuilder()
            dl.inputStream.bufferedReader().forEachLine { line ->
                logger.lifecycle("  [dataloader] $line")
                output.appendLine(line)
            }
            val exit = dl.waitFor()

            if (displayLogPath.isPresent) {
                val logFile = displayLogPath.get().asFile
                logFile.parentFile.mkdirs()
                logFile.writeText(output.toString())
            }

            if (exit != 0) {
                throw GradleException("${name}: dataloader exited with code $exit\n$output")
            }
            logger.lifecycle("${name}: dataloader completed successfully")
        } finally {
            // ── 3: Best-effort delete via dataloader-service ──
            //   On failure the branch will still self-clean at expires_at.
            logger.lifecycle("${name}: Deleting branch ${creds.branchId}")
            try {
                ExecUtils.exec(
                    command = listOf(
                        "curl", "-s", "--fail-with-body", "-X", "DELETE",
                        "-H", "Authorization: APIKey $token",
                        "$SERVICE_BASE_URL/branches/${creds.branchId}"
                    ),
                    workingDir = workingDir,
                    throwOnError = false
                )
            } catch (e: Exception) {
                logger.warn("${name}: Failed to delete branch ${creds.branchId}: ${e.message}")
            }
        }
    }

    // ── Internal ─────────────────────────────────────────────────────

    private data class BranchCreds(
        val branchId: String,
        val branchName: String,
        val host: String,
        val port: Int,
        val user: String,
        val password: String,
        val database: String,
        val sslMode: String,
        val expiresAt: String
    )

    private fun buildCreateBody(name: String, parent: String?, ttl: Int?): String {
        val fields = mutableListOf("\"name\":${jsonString(name)}")
        if (parent != null) fields.add("\"parentBranch\":${jsonString(parent)}")
        if (ttl != null) fields.add("\"ttlSeconds\":$ttl")
        return "{${fields.joinToString(",")}}"
    }

    private fun jsonString(s: String): String =
        "\"${s.replace("\\", "\\\\").replace("\"", "\\\"")}\""

    private fun parseBranchCredentials(json: String): BranchCreds {
        fun str(field: String) = Regex(""""$field"\s*:\s*"([^"]+)"""").find(json)?.groupValues?.get(1)
            ?: throw GradleException("${name}: dataloader-service response missing '$field':\n$json")
        fun int(field: String) = Regex(""""$field"\s*:\s*(\d+)""").find(json)?.groupValues?.get(1)?.toInt()
            ?: throw GradleException("${name}: dataloader-service response missing '$field':\n$json")
        return BranchCreds(
            branchId = str("branchId"),
            branchName = str("branchName"),
            host = str("host"),
            port = int("port"),
            user = str("user"),
            password = str("password"),
            database = str("database"),
            sslMode = str("sslMode"),
            expiresAt = str("expiresAt")
        )
    }

    /**
     * Run a curl command with retries on transient failures. The dataloader-service
     * call still goes through ALB/EKS so the same flakiness story as direct Neon
     * applies — retry with exponential backoff + jitter.
     *
     * On failure, surfaces both the response body (curl stdout, preserved by
     * --fail-with-body) and curl's own stderr in the GradleException so a 401 /
     * 403 / 5xx error from dataloader-service is visible in the gradle log.
     */
    private fun curlWithRetry(baseCommand: List<String>, workingDir: File, attempts: Int = 5): String {
        val command = mutableListOf(baseCommand[0])
        // Plain --retry only retries on transient errors (5xx/408/429/connection).
        // We deliberately omit --retry-all-errors so curl doesn't waste retries on
        // 4xx responses that won't get better — those need to fail fast.
        command.addAll(listOf("--retry", "5", "--retry-delay", "2"))
        command.addAll(baseCommand.drop(1))

        var lastErr: String? = null
        for (attempt in 1..attempts) {
            val pb = ProcessBuilder(command).directory(workingDir)
            val process = pb.start()
            val stdoutFuture = java.util.concurrent.CompletableFuture.supplyAsync {
                process.inputStream.bufferedReader().readText()
            }
            val stderrFuture = java.util.concurrent.CompletableFuture.supplyAsync {
                process.errorStream.bufferedReader().readText()
            }
            val stdout = stdoutFuture.join()
            val stderr = stderrFuture.join()
            val exit = process.waitFor()

            if (exit == 0) return stdout

            lastErr = buildString {
                append("exit=").append(exit)
                if (stdout.isNotBlank()) append("\n  response body: ").append(stdout.trim().take(2000))
                if (stderr.isNotBlank()) append("\n  curl stderr  : ").append(stderr.trim().take(500))
            }

            // Don't retry on auth failures — ZB_TOKEN won't fix itself by waiting.
            if (stderr.contains("error: 401") || stdout.contains("\"statusCode\":401")) {
                throw GradleException(
                    "${name}: dataloader-service returned 401 Unauthenticated. " +
                    "ZB_TOKEN may be invalid, expired, or for the wrong environment.\n$lastErr"
                )
            }
            if (stderr.contains("error: 403") || stdout.contains("\"statusCode\":403")) {
                throw GradleException(
                    "${name}: dataloader-service returned 403 Forbidden. " +
                    "ZB_TOKEN authenticated but lacks permission to call /branches.\n$lastErr"
                )
            }

            if (attempt == attempts) break
            val backoffMs = (1000L * (1 shl attempt)) + Random.nextLong(500L, 1500L)
            logger.lifecycle(
                "${name}: curl attempt $attempt/$attempts failed — retrying in ${backoffMs / 1000}s\n$lastErr"
            )
            Thread.sleep(backoffMs)
        }
        throw GradleException("${name}: curl failed after $attempts attempts:\n$lastErr")
    }

    private fun readPackageNameVersion(pkgJson: File): Pair<String, String> {
        require(pkgJson.isFile) { "package.json not found: ${pkgJson.absolutePath}" }
        val content = pkgJson.readText()
        val name = Regex(""""name"\s*:\s*"([^"]+)"""").find(content)?.groupValues?.get(1)
            ?: throw GradleException("Cannot find 'name' in ${pkgJson.absolutePath}")
        val version = Regex(""""version"\s*:\s*"([^"]+)"""").find(content)?.groupValues?.get(1)
            ?: throw GradleException("Cannot find 'version' in ${pkgJson.absolutePath}")
        return name to version
    }

    companion object {
        // TODO: switch back to https://app.zerobias.com/api/dataloader once dev validation is done
        private const val SERVICE_BASE_URL = "https://ci.zerobias.com/api/dataloader"
    }
}
