/**
 * Base plugin for zbb monorepo support. Applied at the root project.
 *
 * Responsibilities:
 *   - Registers the `MonorepoGraphService` BuildService that holds the
 *     workspace graph, monorepo config, and change-detection result for
 *     this build invocation
 *   - Exposes the service via `extra["monorepoGraphService"]` for child
 *     plugins (`-gate`, `-build`, `-publish`) to consume
 *   - Reads command-line properties: `-Pmonorepo.all=true` and
 *     `-Pmonorepo.base=<ref>` for `--all` and `--base` from zbb
 *
 * NOT in this plugin:
 *   - Cleanse / preflight (those stay in zbb at the boundary)
 *   - Slot / vault env injection (zbb does that before invoking gradle)
 *   - Per-subproject task wiring (that's in -build, -gate, -publish)
 *
 * Usage in root build.gradle.kts:
 *   plugins {
 *       id("zb.monorepo-base")
 *   }
 *
 * The MonorepoGraphService class itself lives in
 * `com/zerobias/buildtools/monorepo/MonorepoGraphService.kt` so it can
 * be imported by sibling precompiled plugins.
 */

import com.zerobias.buildtools.monorepo.MonorepoGraphService
import com.zerobias.buildtools.lifecycle.EventEmitter
import org.gradle.api.tasks.Exec
import org.gradle.build.event.BuildEventsListenerRegistry
import org.gradle.kotlin.dsl.support.serviceOf

val monorepoAll = (project.findProperty("monorepo.all") as? String)?.toBoolean() ?: false
val monorepoBase = project.findProperty("monorepo.base") as? String

val graphService = gradle.sharedServices.registerIfAbsent(
    "monorepoGraph",
    MonorepoGraphService::class.java
) {
    parameters.repoRoot.set(rootProject.layout.projectDirectory)
    parameters.all.set(monorepoAll)
    monorepoBase?.let { parameters.baseRef.set(it) }
}

extensions.extraProperties["monorepoGraphService"] = graphService

// ── EventEmitter — JSON-line events for the zbb TTY display ──
//
// Default event file: <repo>/.zbb-monorepo/events.jsonl (gitignored, preserved
// between runs for post-mortem inspection). Override with ZBB_MONOREPO_EVENT_FILE.
// Per-task stdout/stderr captured to <repo>/.zbb-monorepo/logs/<safe>.log

val eventFile = System.getenv("ZBB_MONOREPO_EVENT_FILE")
    ?: rootProject.file(".zbb-monorepo/events.jsonl").absolutePath

val logsDir = rootProject.file(".zbb-monorepo/logs")

val eventEmitter = gradle.sharedServices.registerIfAbsent(
    "monorepoEventEmitter",
    EventEmitter::class.java
) {
    parameters.eventFilePath.set(eventFile)
    // Surface the monorepo phase names (from zbb.yaml's `buildPhases` /
    // `testPhases`) as first-class display rows. Without this, a bare
    // `test` / `build` task — which monorepo mode registers as the real
    // Exec running `npm run test` — falls through displayNameFor and
    // produces ZERO rows in the TTY display, so users only see the raw
    // Gradle exception message ("Process 'command 'npm'' finished with
    // non-zero exit value N") on failure instead of per-package status
    // and a log tail. Provider-based so graphService is resolved lazily
    // (after projectsEvaluated parses zbb.yaml).
    parameters.extraDisplayTaskNames.set(
        graphService.map { svc ->
            (svc.config.buildPhases + svc.config.testPhases).toSet()
        }
    )
    // Monorepo mode has root aggregator tasks (monorepoBuild, monorepoTest,
    // …) whose onFinish listener event closes each phase authoritatively.
    // Disable the transition-close path in emitStart — that path is a
    // standard-mode-only fallback and assumes sequential-phase DAG edges
    // which don't hold here (monorepoGate depends on monorepoTest AND
    // monorepoDockerBuild in parallel, so a dockerBuild task_start used
    // to prematurely close monorepoTest while per-project tests were
    // still running).
    parameters.disableTransitionClose.set(true)
}

extensions.extraProperties["monorepoEventEmitter"] = eventEmitter

