package com.zerobias.buildtools.tasks

import com.zerobias.buildtools.util.ExecUtils
import org.gradle.api.DefaultTask
import org.gradle.api.GradleException
import org.gradle.api.file.DirectoryProperty
import org.gradle.api.tasks.InputDirectory
import org.gradle.api.tasks.Optional
import org.gradle.api.tasks.TaskAction
import java.io.File
import kotlin.random.Random

/**
 * Gradle task that runs the platform `dataloader` CLI against an ephemeral
 * Neon Postgres branch, created on-the-fly via the Neon API.
 *
 * Mirrors the logic inlined in `zb.typescript.gradle.kts:testDataloaderExec`
 * so content and module plugins can share a single implementation.
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
 * Usage:
 *   tasks.register<NeonDataloaderTask>("testIntegrationDataloader") {
 *       packageDir.set(layout.projectDirectory)
 *   }
 */
abstract class NeonDataloaderTask : DefaultTask() {

    @get:InputDirectory
    @get:Optional
    abstract val packageDir: DirectoryProperty

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

            logger.lifecycle("${name}: Running dataloader -d ${pkgDir.absolutePath}")
            val dl = ProcessBuilder(listOf("dataloader", "-d", pkgDir.absolutePath))
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
            if (exit != 0) {
                throw GradleException("${name}: dataloader exited with code $exit\n$output")
            }
            logger.lifecycle("${name}: dataloader completed successfully")
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
}
