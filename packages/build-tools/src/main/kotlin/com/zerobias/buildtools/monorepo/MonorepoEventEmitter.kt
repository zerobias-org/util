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

    /** Track which phases have already had phase_start emitted, so it's
     *  idempotent — callers can fire it multiple times and only the first
     *  one goes through. Needed because subproject tasks infer the phase
     *  from their task name and concurrently try to emit phase_start, but
     *  only one should win. */
    private val phasesStarted = java.util.concurrent.ConcurrentHashMap.newKeySet<String>()

    /**
     * Root-level monorepo tasks that should be reported as phases in the
     * display (distinct from per-package phase tasks). Anything not in this
     * set is ignored when it shows up as a root task — gradle has plenty of
     * internal root tasks (help, buildEnvironment, etc.) that would clutter
     * the display.
     */
    private val PHASE_TASK_NAMES = setOf(
        "monorepoBuild",
        "monorepoTest",
        "monorepoDockerBuild",
        "monorepoPublishDryRun",
        "monorepoPublish",
        "monorepoGate",
        "monorepoGateCheck",
        "monorepoClean",
    )

    /**
     * Map a subproject task name to the root phase it belongs to. Used to
     * infer the active phase from the first subproject task that starts —
     * gradle runs aggregator task actions AFTER their dependencies, so
     * doFirst on monorepoBuild itself fires at the END of the phase, not
     * the beginning. The display needs to show "monorepoBuild running" as
     * soon as the first lint/transpile task kicks off, so we piggyback on
     * the task_start event from those subproject tasks.
     */
    private fun subprojectTaskToPhase(taskName: String): String? = when (taskName) {
        // Build phase: anything that produces dist/ or compile output.
        "lint", "generate", "transpile",
        "npmLint", "npmGenerate", "npmTranspile", "npmBuild",
        "build", "jar", "classes", "compileJava", "compileKotlin",
        "stageBinJars", "copyDependencies",
        -> "monorepoBuild"

        // Test phase: anything that executes tests.
        "test", "npmTest", "check" -> "monorepoTest"

        // Docker phase: substack docker pipeline.
        "dockerBuild", "npmPack", "prepareDockerContext", "injectLocalDeps"
        -> "monorepoDockerBuild"

        else -> null
    }

    fun isEnabled(): Boolean = writer != null

    /**
     * Emit a task_start event. Called from a doFirst hook on each tracked task.
     *
     * Also opportunistically emits phase_start for the parent phase (if we
     * haven't yet), so the display can show the phase breadcrumb as soon as
     * the first subproject task actually begins running — NOT waiting until
     * the aggregator task's own doFirst fires (which happens at the end).
     */
    fun emitStart(projectPath: String, taskName: String) {
        val w = writer ?: return
        val key = "$projectPath:$taskName"
        val now = System.currentTimeMillis()
        startTimes[key] = now

        // Infer the parent phase and emit phase_start if not yet done.
        // This captures phases that have subproject task dependencies —
        // monorepoBuild, monorepoTest, monorepoDockerBuild — whose own
        // doFirst hooks would fire at the END of the phase.
        subprojectTaskToPhase(taskName)?.let { phase ->
            if (phasesStarted.add(phase)) {
                synchronized(w) {
                    startTimes["__phase:$phase"] = now
                    w.println(jsonLine(
                        "event" to "phase_start",
                        "phase" to phase,
                        "ts" to now,
                    ))
                }
            }
        }

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
     * Emit a phase_start event directly. Used by root-level aggregator
     * doFirst hooks for phases that have no subproject task deps (e.g.
     * monorepoPublishDryRun, monorepoGate, monorepoPublish). Idempotent —
     * a second call for a phase that already started is a no-op.
     */
    fun emitPhaseStart(phase: String) {
        val w = writer ?: return
        if (!phasesStarted.add(phase)) return
        val now = System.currentTimeMillis()
        startTimes["__phase:$phase"] = now
        synchronized(w) {
            w.println(jsonLine(
                "event" to "phase_start",
                "phase" to phase,
                "ts" to now,
            ))
        }
    }

    /**
     * Emit a publish_plan event carrying the packages the publish (or
     * publish dry-run) identified as publishable. Payload shape:
     *
     *   {"event":"publish_plan","packages":[
     *     {"name":"@scope/pkg","version":"1.2.3","bumped":true},
     *     ...
     *   ],"ts":...}
     *
     * The display renders this as a summary box so the user doesn't have
     * to grep the gradle log to see what would publish.
     */
    fun emitPublishPlan(packages: List<Triple<String, String, Boolean>>) {
        val w = writer ?: return
        val now = System.currentTimeMillis()
        // Hand-rolled JSON for the packages array to keep the hot path free
        // of Jackson init. Each element: {"name":"...","version":"...","bumped":true}
        val arr = StringBuilder("[")
        for ((i, pkg) in packages.withIndex()) {
            if (i > 0) arr.append(',')
            val (name, version, bumped) = pkg
            arr.append("{\"name\":\"").append(escapeJson(name))
                .append("\",\"version\":\"").append(escapeJson(version))
                .append("\",\"bumped\":").append(bumped).append('}')
        }
        arr.append(']')
        synchronized(w) {
            w.println("{\"event\":\"publish_plan\",\"packages\":$arr,\"ts\":$now}")
        }
    }

    /**
     * Emit a gate_stamp_written event after monorepoGate writes its stamp.
     * The display renders this as a footer line so the user gets explicit
     * feedback that the stamp exists and how many packages it covers.
     */
    fun emitGateStampWritten(path: String, packageCount: Int) {
        val w = writer ?: return
        val now = System.currentTimeMillis()
        synchronized(w) {
            w.println(jsonLine(
                "event" to "gate_stamp_written",
                "path" to path,
                "packageCount" to packageCount,
                "ts" to now,
            ))
        }
    }

    /**
     * OperationCompletionListener implementation: receives task finish events.
     */
    override fun onFinish(event: FinishEvent) {
        if (event !is TaskFinishEvent) return
        val taskPath = event.descriptor.taskPath  // e.g. ":packages:foo:transpile" or ":monorepoBuild"

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

        // Root-level task (single leading colon, e.g. ":monorepoBuild").
        // Only emit phase_done for tasks we explicitly track — gradle has
        // dozens of internal root tasks that would otherwise flood the log.
        val lastColon = taskPath.lastIndexOf(':')
        if (lastColon == 0) {
            val taskName = taskPath.substring(1)
            if (taskName !in PHASE_TASK_NAMES) return
            val startedAt = startTimes.remove("__phase:$taskName")
            val durationMs = if (startedAt != null) {
                System.currentTimeMillis() - startedAt
            } else {
                (event.result.endTime - event.result.startTime)
            }
            synchronized(w) {
                w.println(jsonLine(
                    "event" to "phase_done",
                    "phase" to taskName,
                    "status" to status,
                    "durationMs" to durationMs,
                    "ts" to System.currentTimeMillis(),
                ))
            }
            return
        }

        val (projectPath, taskName) = splitTaskPath(taskPath) ?: return
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
