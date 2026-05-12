package com.zerobias.buildtools.tasks

import com.zerobias.buildtools.util.ExecUtils
import com.zerobias.buildtools.util.PathConstants.ZBB_GRADLE_DIR
import org.gradle.api.Action
import org.gradle.api.DefaultTask
import org.gradle.api.GradleException
import org.gradle.api.Project
import org.gradle.api.file.DirectoryProperty
import org.gradle.api.file.RegularFileProperty
import org.gradle.api.provider.ListProperty
import org.gradle.api.provider.Property
import org.gradle.api.tasks.Input
import org.gradle.api.tasks.InputDirectory
import org.gradle.api.tasks.Internal
import org.gradle.api.tasks.Optional
import org.gradle.api.tasks.OutputFile
import org.gradle.api.tasks.TaskAction
import org.gradle.api.tasks.TaskProvider
import java.io.File
import kotlin.random.Random

/**
 * Gradle task that runs the platform `dataloader` CLI against an ephemeral
 * Neon Postgres branch, created on-the-fly via the Neon API.
 *
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │ TODO(dataloader-service): RE-ENABLE NEW PATH WHEN PROD SERVICE IS UP    │
 * │                                                                         │
 * │ This file used to talk to a platform `dataloader-service` that owns     │
 * │ the Neon API key and provisions branches with an `expires_at`           │
 * │ backstop. That service is not yet deployed to prod, so the new code     │
 * │ path is COMMENTED OUT below and we've reverted to talking to the Neon   │
 * │ API directly (the path that has worked in CI for months).               │
 * │                                                                         │
 * │ Search this file for `TODO(dataloader-service)` to find every block    │
 * │ that needs to be uncommented — and the matching active code that       │
 * │ should be deleted — when prod cutover is ready.                        │
 * │                                                                         │
 * │ Cutover steps when prod is ready:                                       │
 * │   1. Uncomment every `/* TODO(dataloader-service) ... */` block.       │
 * │   2. Delete the active direct-Neon `executeDirectNeon()` body and let  │
 * │      `execute()` call `executeViaDataloaderService()` directly.        │
 * │   3. Drop NEON_API_KEY / NEON_PROJECT_ID from zbb.yaml vault refs.     │
 * └─────────────────────────────────────────────────────────────────────────┘
 *
 * Required env (resolved from the slot via vault refs in each plugin's
 * zbb.yaml):
 *   NEON_API_KEY          — Neon Cloud API key
 *   NEON_PROJECT_ID       — Neon project that owns the parent branch
 *
 * Optional env (with defaults matching the content-release workflow):
 *   NEON_PARENT_BRANCH    — default "content-master"
 *   NEON_DB_ROLE          — default "neondb_owner"
 *   NEON_DB_NAME          — default "zerobias"
 *
 * Skips cleanly (no failure) when NEON_API_KEY is not set — lets local dev
 * without vault proceed without blowing up gate. CI jobs that require
 * dataloader validation must ensure the slot exposes NEON_API_KEY.
 *
 * Usage: leaf plugins call the [registerDataloader] helper at the bottom
 * of this file, NOT `tasks.register<NeonDataloaderTask>(...)` directly,
 * so name + log-path conventions stay consistent across plugin types
 * and the EventEmitter display map only needs one entry.
 */
abstract class NeonDataloaderTask : DefaultTask() {

    @get:InputDirectory
    @get:Optional
    abstract val packageDir: DirectoryProperty

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
     * matches the `.zbb-gradle/logs/<task>.log` convention used by other
     * Exec tasks so zbb's failure reporter finds the log.
     */
    @get:OutputFile
    @get:Optional
    abstract val displayLogPath: RegularFileProperty

    /**
     * Optional callbacks invoked AFTER the dataloader load succeeds and
     * BEFORE the Neon branch is torn down. Each action receives a
     * [NeonBranchContext] with the live PG env, so it can run additional
     * tools (codegen, validators) against the loaded schema while the
     * branch is still alive.
     *
     * Used by `zb.schema` to generate TS interface twins from the loaded
     * dataloader output. If an action throws, the exception propagates —
     * the branch still tears down in `finally`, and the task fails.
     *
     * Empty by default; existing zb.content / zb.typescript-* consumers
     * are unaffected.
     */
    @get:Internal
    abstract val postLoadActions: ListProperty<Action<NeonBranchContext>>

    /* TODO(dataloader-service): UNCOMMENT — service-mode-only inputs.
     *
     * Re-enable these Property declarations when re-enabling
     * executeViaDataloaderService() below. They are unused by the current
     * direct-Neon path (parent branch comes from NEON_PARENT_BRANCH env;
     * the test branch name is derived from package.json; Neon branches have
     * no TTL).
     *
     * /**
     *  * Identifier for this run. The service prepends `test/` and appends a
     *  * timestamp, so the final branch name is `test/{testName}-{epochMs}`.
     *  * Defaults to the package.json `name` with `@` stripped and `/` → `-`.
     *  */
     * @get:Input
     * @get:Optional
     * abstract val testName: Property<String>
     *
     * /**
     *  * Optional parent branch name (default branch the new branch is forked
     *  * from). When unset, the service uses its configured default
     *  * (typically `content-master`).
     *  */
     * @get:Input
     * @get:Optional
     * abstract val parentBranch: Property<String>
     *
     * /**
     *  * Backstop expiry in seconds. If unset, the service uses its default
     *  * (10800 = 3h).
     *  */
     * @get:Input
     * @get:Optional
     * abstract val ttlSeconds: Property<Int>
     */

    init {
        group = "lifecycle"
        description = "Run dataloader against an ephemeral Neon branch"
        // Fresh Neon branch every invocation; no sensible up-to-date signal.
        outputs.upToDateWhen { false }
        // onlyIf: skip entirely when Neon credentials aren't available.
        onlyIf {
            val hasNeon = System.getenv("NEON_API_KEY")?.isNotBlank() == true
            if (!hasNeon) {
                logger.lifecycle("${name}: NEON_API_KEY not set — skipping")
            }
            hasNeon
        }
    }

    @TaskAction
    fun execute() {
        // TODO(dataloader-service): when prod is up, replace this body with
        //   `executeViaDataloaderService()` (uncommented below) and delete
        //   `executeDirectNeon()` and its helpers.
        executeDirectNeon()
    }

    // ════════════════════════════════════════════════════════════════════
    // DIRECT NEON API PATH — the path that works today.
    //
    // Talks straight to console.neon.tech using NEON_API_KEY +
    // NEON_PROJECT_ID. Restored from main; honors `force` and
    // `displayLogPath` so the typescript wiring (force=true, log path) keeps
    // working.
    // ════════════════════════════════════════════════════════════════════

    private fun executeDirectNeon() {
        val pkgDir: File = if (packageDir.isPresent) packageDir.get().asFile else project.projectDir
        val workingDir = project.projectDir

        val neonApiKey = System.getenv("NEON_API_KEY")
            ?: throw GradleException("NEON_API_KEY not set — configure vault source in zbb.yaml")
        val neonProjectId = System.getenv("NEON_PROJECT_ID")
            ?: throw GradleException("NEON_PROJECT_ID not set — configure vault source in zbb.yaml")
        val parentBranch = System.getenv("NEON_PARENT_BRANCH") ?: "content-master"
        val dbRole = System.getenv("NEON_DB_ROLE") ?: "neondb_owner"
        val dbName = System.getenv("NEON_DB_NAME") ?: "zerobias"

        val (moduleName, _) = readPackageNameVersion(File(pkgDir, "package.json"))
        val branchName = "test/${moduleName.replace("@", "").replace("/", "-")}-${System.currentTimeMillis()}"

        // ── 1a: Resolve parent branch ID by name ──
        logger.lifecycle("${name}: Looking up parent branch '$parentBranch'")
        val branchesJson = curlWithRetry(
            listOf(
                "curl", "-sf",
                "-H", "Authorization: Bearer $neonApiKey",
                "https://console.neon.tech/api/v2/projects/$neonProjectId/branches"
            ),
            workingDir
        )
        val parentId = findParentBranchId(branchesJson, parentBranch)
            ?: throw GradleException("${name}: Parent branch '$parentBranch' not found in project $neonProjectId")
        logger.lifecycle("${name}: Parent branch ID = $parentId")

        // ── 1b: Create child branch ──
        logger.lifecycle("${name}: Creating Neon branch '$branchName' from '$parentBranch'")
        val createPayload =
            """{"branch":{"name":"$branchName","parent_id":"$parentId"},"endpoints":[{"type":"read_write","suspend_timeout_seconds":300}]}"""
        val createOutput = curlWithRetry(
            listOf(
                "curl", "-sf",
                "-H", "Authorization: Bearer $neonApiKey",
                "-H", "Content-Type: application/json",
                "-X", "POST",
                "-d", createPayload,
                "https://console.neon.tech/api/v2/projects/$neonProjectId/branches"
            ),
            workingDir
        )

        val branchId = Regex(""""id"\s*:\s*"(br-[^"]+)"""").find(createOutput)?.groupValues?.get(1)
            ?: throw GradleException("${name}: Failed to parse branch ID from Neon response:\n$createOutput")
        val host = Regex(""""host"\s*:\s*"([^"]+)"""").find(createOutput)?.groupValues?.get(1)
            ?: throw GradleException("${name}: Failed to parse endpoint host from Neon response:\n$createOutput")

        // ── 1c: Reveal role password ──
        val passwordJson = curlWithRetry(
            listOf(
                "curl", "-sf",
                "-H", "Authorization: Bearer $neonApiKey",
                "https://console.neon.tech/api/v2/projects/$neonProjectId/branches/$branchId/roles/$dbRole/reveal_password"
            ),
            workingDir
        )
        val password = Regex(""""password"\s*:\s*"([^"]+)"""").find(passwordJson)?.groupValues?.get(1)
            ?: throw GradleException("${name}: Failed to read password for role $dbRole")

        logger.lifecycle("${name}: Neon branch ready")
        logger.lifecycle("  PGHOST     = $host")
        logger.lifecycle("  PGPORT     = 5432")
        logger.lifecycle("  PGUSER     = $dbRole")
        logger.lifecycle("  PGDATABASE = $dbName")
        logger.lifecycle("  PGSSLMODE  = require")

        try {
            // ── 2: Run dataloader against the branch ──
            val pgEnv = mapOf(
                "PGHOST" to host,
                "PGPORT" to "5432",
                "PGUSER" to dbRole,
                "PGPASSWORD" to password,
                "PGDATABASE" to dbName,
                "PGSSLMODE" to "require"
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

            // ── 2b: Post-load actions (e.g. zb.schema TS twin gen) ──
            // Fire AFTER dataloader load succeeds. Branch is still alive;
            // PG env still valid. If an action throws the exception
            // propagates and finally still tears the branch down.
            val actions = postLoadActions.getOrElse(emptyList())
            if (actions.isNotEmpty()) {
                logger.lifecycle("${name}: running ${actions.size} post-load action(s)")
                val ctx = NeonBranchContext(
                    project = project,
                    packageDir = pkgDir,
                    pgEnv = pgEnv,
                )
                actions.forEach { action -> action.execute(ctx) }
            }
        } finally {
            // ── 3: Delete the Neon branch (best effort) ──
            logger.lifecycle("${name}: Deleting Neon branch '$branchName'")
            try {
                ExecUtils.exec(
                    command = listOf(
                        "curl", "-sf", "-X", "DELETE",
                        "-H", "Authorization: Bearer $neonApiKey",
                        "https://console.neon.tech/api/v2/projects/$neonProjectId/branches/$branchId"
                    ),
                    workingDir = workingDir,
                    throwOnError = false
                )
            } catch (e: Exception) {
                logger.warn("${name}: Failed to delete Neon branch $branchId: ${e.message}")
            }
        }
    }

    // ── Internal ─────────────────────────────────────────────────────

    /**
     * Run a curl command with retries on transient failures. Neon's API
     * under parallel load returns curl exit 56 (connection reset / receive
     * failure) intermittently — retry with exponential backoff + jitter.
     *
     * `-sf` already makes curl silent + fail-on-4xx/5xx; we retry both
     * curl-level transient errors and HTTP 429/5xx by also adding curl's
     * own --retry flag to the command. On top of that we retry at the
     * exec level since curl's --retry doesn't cover all exit codes.
     */
    private fun curlWithRetry(baseCommand: List<String>, workingDir: File, attempts: Int = 5): String {
        // Inject curl's own retry flags (covers 408/429/5xx + connection
        // refused/reset). First arg after "curl" keeps the command shape
        // readable in error messages.
        val command = mutableListOf(baseCommand[0])
        command.addAll(listOf("--retry", "5", "--retry-delay", "2", "--retry-all-errors"))
        command.addAll(baseCommand.drop(1))

        var lastErr: Exception? = null
        for (attempt in 1..attempts) {
            try {
                return ExecUtils.execCapture(
                    command = command,
                    workingDir = workingDir,
                    throwOnError = true
                )
            } catch (e: Exception) {
                lastErr = e
                if (attempt == attempts) break
                // Exponential backoff with jitter: 2s, 4s, 8s, 16s
                val backoffMs = (1000L * (1 shl attempt)) + Random.nextLong(500L, 1500L)
                logger.lifecycle(
                    "${name}: curl attempt $attempt/$attempts failed (${e.message?.take(80)}...) — " +
                    "retrying in ${backoffMs / 1000}s"
                )
                Thread.sleep(backoffMs)
            }
        }
        throw GradleException("${name}: curl failed after $attempts attempts: ${lastErr?.message}", lastErr)
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

    /**
     * Parse the Neon /branches response and find the branch with the given
     * name. Neon's JSON isn't necessarily ordered {id, name} — try both
     * orderings.
     */
    private fun findParentBranchId(json: String, parentBranch: String): String? {
        val pattern1 = Regex(""""id"\s*:\s*"(br-[^"]+)"[^}]*?"name"\s*:\s*"${Regex.escape(parentBranch)}"""")
        val pattern2 = Regex(""""name"\s*:\s*"${Regex.escape(parentBranch)}"[^}]*?"id"\s*:\s*"(br-[^"]+)"""")
        return pattern1.find(json)?.groupValues?.get(1)
            ?: pattern2.find(json)?.groupValues?.get(1)
    }

    /* ════════════════════════════════════════════════════════════════════
     * TODO(dataloader-service): UNCOMMENT TO RE-ENABLE
     *
     * Everything below this line is the dataloader-service-routed path that
     * we want to switch to once the service is deployed to prod. Today it
     * lives behind a comment so the rest of the branch can merge.
     *
     * To re-enable:
     *   1. Strip the `/* */` wrapper around this whole block AND around the
     *      testName/parentBranch/ttlSeconds Property declarations near the
     *      top of the class.
     *   2. In `execute()`, replace the call to `executeDirectNeon()` with
     *      `executeViaDataloaderService()`.
     *   3. Delete `executeDirectNeon()`, `curlWithRetry`, and
     *      `findParentBranchId` (no longer needed once we don't talk to
     *      Neon directly).
     *   4. Update the file's KDoc to drop NEON_API_KEY / NEON_PROJECT_ID
     *      and document ZB_TOKEN as the only credential.
     * ════════════════════════════════════════════════════════════════════
     *
     * private fun executeViaDataloaderService() {
     *     val pkgDir: File = if (packageDir.isPresent) packageDir.get().asFile else project.projectDir
     *     val workingDir = project.projectDir
     *
     *     val token = System.getenv("ZB_TOKEN")?.takeIf { it.isNotBlank() }
     *         ?: throw GradleException(
     *             "${name}: ZB_TOKEN is not set. testDataloader requires ZB_TOKEN " +
     *             "for ZeroBias production authentication against the dataloader-service /branches endpoint."
     *         )
     *
     *     val resolvedTestName = (testName.orNull?.takeIf { it.isNotBlank() } ?: run {
     *         val (pkgName, _) = readPackageNameVersion(File(pkgDir, "package.json"))
     *         pkgName.replace("@", "").replace("/", "-")
     *     }).replace(Regex("[^a-zA-Z0-9_-]"), "-")
     *
     *     // ── 1: Ask dataloader-service for an ephemeral branch ──
     *     val createBody = buildCreateBody(resolvedTestName, parentBranch.orNull, ttlSeconds.orNull)
     *     logger.lifecycle("${name}: Requesting Neon branch via dataloader-service for '$resolvedTestName'")
     *     val createOutput = curlWithRetryDetailed(
     *         listOf(
     *             "curl", "-s", "--fail-with-body",
     *             "-H", "Authorization: APIKey $token",
     *             "-H", "Content-Type: application/json",
     *             "-X", "POST",
     *             "-d", createBody,
     *             "$SERVICE_BASE_URL/branches"
     *         ),
     *         workingDir
     *     )
     *
     *     val creds = parseBranchCredentials(createOutput)
     *     logger.lifecycle("${name}: Neon branch ready")
     *     logger.lifecycle("  branchId   = ${creds.branchId}")
     *     logger.lifecycle("  branchName = ${creds.branchName}")
     *     logger.lifecycle("  PGHOST     = ${creds.host}")
     *     logger.lifecycle("  PGPORT     = ${creds.port}")
     *     logger.lifecycle("  PGUSER     = ${creds.user}")
     *     logger.lifecycle("  PGDATABASE = ${creds.database}")
     *     logger.lifecycle("  PGSSLMODE  = ${creds.sslMode}")
     *     logger.lifecycle("  expiresAt  = ${creds.expiresAt}")
     *
     *     try {
     *         // ── 2: Run dataloader against the branch ──
     *         val pgEnv = mapOf(
     *             "PGHOST" to creds.host,
     *             "PGPORT" to creds.port.toString(),
     *             "PGUSER" to creds.user,
     *             "PGPASSWORD" to creds.password,
     *             "PGDATABASE" to creds.database,
     *             "PGSSLMODE" to creds.sslMode
     *         )
     *
     *         val cmd = mutableListOf("dataloader")
     *         if (force.getOrElse(false)) cmd.add("-f")
     *         cmd.addAll(listOf("-d", pkgDir.absolutePath))
     *
     *         logger.lifecycle("${name}: Running ${cmd.joinToString(" ")}")
     *         val dl = ProcessBuilder(cmd)
     *             .directory(pkgDir)
     *             .redirectErrorStream(true)
     *             .apply { environment().putAll(pgEnv) }
     *             .start()
     *
     *         val output = StringBuilder()
     *         dl.inputStream.bufferedReader().forEachLine { line ->
     *             logger.lifecycle("  [dataloader] $line")
     *             output.appendLine(line)
     *         }
     *         val exit = dl.waitFor()
     *
     *         if (displayLogPath.isPresent) {
     *             val logFile = displayLogPath.get().asFile
     *             logFile.parentFile.mkdirs()
     *             logFile.writeText(output.toString())
     *         }
     *
     *         if (exit != 0) {
     *             throw GradleException("${name}: dataloader exited with code $exit\n$output")
     *         }
     *         logger.lifecycle("${name}: dataloader completed successfully")
     *     } finally {
     *         // ── 3: Best-effort delete via dataloader-service ──
     *         //   On failure the branch will still self-clean at expires_at.
     *         logger.lifecycle("${name}: Deleting branch ${creds.branchId}")
     *         try {
     *             ExecUtils.exec(
     *                 command = listOf(
     *                     "curl", "-s", "--fail-with-body", "-X", "DELETE",
     *                     "-H", "Authorization: APIKey $token",
     *                     "$SERVICE_BASE_URL/branches/${creds.branchId}"
     *                 ),
     *                 workingDir = workingDir,
     *                 throwOnError = false
     *             )
     *         } catch (e: Exception) {
     *             logger.warn("${name}: Failed to delete branch ${creds.branchId}: ${e.message}")
     *         }
     *     }
     * }
     *
     * private data class BranchCreds(
     *     val branchId: String,
     *     val branchName: String,
     *     val host: String,
     *     val port: Int,
     *     val user: String,
     *     val password: String,
     *     val database: String,
     *     val sslMode: String,
     *     val expiresAt: String
     * )
     *
     * private fun buildCreateBody(name: String, parent: String?, ttl: Int?): String {
     *     val fields = mutableListOf("\"name\":${jsonString(name)}")
     *     if (parent != null) fields.add("\"parentBranch\":${jsonString(parent)}")
     *     if (ttl != null) fields.add("\"ttlSeconds\":$ttl")
     *     return "{${fields.joinToString(",")}}"
     * }
     *
     * private fun jsonString(s: String): String =
     *     "\"${s.replace("\\", "\\\\").replace("\"", "\\\"")}\""
     *
     * private fun parseBranchCredentials(json: String): BranchCreds {
     *     fun str(field: String) = Regex(""""$field"\s*:\s*"([^"]+)"""").find(json)?.groupValues?.get(1)
     *         ?: throw GradleException("${name}: dataloader-service response missing '$field':\n$json")
     *     fun int(field: String) = Regex(""""$field"\s*:\s*(\d+)""").find(json)?.groupValues?.get(1)?.toInt()
     *         ?: throw GradleException("${name}: dataloader-service response missing '$field':\n$json")
     *     return BranchCreds(
     *         branchId = str("branchId"),
     *         branchName = str("branchName"),
     *         host = str("host"),
     *         port = int("port"),
     *         user = str("user"),
     *         password = str("password"),
     *         database = str("database"),
     *         sslMode = str("sslMode"),
     *         expiresAt = str("expiresAt")
     *     )
     * }
     *
     * /**
     *  * Service-mode curl-with-retry. Captures stderr separately so 401/403/5xx
     *  * responses from dataloader-service are visible in the gradle log.
     *  * Stops retrying immediately on auth failures (ZB_TOKEN issues won't
     *  * fix themselves by waiting).
     *  */
     * private fun curlWithRetryDetailed(baseCommand: List<String>, workingDir: File, attempts: Int = 5): String {
     *     val command = mutableListOf(baseCommand[0])
     *     // Plain --retry only retries on transient errors (5xx/408/429/connection).
     *     // We deliberately omit --retry-all-errors so curl doesn't waste retries on
     *     // 4xx responses that won't get better — those need to fail fast.
     *     command.addAll(listOf("--retry", "5", "--retry-delay", "2"))
     *     command.addAll(baseCommand.drop(1))
     *
     *     var lastErr: String? = null
     *     for (attempt in 1..attempts) {
     *         val pb = ProcessBuilder(command).directory(workingDir)
     *         val process = pb.start()
     *         val stdoutFuture = java.util.concurrent.CompletableFuture.supplyAsync {
     *             process.inputStream.bufferedReader().readText()
     *         }
     *         val stderrFuture = java.util.concurrent.CompletableFuture.supplyAsync {
     *             process.errorStream.bufferedReader().readText()
     *         }
     *         val stdout = stdoutFuture.join()
     *         val stderr = stderrFuture.join()
     *         val exit = process.waitFor()
     *
     *         if (exit == 0) return stdout
     *
     *         lastErr = buildString {
     *             append("exit=").append(exit)
     *             if (stdout.isNotBlank()) append("\n  response body: ").append(stdout.trim().take(2000))
     *             if (stderr.isNotBlank()) append("\n  curl stderr  : ").append(stderr.trim().take(500))
     *         }
     *
     *         // Don't retry on auth failures — ZB_TOKEN won't fix itself by waiting.
     *         if (stderr.contains("error: 401") || stdout.contains("\"statusCode\":401")) {
     *             throw GradleException(
     *                 "${name}: dataloader-service returned 401 Unauthenticated. " +
     *                 "ZB_TOKEN may be invalid, expired, or for the wrong environment.\n$lastErr"
     *             )
     *         }
     *         if (stderr.contains("error: 403") || stdout.contains("\"statusCode\":403")) {
     *             throw GradleException(
     *                 "${name}: dataloader-service returned 403 Forbidden. " +
     *                 "ZB_TOKEN authenticated but lacks permission to call /branches.\n$lastErr"
     *             )
     *         }
     *
     *         if (attempt == attempts) break
     *         val backoffMs = (1000L * (1 shl attempt)) + Random.nextLong(500L, 1500L)
     *         logger.lifecycle(
     *             "${name}: curl attempt $attempt/$attempts failed — retrying in ${backoffMs / 1000}s\n$lastErr"
     *         )
     *         Thread.sleep(backoffMs)
     *     }
     *     throw GradleException("${name}: curl failed after $attempts attempts:\n$lastErr")
     * }
     *
     * companion object {
     *     private const val SERVICE_BASE_URL = "https://app.zerobias.com/api/dataloader"
     * }
     */
}

/**
 * Canonical NeonDataloaderTask registration. Every leaf plugin
 * (zb.typescript / zb.typescript-collectorbot / zb.content) registers
 * exactly ONE worker named [DATALOADER_TASK_NAME] with the same conventions
 * (packageDir = projectDir, displayLog under .zbb-gradle/logs/), and then
 * wires it into whichever lifecycle phase its package type advertises:
 *
 *   - typescript modules + collectorbots: `tasks.named("testDataloader") { dependsOn(dataloaderExec) }`
 *   - content packages:                   `tasks.named("testIntegration") { dependsOn(dataloaderExec) }`
 *
 * Plugin-specific extras (force, mustRunAfter, postLoadActions, doFirst
 * spec-symlink, etc.) live in the [configure] block.
 *
 * One name across the codebase keeps the EventEmitter display map and
 * zbb's failure reporter trivial — no per-plugin aliasing, no drift.
 */
fun Project.registerDataloader(
    force: Boolean = false,
    configure: NeonDataloaderTask.() -> Unit = {},
): TaskProvider<NeonDataloaderTask> =
    tasks.register(DATALOADER_TASK_NAME, NeonDataloaderTask::class.java) {
        packageDir.set(layout.projectDirectory)
        this.force.set(force)
        val safeProjectName = path.removePrefix(":").replace(":", "-")
        displayLogPath.set(
            rootProject.layout.projectDirectory
                .file("$ZBB_GRADLE_DIR/logs/$safeProjectName-dataloader.log")
        )
        configure()
    }

const val DATALOADER_TASK_NAME = "dataloaderExec"