// Subscribe the emitter to task FINISH events via the modern BuildEventsListenerRegistry.
//
// Guarded by a root-project extra property so we don't double-subscribe
// when BOTH this plugin AND zb.base (which is transitively applied by
// zb.typescript on every subproject) try to register. Without the guard,
// every task_done / phase_done gets fired twice — once per subscription —
// and the dedup in EventEmitter's state maps is defeated because the two
// listener callbacks race on the `add()` call. Observed symptoms were
// corrupted events.jsonl lines, double `phase_done monorepoBuild`
// (one failed + one passed from the same root task finish), and a
// `:store-api:generate` that emitted both `failed` and `passed`
// `task_done` events. zb.base uses the SAME key name, so whichever
// plugin runs first wins and the other is a no-op.
run {
    val listenerRegisteredKey = "zbbMonorepoEventListenerRegistered"
    val rootExtra = rootProject.extensions.extraProperties
    if (!rootExtra.has(listenerRegisteredKey)) {
        val buildEventsListenerRegistry = project.serviceOf<BuildEventsListenerRegistry>()
        buildEventsListenerRegistry.onTaskCompletion(eventEmitter)
        rootExtra.set(listenerRegisteredKey, true)
    }
}

gradle.projectsEvaluated {
    val service = graphService.get()
    val packages = service.packages
    println("zb.monorepo-base: ${packages.size} workspace packages discovered")
    if (monorepoAll) {
        println("  --all mode: affecting all ${packages.size} packages")
    } else {
        val affected = service.changeResult.affected.size
        val base = service.changeResult.baseRef
        println("  base: $base, affected: $affected/${packages.size}")
    }
}

// Per-task hooks: emit start events + redirect stdout/stderr to per-task log
// files. Wired via taskGraph.whenReady which runs AFTER all projectsEvaluated
// callbacks complete (so zb.monorepo-build's per-subproject task creation in
// its own projectsEvaluated block is finished before we look for tasks).
gradle.taskGraph.whenReady {
    val service = graphService.get()
    val packages = service.packages
    val phaseSet = (
        service.config.buildPhases +
        service.config.testPhases +
        listOf("npmLint", "npmGenerate", "npmTranspile", "npmBuild", "dockerBuild")
    ).toSet()
    val projectPathSet = packages.values.map { ":" + it.relDir.replace("/", ":") }.toSet()

    logsDir.mkdirs()

    for (subprojectPath in projectPathSet) {
        val subproject = rootProject.findProject(subprojectPath) ?: continue
        for (taskName in phaseSet) {
            val task = subproject.tasks.findByName(taskName) ?: continue

            // Capture in local vals so they're stable in the lambda
            val capturedProjectPath = subprojectPath
            val capturedTaskName = taskName
            val emitterProvider = eventEmitter

            // Declare service usage so the BuildService is accessible from the task action
            task.usesService(emitterProvider)

            // Per-task log file path
            val safeName = subprojectPath.removePrefix(":").replace(":", "-")
            val logFile = logsDir.resolve("$safeName-$taskName.log")

            // Redirect Exec task output to the log file (only for Exec subtypes).
            // Cast through BaseExecSpec to avoid NoSuchMethodError when the
            // Kotlin-compiled setter targets a covariant return type that
            // doesn't match the runtime Gradle API.
            if (task is Exec) {
                val execTask: Exec = task
                // Store the stream so doLast can flush it. Declared outside
                // the doFirst lambda so both doFirst and doLast see it.
                var logStream: java.io.OutputStream? = null

                execTask.doFirst {
                    logFile.parentFile.mkdirs()
                    val out = logFile.outputStream()
                    logStream = out
                    @Suppress("DEPRECATION")
                    (execTask as org.gradle.process.BaseExecSpec).standardOutput = out
                    @Suppress("DEPRECATION")
                    (execTask as org.gradle.process.BaseExecSpec).errorOutput = out
                }

                // Flush + close the log stream after task completes (success
                // or failure). Without this, buffered output is lost when the
                // task fails — the per-task log file ends up empty.
                execTask.doLast {
                    try { logStream?.flush(); logStream?.close() } catch (_: Exception) {}
                }
            }

            // Emit start event via doFirst. doFirst PREPENDS the action so it
            // runs BEFORE any other doFirst hooks added earlier.
            task.doFirst {
                emitterProvider.get().emitStart(capturedProjectPath, capturedTaskName)
            }
        }
    }

    // Root-level phase tasks — the monorepo aggregators shown in the display
    // as a breadcrumb ("which step in the chain are we on"). Each gets a
    // doFirst hook that fires emitPhaseStart; the finish side is already
    // handled by the OperationCompletionListener in EventEmitter.
    val phaseTaskNames = setOf(
        "monorepoBuild",
        "monorepoTest",
        "monorepoDockerBuild",
        "monorepoPublishDryRun",
        "monorepoPublish",
        "monorepoGate",
        "monorepoGateCheck",
        "monorepoClean",
    )
    for (phaseName in phaseTaskNames) {
        val task = rootProject.tasks.findByName(phaseName) ?: continue
        val capturedPhase = phaseName
        val emitterProvider = eventEmitter
        task.usesService(emitterProvider)
        task.doFirst {
            emitterProvider.get().emitPhaseStart(capturedPhase)
        }
    }
}
