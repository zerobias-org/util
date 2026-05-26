package com.zerobias.buildtools.util

import org.gradle.api.GradleException
import java.io.File
import java.util.concurrent.CompletableFuture
import kotlin.random.Random

/**
 * Shared curl-with-retry helper for build-tools tasks that talk to
 * platform services (dataloader-service /branches, /jobs; dana /me; etc.).
 *
 * Why this is its own helper:
 *   - Captures stdout and stderr separately so 401 / 403 / 5xx response
 *     bodies are visible in the gradle log (curl's `-s` swallows them otherwise).
 *   - Fast-fails on 401/403 — auth errors don't fix themselves by waiting,
 *     so we surface them immediately instead of burning the retry budget.
 *   - Adds curl's own `--retry 5 --retry-delay 2` flags on top of the
 *     outer Kotlin-level retry loop, so transient 5xx/connection errors
 *     get an extra layer of resilience without flooding the service.
 *
 * Used by [com.zerobias.buildtools.tasks.NeonDataloaderTask] and
 * [com.zerobias.buildtools.tasks.PublishOrgTask].
 */
object CurlUtils {

    /**
     * Run a curl command with retries and detailed error reporting.
     *
     * @param baseCommand curl command (caller supplies `curl` + flags +
     *   headers + URL; this function adds `--retry`/`--retry-delay`).
     * @param workingDir directory to run curl from.
     * @param label human-readable description of the call ("GET /me",
     *   "POST /branches") used in error messages.
     * @param attempts number of outer retry attempts (default 5).
     * @param onRetry optional callback invoked when a retry is scheduled,
     *   receives a one-line summary of the failure. Pass
     *   `{ msg -> logger.lifecycle(msg) }` to surface in gradle output.
     * @return stdout of the successful curl invocation.
     * @throws GradleException on 401/403 (immediately) or after exhausting
     *   all attempts.
     */
    fun withRetry(
        baseCommand: List<String>,
        workingDir: File,
        label: String,
        attempts: Int = 5,
        onRetry: ((String) -> Unit)? = null,
    ): String {
        val command = mutableListOf(baseCommand[0])
        // Plain --retry (no --retry-all-errors) so curl only retries transient
        // 5xx/408/429/connection errors and lets 4xx fail fast.
        command.addAll(listOf("--retry", "5", "--retry-delay", "2"))
        command.addAll(baseCommand.drop(1))

        var lastErr: String? = null
        for (attempt in 1..attempts) {
            val pb = ProcessBuilder(command).directory(workingDir)
            val process = pb.start()
            // Read stdout/stderr concurrently — sequential reads can
            // deadlock when either pipe buffer fills (typically 64KB on
            // Linux) before the read pipe closes.
            val stdoutFuture = CompletableFuture.supplyAsync {
                process.inputStream.bufferedReader().readText()
            }
            val stderrFuture = CompletableFuture.supplyAsync {
                process.errorStream.bufferedReader().readText()
            }
            val stdout = stdoutFuture.join()
            val stderr = stderrFuture.join()
            val exit = process.waitFor()

            if (exit == 0) return stdout

            lastErr = buildString {
                append("exit=").append(exit)
                if (stdout.isNotBlank()) append("\n  response body: ").append(stdout.trim().take(2000))
                if (stderr.isNotBlank()) append("\n  curl stderr:   ").append(stderr.trim().take(500))
            }

            if (stderr.contains("error: 401") || stdout.contains("\"statusCode\":401")) {
                throw GradleException(
                    "$label returned 401 Unauthenticated. " +
                    "Token may be invalid, expired, or for the wrong environment.\n$lastErr"
                )
            }
            if (stderr.contains("error: 403") || stdout.contains("\"statusCode\":403")) {
                throw GradleException(
                    "$label returned 403 Forbidden. " +
                    "Principal authenticated but lacks permission for this endpoint.\n$lastErr"
                )
            }

            if (attempt == attempts) break
            val backoffMs = (1000L * (1 shl attempt)) + Random.nextLong(500L, 1500L)
            onRetry?.invoke(
                "$label attempt $attempt/$attempts failed — retrying in ${backoffMs / 1000}s\n$lastErr"
            )
            Thread.sleep(backoffMs)
        }
        throw GradleException("$label failed after $attempts attempts:\n$lastErr")
    }
}
