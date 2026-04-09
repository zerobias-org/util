/**
 * Gate stamp orchestration plugin for zbb monorepos.
 *
 * Adds two root-level tasks:
 *   - monorepoGateCheck — cheap pre-flight: reads gate-stamp.json, validates
 *     each affected package against current source, exits 0/1. NO build deps.
 *   - monorepoGate — runs gate for affected packages, then writes a unified
 *     root gate-stamp.json aggregating per-package entries. (Per-package
 *     gate logic comes from `zb.base` or whatever plugin is applied per
 *     subproject; this plugin only orchestrates and aggregates.)
 *
 * For Phase 2.4, monorepoGate's per-subproject task wiring is intentionally
 * limited — full task chaining happens in zb.monorepo-build. This plugin
 * focuses on the stamp file format and the cheap CI pre-flight.
 *
 * Usage in root build.gradle.kts:
 *   plugins {
 *       id("zb.monorepo-base")
 *       id("zb.monorepo-gate")
 *   }
 */

import com.zerobias.buildtools.monorepo.GateStamp
import com.zerobias.buildtools.monorepo.GateStampIO
import com.zerobias.buildtools.monorepo.GateStampResult
import com.zerobias.buildtools.monorepo.MonorepoGraphService
import com.zerobias.buildtools.monorepo.PackageStampEntry
import com.zerobias.buildtools.monorepo.Prepublish
import com.zerobias.buildtools.monorepo.StampValidator
import com.zerobias.buildtools.monorepo.TestSuiteEntry
import com.zerobias.buildtools.util.SourceHasher
import com.fasterxml.jackson.databind.ObjectMapper
import com.fasterxml.jackson.module.kotlin.readValue
import com.fasterxml.jackson.module.kotlin.registerKotlinModule

@Suppress("UNCHECKED_CAST")
val graphService = (project.extensions.extraProperties["monorepoGraphService"]
    as org.gradle.api.provider.Provider<MonorepoGraphService>)

val rootStampFile = rootProject.file("gate-stamp.json")

// ── monorepoGateCheck — cheap pre-flight for CI ─────────────────────

tasks.register("monorepoGateCheck") {
    group = "monorepo"
    description = "Validate the committed gate-stamp.json against current source. Exit 0 if valid, 1 otherwise. Cheap — no build/test/vault required."
    // No dependsOn — this task does NOT trigger gate, build, or anything else.
    // It only reads files and exits.

    doLast {
        val service = graphService.get()
        val stamp = GateStampIO.read(rootStampFile)

        if (stamp == null) {
            logger.error("✗ no gate-stamp.json found at ${rootStampFile.absolutePath}")
            logger.error("  Run `zbb gate` locally and commit the stamp before pushing.")
            throw GradleException("gate-stamp.json missing or unreadable")
        }

        val validator = StampValidator(
            sourceFiles = service.config.sourceFiles,
            sourceDirs = service.config.sourceDirs,
            testPhases = service.config.testPhases.toSet(),
        )

        // Read root package.json for rootDeps drift check
        val rootPkgFile = rootProject.file("package.json")
        val mapper = ObjectMapper().registerKotlinModule()
        val rootPkg: Map<String, Any?>? = if (rootPkgFile.exists()) {
            try { mapper.readValue(rootPkgFile) } catch (_: Exception) { null }
        } else null

        var allValid = true
        for ((name, pkg) in service.graph.packages) {
            // Skip private packages (they're not in the gate stamp anyway)
            if (pkg.private) continue

            val result = validator.validate(
                packageDir = pkg.dir,
                packageName = name,
                stamp = stamp,
                rootPackageJson = rootPkg,
            )

            val shortName = name.replace(Regex("^@[^/]+/"), "")
            val icon = if (result == GateStampResult.VALID) "✓" else "✗"
            logger.lifecycle("  $icon $shortName: $result")
            if (result != GateStampResult.VALID) allValid = false
        }

        if (!allValid) {
            throw GradleException("gate-stamp.json is invalid for one or more packages — run `zbb gate` to refresh")
        }
        logger.lifecycle("Gate stamp valid — all packages pass validation.")
    }
}

// ── monorepoGate — full gate run + stamp write ──────────────────────
//
// monorepoGate depends on monorepoBuild + monorepoTest, then writes the
// unified root gate-stamp.json by querying each per-subproject task's actual
// state (executed/skipped/upToDate/failed) — no placeholder values.

