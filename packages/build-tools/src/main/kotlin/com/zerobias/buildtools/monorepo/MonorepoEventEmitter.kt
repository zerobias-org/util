package com.zerobias.buildtools.monorepo

import org.gradle.api.provider.Property
import org.gradle.api.services.BuildService
import org.gradle.api.services.BuildServiceParameters
import org.gradle.tooling.events.FailureResult
import org.gradle.tooling.events.FinishEvent
import org.gradle.tooling.events.OperationCompletionListener
import org.gradle.tooling.events.SkippedResult
import org.gradle.tooling.events.SuccessResult
import org.gradle.tooling.events.task.TaskFinishEvent
import org.gradle.tooling.events.task.TaskSuccessResult
import java.io.File
import java.io.PrintWriter
import java.util.concurrent.ConcurrentHashMap

/**
 * Emits JSON-line events for monorepo tasks (per-package phases like lint,
 * transpile, test, dockerBuild) to a side channel that zbb tails for the
 * project-centric TTY display (Phase 2.7).
 *
 * Events format (one JSON object per line):
 *
 *   {"event":"task_start","project":":packages:foo","step":"transpile","ts":12345}
 *   {"event":"task_done","project":":packages:foo","step":"transpile","status":"passed","durationMs":1234,"ts":12346}
 *
 * Status values: passed | failed | skipped
 *
 * Output sink: file path from `eventFilePath` parameter (defaulting to
 * `<repo>/.zbb-monorepo/events.jsonl`). The file is preserved between runs
 * for post-mortem inspection.
 *
 * Thread-safety: PrintWriter wraps a synchronized file output stream so
 * concurrent task hooks can write safely. Each event is one line, written
 * atomically with autoFlush.
 */
abstract class MonorepoEventEmitter : BuildService<MonorepoEventEmitter.Params>,
    OperationCompletionListener, AutoCloseable {

    interface Params : BuildServiceParameters {
        val eventFilePath: Property<String>
    }

    private val writer: PrintWriter? by lazy {
        val path = parameters.eventFilePath.orNull
        if (path.isNullOrEmpty()) return@lazy null
        try {
            val file = File(path)
            file.parentFile?.mkdirs()
            // Truncate-on-open: each Gradle invocation gets a fresh event log
            // (the file is preserved AFTER the run for inspection, but we
            // don't want stale events from a previous build mixed in).
            PrintWriter(file.outputStream().buffered(), true)  // autoFlush=true
        } catch (_: Exception) {
            null
        }
    }

    /** Track start times so we can include duration in finish events. */
    private val startTimes = ConcurrentHashMap<String, Long>()

    fun isEnabled(): Boolean = writer != null

    /**
     * Emit a task_start event. Called from a doFirst hook on each tracked task.
     */
    fun emitStart(projectPath: String, taskName: String) {
        val w = writer ?: return
        val key = "$projectPath:$taskName"
        val now = System.currentTimeMillis()
        startTimes[key] = now
        synchronized(w) {
            w.println(jsonLine(
                "event" to "task_start",
                "project" to projectPath,
                "step" to taskName,
                "ts" to now,
            ))
        }
    }

    /**
     * OperationCompletionListener implementation: receives task finish events.
     */
    override fun onFinish(event: FinishEvent) {
        if (event !is TaskFinishEvent) return
        val taskPath = event.descriptor.taskPath  // e.g. ":packages:foo:transpile"
        val (projectPath, taskName) = splitTaskPath(taskPath) ?: return

        val w = writer ?: return
        val result = event.result
        val status = when {
            result is SkippedResult -> "skipped"
            result is FailureResult -> "failed"
            result is TaskSuccessResult && result.isUpToDate -> "up-to-date"
            result is TaskSuccessResult && result.isFromCache -> "from-cache"
            result is SuccessResult -> "passed"
            else -> "unknown"
        }

        val key = "$projectPath:$taskName"
        val startedAt = startTimes.remove(key)
        val durationMs = if (startedAt != null) {
            System.currentTimeMillis() - startedAt
        } else {
            // Derive from event timestamps if we missed the start hook
            (event.result.endTime - event.result.startTime)
        }

        synchronized(w) {
            w.println(jsonLine(
                "event" to "task_done",
                "project" to projectPath,
                "step" to taskName,
                "status" to status,
                "durationMs" to durationMs,
                "ts" to System.currentTimeMillis(),
            ))
        }
    }

    override fun close() {
        writer?.close()
    }

    // ── Helpers ──────────────────────────────────────────────────────

    /**
     * Split ":packages:foo:transpile" into (":packages:foo", "transpile").
     * Returns null for invalid paths.
     */
    private fun splitTaskPath(taskPath: String): Pair<String, String>? {
        val lastColon = taskPath.lastIndexOf(':')
        if (lastColon <= 0) return null
        val projectPath = taskPath.substring(0, lastColon)
        val taskName = taskPath.substring(lastColon + 1)
        return projectPath to taskName
    }

    /**
     * Build a single JSON line. Hand-rolled to avoid Jackson init cost in the
     * critical path of every task event.
     */
    private fun jsonLine(vararg pairs: Pair<String, Any>): String {
        val sb = StringBuilder("{")
        for ((i, pair) in pairs.withIndex()) {
            if (i > 0) sb.append(',')
            sb.append('"').append(pair.first).append("\":")
            when (val v = pair.second) {
                is String -> sb.append('"').append(escapeJson(v)).append('"')
                is Number -> sb.append(v.toString())
                else -> sb.append('"').append(escapeJson(v.toString())).append('"')
            }
        }
        sb.append('}')
        return sb.toString()
    }

    private fun escapeJson(s: String): String {
        val sb = StringBuilder(s.length + 8)
        for (c in s) {
            when (c) {
                '"' -> sb.append("\\\"")
                '\\' -> sb.append("\\\\")
                '\n' -> sb.append("\\n")
                '\r' -> sb.append("\\r")
                '\t' -> sb.append("\\t")
                else -> if (c.code < 0x20) {
                    sb.append("\\u%04x".format(c.code))
                } else {
                    sb.append(c)
                }
            }
        }
        return sb.toString()
    }
}
