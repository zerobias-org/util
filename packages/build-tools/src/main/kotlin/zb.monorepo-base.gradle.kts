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
import com.zerobias.buildtools.monorepo.MonorepoEventEmitter
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

// ── MonorepoEventEmitter — JSON-line events for the zbb TTY display ──
//
// Default event file: <repo>/.zbb-monorepo/events.jsonl (gitignored, preserved
// between runs for post-mortem inspection). Override with ZBB_MONOREPO_EVENT_FILE.
// Per-task stdout/stderr captured to <repo>/.zbb-monorepo/logs/<safe>.log

val eventFile = System.getenv("ZBB_MONOREPO_EVENT_FILE")
    ?: rootProject.file(".zbb-monorepo/events.jsonl").absolutePath

val logsDir = rootProject.file(".zbb-monorepo/logs")

val eventEmitter = gradle.sharedServices.registerIfAbsent(
    "monorepoEventEmitter",
    MonorepoEventEmitter::class.java
) {
    parameters.eventFilePath.set(eventFile)
    // monorepoProjectPaths and phaseTaskNames are set in projectsEvaluated
    // once we know the workspace graph
}

extensions.extraProperties["monorepoEventEmitter"] = eventEmitter

// Subscribe the emitter to task FINISH events via the modern BuildEventsListenerRegistry
val buildEventsListenerRegistry = project.serviceOf<BuildEventsListenerRegistry>()
buildEventsListenerRegistry.onTaskCompletion(eventEmitter)

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
}
