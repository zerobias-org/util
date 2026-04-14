package com.zerobias.buildtools.lifecycle

import org.gradle.api.provider.Property
import org.gradle.api.services.BuildService
import org.gradle.api.services.BuildServiceParameters
import org.gradle.tooling.Failure
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
 * Emits JSON-line events for zbb lifecycle tasks (per-project phases like
 * validate, lint, generate, compile, test, gate) to a side channel that
 * zbb tails for the project-centric TTY display.
 *
 * Shared between standard (zb.base) and monorepo (zb.monorepo-base) modes.
 * Each mode is responsible for hooking its own tasks via [emitStart]; the
 * BuildEventsListener subscription emits [task_done] for any task that
 * finishes whose name maps to a non-null display name (see [displayNameFor]).
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
abstract class EventEmitter : BuildService<EventEmitter.Params>,
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

    /** Track which phases have already had phase_done emitted. Used to
     *  dedupe between three possible emission sources that can race in
     *  monorepo mode:
     *    1. Listener: fires when a root aggregator task (:monorepoBuild etc.)
     *       completes.
     *    2. Transition-based close in emitStart: fires when a task belonging
     *       to a different phase begins, closing the prior phase.
     *    3. Failure-based close in task_done: fires when a tracked task fails
     *       and maps to a phase, surfacing the phase as failed.
     *  First writer wins. Standard mode relies on (2) and (3) because it
     *  has no root aggregator tasks; monorepo mode relies on (1) as the
     *  authoritative source with (2)/(3) as backups. */
    private val phasesEnded = java.util.concurrent.ConcurrentHashMap.newKeySet<String>()

    /** Track which (project, displayName) pairs have emitted task_start, so
     *  emitStart is idempotent across the parent + *Exec collapse pattern.
     *  Without this, both `lint` and `lintExec` (which collapse to the same
     *  display name "lint") would emit two task_start events for the same
     *  display row. */
    private val taskStartsEmitted = java.util.concurrent.ConcurrentHashMap.newKeySet<String>()

    /** Same purpose for task_done — first finishing variant wins. */
    private val taskDonesEmitted = java.util.concurrent.ConcurrentHashMap.newKeySet<String>()

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
     *
     * Shared between monorepo mode and standard (zb.base) mode. The phase
     * names deliberately keep the "monorepo" prefix — the display's
     * phaseDisplayName helper strips it uniformly ("monorepoBuild" → "Build",
     * "monorepoGate" → "Stamp"). Both modes show the same breadcrumb labels.
     */
    private fun subprojectTaskToPhase(taskName: String): String? = when (taskName) {
        // Build phase: anything that produces dist/ or compile output.
        "lint", "generate", "transpile", "compile",
        "npmLint", "npmGenerate", "npmTranspile", "npmBuild",
        "lintExec", "transpileExec", "compileExec",
        "validate", "validateSpec", "validateConnector",
        "assembleSpec", "bundleSpec", "dereferenceSpec", "generateCode",
        "generateApi", "generateServerApi", "generateServerEntry", "generateDockerfile",
        "buildHubSdk", "buildHubSdkExec", "buildOpenApiSdk",
        "buildImage", "buildImageExec", "buildArtifacts",
        "build", "jar", "classes", "compileJava", "compileKotlin",
        "stageBinJars", "copyDependencies",
        -> "monorepoBuild"

        // Test phase: anything that executes tests.
        "test", "testUnit", "testIntegration",
        "testUnitExec", "testIntegrationExec",
        "testDirect", "testDirectExec",
        "testHub", "testHubExec",
        "testDataloader", "testDataloaderExec",
        "npmTest", "check",
        -> "monorepoTest"

        // Docker phase: substack docker pipeline OR standard docker tests.
        "dockerBuild", "npmPack", "prepareDockerContext", "injectLocalDeps",
        "testDocker", "testDockerExec",
        -> "monorepoDockerBuild"

        else -> null
    }

    /**
     * Map a raw Gradle task name to the canonical display name shown in
     * the per-project step row, OR null to hide the task from the display
     * entirely.
     *
     * This is the single source of truth for "which tasks does the user
     * see as steps". Both the doFirst-driven [emitStart] path and the
     * BuildEventsListener task_done path filter through this function so
     * monorepo and standard mode produce the same display vocabulary.
     *
     * Collapsing rules:
     *   - Lifecycle parents and their *Exec implementation tasks collapse
     *     to a single entry (lint + lintExec → "lint"). The display dedupes
     *     by step name so the user sees one row, not two.
     *   - OpenAPI codegen pipeline tasks (assembleSpec, bundleSpec, …)
     *     collapse into "generate".
     *   - Test variants are kept SEPARATE (testUnit, testIntegration,
     *     testDirect, testHub, testDocker, testDataloader) so each test
     *     mode is independently visible. The bare "test" lifecycle task
     *     is hidden because it's a no-op alias whose action fires after
     *     all the *Exec sub-tasks have run.
     *   - Build artifact variants are kept SEPARATE (buildHubSdk,
     *     buildOpenApiSdk, buildImage, buildArtifacts) so each artifact
     *     kind is independently visible.
     *   - Gradle plumbing tasks (nodeSetup, npmSetup, processResources,
     *     jar, classes, …) and lifecycle aliases (test, writeGateStamp)
     *     return null and are hidden.
     */
    private fun displayNameFor(taskName: String): String? = when (taskName) {
        // Validation
        "validate", "validateSpec", "validateConnector" -> "validate"

        // Lint
        "lint", "lintExec" -> "lint"

        // Generate (includes OpenAPI codegen pipeline)
        "generate", "generateApi", "generateServerApi", "generateServerEntry",
        "assembleSpec", "bundleSpec", "dereferenceSpec", "dereferenceProductInfos",
        "generateCode", "generateDockerfile",
        -> "generate"

        // npm install
        "npmInstallModule" -> "install"

        // Compile (transpile + JVM compile collapse here)
        "transpile", "transpileExec",
        "compile", "compileExec", "compileServer",
        "compileJava", "compileKotlin",
        -> "compile"

        // Build artifacts — kept SEPARATE so each artifact kind shows
        "buildHubSdk", "buildHubSdkExec" -> "buildHubSdk"
        "buildOpenApiSdk" -> "buildOpenApiSdk"
        "buildImage", "buildImageExec" -> "buildImage"
        "buildArtifacts" -> "buildArtifacts"

        // Tests — kept SEPARATE so each test mode shows
        "testUnit", "testUnitExec" -> "testUnit"
        "testIntegration", "testIntegrationExec" -> "testIntegration"
        "testDirect", "testDirectExec" -> "testDirect"
        "testHub", "testHubExec" -> "testHub"
        "testDocker", "testDockerExec" -> "testDocker"
        "testDataloader", "testDataloaderExec" -> "testDataloader"

        // Gate
        "gate" -> "gate"
        "gateCheck" -> "gateCheck"

        // Monorepo npm helpers (legacy short names) — pass through
        "npmLint", "npmGenerate", "npmTranspile", "npmBuild" -> taskName
        "dockerBuild" -> "dockerBuild"

        // Hidden: lifecycle aliases that fire after their *Exec deps
        // (their actions are no-ops, would just clutter the display),
        // plus gradle plumbing.
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
        // Apply display-name mapping. Returns null for hidden tasks
        // (lifecycle aliases, gradle plumbing) which we drop entirely so
        // the per-project step row only contains canonical lifecycle
        // entries. Uses the mapped name as the event key so dedupe works
        // when both a parent task and its *Exec dep collapse to the
        // same display name.
        val displayName = displayNameFor(taskName) ?: return
        val key = "$projectPath:$displayName"
        val now = System.currentTimeMillis()
        // First-writer-wins on startTimes so the earlier-firing variant
        // (usually *Exec, since the parent's doFirst runs after deps)
        // sets the canonical start timestamp.
        startTimes.putIfAbsent(key, now)

        // Infer the parent phase from the RAW task name and emit
        // phase_start if not yet done. Phase inference uses raw names
        // because subprojectTaskToPhase covers the full set of variants;
        // display collapsing only applies to the per-task row, not the
        // phase breadcrumb.
        subprojectTaskToPhase(taskName)?.let { phase ->
            if (phasesStarted.add(phase)) {
                // Transition close: any OTHER phase that's already started
                // but not yet ended must be closing right now (gradle's
                // DAG enforces that dependents only start after their deps
                // complete). Emit phase_done for the prior phase(s) so
                // standard mode — which has no root aggregator tasks to
                // drive the listener-based phase_done path — still gets
                // proper phase-transition boundaries in the display.
                // Idempotent against the monorepo listener path via
                // phasesEnded dedup.
                for (prior in phasesStarted) {
                    if (prior == phase || prior in phasesEnded) continue
                    val priorStartedAt = startTimes.remove("__phase:$prior")
                    val priorDuration = if (priorStartedAt != null) {
                        now - priorStartedAt
                    } else {
                        0L
                    }
                    emitPhaseDoneInternal(prior, "passed", priorDuration, null)
                }
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

        // Emit task_start ONCE per (project, displayName). If a parent
        // and its *Exec both fire emitStart, the second call is a no-op
        // for the event log — the display already has its row.
        if (taskStartsEmitted.add(key)) {
            synchronized(w) {
                w.println(jsonLine(
                    "event" to "task_start",
                    "project" to projectPath,
                    "step" to displayName,
                    "ts" to now,
                ))
            }
        }
    }

    /**
     * Idempotent phase_done emission. First writer wins; subsequent calls
     * for the same phase name are no-ops. Used by the transition-based
     * close in [emitStart], the task-failure propagation in the listener's
     * task_done path, and the listener's root aggregator path.
     */
    private fun emitPhaseDoneInternal(
        phase: String,
        status: String,
        durationMs: Long,
        error: String?,
    ) {
        val w = writer ?: return
        if (!phasesEnded.add(phase)) return
        synchronized(w) {
            if (error != null) {
                w.println(jsonLine(
                    "event" to "phase_done",
                    "phase" to phase,
                    "status" to status,
                    "durationMs" to durationMs,
                    "error" to error,
                    "ts" to System.currentTimeMillis(),
                ))
            } else {
                w.println(jsonLine(
                    "event" to "phase_done",
                    "phase" to phase,
                    "status" to status,
                    "durationMs" to durationMs,
                    "ts" to System.currentTimeMillis(),
                ))
            }
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

        // Extract the failure message for failed tasks so the display can
        // surface it inline. Without this, users see a "✗" icon in the
        // breadcrumb but have to grep gradle.log to find out what broke.
        //
        // Gradle's Failure is tree-shaped: the top-level Failure wraps the
        // task invocation (message = "Execution failed for task ':foo'.")
        // and the ACTUAL exception (e.g. a GradleException we threw from
        // doLast with our detailed error) lives under `causes`. We have to
        // walk the tree to pull the useful message out. If we only looked
        // at the top level, every phase failure would just say "Execution
        // failed for task ':monorepoPublishDryRun'." with no detail.
        //
        // Strategy: collect messages from the deepest Failures first (most
        // specific), drop the gradle wrapper prefix, and skip duplicates.
        val errorMessage: String? = if (result is FailureResult) {
            try {
                collectFailureMessages(result.failures)
                    .ifBlank { "(failure with no message)" }
            } catch (e: Exception) {
                "(could not extract failure: ${e.message})"
            }
        } else null

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
            emitPhaseDoneInternal(taskName, status, durationMs, errorMessage)
            return
        }

        val (projectPath, taskName) = splitTaskPath(taskPath) ?: return

        // Apply display-name mapping. Hidden tasks (gradle plumbing,
        // lifecycle aliases) drop out here so the task_done stream stays
        // consistent with the task_start stream — both sides see only
        // canonical lifecycle entries. Failure propagation to phase_done
        // still happens below using the RAW name so a hidden task that
        // happens to fail can still close its phase.
        val displayName = displayNameFor(taskName)
        if (displayName != null) {
            val key = "$projectPath:$displayName"
            val startedAt = startTimes.remove(key)
            val durationMs = if (startedAt != null) {
                System.currentTimeMillis() - startedAt
            } else {
                // Derive from event timestamps if we missed the start hook
                (event.result.endTime - event.result.startTime)
            }

            // Idempotent task_done emission. If a parent + *Exec both
            // resolve to the same display name, the first one to finish
            // owns the row. A failure is allowed to OVERWRITE a prior
            // success (e.g. compile passed, but the parent task that
            // depended on compile failed) so the display surfaces the
            // failure.
            val shouldEmit = status == "failed" || taskDonesEmitted.add(key)
            if (shouldEmit) {
                if (status == "failed") {
                    taskDonesEmitted.add(key)
                }
                // Consume the start slot too. A skipped *Exec dep never
                // fired its doFirst hook (so taskStartsEmitted is still
                // empty for this key), but its listener event arrives
                // first via the BuildEventsListener. The parent task's
                // doFirst will fire LATER and try to emitStart for the
                // same display key — without this guard it would reset
                // the step to running and never receive a matching
                // task_done (the parent's own listener call is suppressed
                // by the dedup just above). End result: the row would
                // appear stuck in running forever.
                taskStartsEmitted.add(key)
                synchronized(w) {
                    if (errorMessage != null) {
                        w.println(jsonLine(
                            "event" to "task_done",
                            "project" to projectPath,
                            "step" to displayName,
                            "status" to status,
                            "durationMs" to durationMs,
                            "error" to errorMessage,
                            "ts" to System.currentTimeMillis(),
                        ))
                    } else {
                        w.println(jsonLine(
                            "event" to "task_done",
                            "project" to projectPath,
                            "step" to displayName,
                            "status" to status,
                            "durationMs" to durationMs,
                            "ts" to System.currentTimeMillis(),
                        ))
                    }
                }
            }
        }

        // Task-failure → phase-failure propagation. When a tracked task
        // fails and maps to a phase, close the phase with a 'failed'
        // status so the display breadcrumb reflects the failure. Without
        // this, a failing final phase in standard mode (e.g. `testDocker`
        // with no subsequent phase to trigger a transition close) never
        // receives phase_done and the EOB safety net marks it misleadingly
        // as skipped. Idempotent — monorepo mode's root aggregator path
        // still wins if it fires first. Uses the RAW task name for phase
        // inference so even tasks hidden from the per-project display
        // (e.g. lifecycle aliases) still propagate failures upward.
        if (status == "failed") {
            subprojectTaskToPhase(taskName)?.let { phase ->
                val phaseStartedAt = startTimes["__phase:$phase"]
                val phaseDuration = if (phaseStartedAt != null) {
                    System.currentTimeMillis() - phaseStartedAt
                } else {
                    (event.result.endTime - event.result.startTime)
                }
                emitPhaseDoneInternal(phase, "failed", phaseDuration, errorMessage)
            }
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
     * Recursively collect messages from a Failure tree, filtering out
     * Gradle's wrapping "Execution failed for task ':foo'." noise in favor
     * of the actual exception message in the causes chain.
     *
     * The Gradle Tooling API gives us `Failure` objects shaped like:
     *
     *     Failure(message="Execution failed for task ':bar'.",
     *             causes=[
     *                 Failure(message="publish dry-run failed for 2 package(s): ...",
     *                         causes=[])
     *             ])
     *
     * We walk the tree depth-first, collect every non-blank message, skip
     * the `Execution failed for task` wrapper unless it's the ONLY message
     * available, and dedupe — so a 3-level cause chain produces one clean
     * error block instead of three duplicated entries.
     */
    private fun collectFailureMessages(failures: List<Failure>): String {
        val collected = linkedSetOf<String>()

        fun walk(f: Failure) {
            val msg = f.message ?: f.description
            if (!msg.isNullOrBlank()) {
                collected.add(msg.trim())
            }
            for (cause in f.causes ?: emptyList()) {
                walk(cause)
            }
        }

        for (f in failures) walk(f)

        if (collected.isEmpty()) return ""

        // Prefer the messages that AREN'T the generic gradle wrapper.
        val wrapperPattern = Regex("""^Execution failed for task ':[^']+'\.?$""")
        val detailed = collected.filter { !wrapperPattern.matches(it) }
        val chosen = if (detailed.isNotEmpty()) detailed else collected.toList()

        return chosen.joinToString("\n")
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