val monorepoGate = tasks.register("monorepoGate") {
    group = "monorepo"
    description = "Run gate for all affected packages and write the root gate-stamp.json"
    // monorepoBuild + monorepoTest are added in zb.monorepo-build (when applied).
    // Wire conditionally so this plugin works even if -build isn't applied.
    rootProject.tasks.findByName("monorepoBuild")?.let { dependsOn(it) }
    rootProject.tasks.findByName("monorepoTest")?.let { dependsOn(it) }

    doLast {
        val service = graphService.get()
        val packages = service.graph.packages
        val sourceFiles = service.config.sourceFiles
        val sourceDirs = service.config.sourceDirs
        val phases = service.config.buildPhases
        val testPhases = service.config.testPhases

        val branch = try {
            val proc = ProcessBuilder("git", "rev-parse", "--abbrev-ref", "HEAD")
                .directory(rootProject.projectDir).start()
            proc.waitFor()
            proc.inputStream.bufferedReader().readText().trim()
        } catch (_: Exception) { "unknown" }

        // Build per-package entries for ALL non-private packages
        val packageEntries = linkedMapOf<String, PackageStampEntry>()
        for ((name, pkg) in packages) {
            if (pkg.private) continue

            val sourceHash = SourceHasher.hashSources(pkg.dir, sourceFiles, sourceDirs)
            val testHash = SourceHasher.hashTests(pkg.dir)

            val rootDeps = try {
                Prepublish.resolveRootDeps(pkg.dir, rootProject.projectDir)
            } catch (_: Exception) {
                emptyMap()
            }

            // Look up the matching Gradle subproject for this npm package
            val gradlePath = ":" + pkg.relDir.replace("/", ":")
            val subproject = rootProject.findProject(gradlePath)

            // Query real task state for each phase. The mapping:
            //   not in graph / no script   → "skipped" (matches TS Builder.ts:1592)
            //   skipped (onlyIf, etc.)     → "skipped"
            //   noSource                   → "skipped"
            //   executed && no failure     → "passed"
            //   executed && failure        → "failed"
            //   upToDate                   → "passed"
            val tasksMap = linkedMapOf<String, String>()
            for (phase in phases) {
                tasksMap[phase] = mapTaskState(subproject?.tasks?.findByName(phase))
            }
            for (testPhase in testPhases) {
                tasksMap[testPhase] = mapTaskState(subproject?.tasks?.findByName(testPhase))
            }

            // Test phase override: TS Builder.ts only sets test = "passed" if
            // hasTests (any per-suite expected count > 0). If countExpectedTests
            // returns 0 across all suites (e.g. aws-common has flat test/ instead
            // of test/unit/), TS leaves test as "skipped" even when the script
            // actually ran. Mirror that for parity.
            val totalExpectedTests = listOf("unit", "integration", "e2e").sumOf { suite ->
                SourceHasher.countExpectedTests(java.io.File(pkg.dir, "test/$suite"))
            }
            if (totalExpectedTests == 0) {
                for (testPhase in testPhases) {
                    tasksMap[testPhase] = "skipped"
                }
            }

            // Test suite entries: count expected from source files, derive
            // ran/status from the test task's actual state. Mirrors what the
            // existing zb.base writeGateStamp does — assumes "task passed" means
            // "all expected tests in this suite passed".
            val testSuiteDirs = linkedMapOf(
                "unit" to java.io.File(pkg.dir, "test/unit"),
                "integration" to java.io.File(pkg.dir, "test/integration"),
                "e2e" to java.io.File(pkg.dir, "test/e2e"),
            )
            val testTask = subproject?.tasks?.findByName("test")
            val testState = testTask?.state
            // upToDate check MUST come before skipped (state.upToDate is a
            // subset of state.skipped — same bug we fixed in mapTaskState).
            val testPassedOrCached = testState != null && (
                testState.upToDate ||
                (testState.executed && testState.failure == null)
            )
            val testFailed = testState?.failure != null
            val testSkipped = testTask == null || (
                testState != null && testState.skipped && !testState.upToDate
            )

            val tests = linkedMapOf<String, TestSuiteEntry>()
            for ((suite, dir) in testSuiteDirs) {
                val expected = SourceHasher.countExpectedTests(dir)
                val (ran, status) = when {
                    expected == 0 -> 0 to "skipped"
                    testFailed -> 0 to "failed"
                    testPassedOrCached -> expected to "passed"
                    testSkipped -> 0 to "skipped"
                    else -> 0 to "skipped"
                }
                tests[suite] = TestSuiteEntry(expected, ran, status)
            }

            packageEntries[name] = PackageStampEntry(
                version = pkg.version,
                sourceHash = sourceHash,
                testHash = testHash,
                tasks = tasksMap,
                tests = tests,
                rootDeps = rootDeps.takeIf { it.isNotEmpty() },
            )
        }

        val stamp = GateStamp(
            version = 1,
            branch = branch,
            timestamp = java.time.Instant.now().toString(),
            packages = packageEntries,
        )

        GateStampIO.write(rootStampFile, stamp)
        logger.lifecycle("Wrote ${rootStampFile.name} with ${packageEntries.size} packages")
    }
}

/**
 * Map a Gradle Task to its corresponding gate-stamp status string.
 *
 * Important: Gradle's `state.upToDate` is a SUBSET of `state.skipped` — an
 * up-to-date task has BOTH flags true. We must check `upToDate` first so
 * cached tasks map to "passed" (semantically they succeeded), not "skipped".
 *
 * Null tasks (no script defined for that phase) map to "skipped" — matches
 * the legacy TS path which uses `tasks[phase] ?? 'skipped'` when writing the
 * stamp (Builder.ts line 1592).
 */
fun mapTaskState(task: org.gradle.api.Task?): String {
    if (task == null) return "skipped"  // matches TS: missing → skipped in stamp
    val state = task.state
    return when {
        state.failure != null -> "failed"
        state.upToDate -> "passed"      // cached / up-to-date = succeeded
        state.executed -> "passed"      // actually ran successfully
        state.noSource -> "skipped"     // explicit no-source
        state.skipped -> "skipped"      // other skip reasons (onlyIf, etc.)
        else -> "skipped"
    }
}

// ── Wire monorepoGate to per-subproject tasks (deferred) ────────────
//
// monorepoBuild and monorepoTest are aggregator tasks added by zb.monorepo-build.
// They handle the per-subproject task wiring internally (via dependsOn). So
// just depending on monorepoBuild + monorepoTest pulls in the whole graph.
// This deferred wiring picks up the aggregator tasks even if -build is applied
// after this plugin in the build.gradle.kts file.
gradle.projectsEvaluated {
    monorepoGate.configure {
        rootProject.tasks.findByName("monorepoBuild")?.let { dependsOn(it) }
        rootProject.tasks.findByName("monorepoTest")?.let { dependsOn(it) }
    }
}
