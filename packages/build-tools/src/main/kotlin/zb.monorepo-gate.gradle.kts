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
import com.zerobias.buildtools.monorepo.LocalRegistryScanner
import com.zerobias.buildtools.monorepo.MonorepoGraphService
import com.zerobias.buildtools.monorepo.PackageStampEntry
import com.zerobias.buildtools.monorepo.Prepublish
import com.zerobias.buildtools.monorepo.PrepublishLeftoverScanner
import com.zerobias.buildtools.monorepo.RegistryInjectionService
import com.zerobias.buildtools.monorepo.StampValidator
import com.zerobias.buildtools.util.PathConstants.ZBB_GRADLE_DIR
import com.zerobias.buildtools.monorepo.TestSuiteEntry
import com.zerobias.buildtools.util.SourceHasher
import com.fasterxml.jackson.databind.ObjectMapper
import com.fasterxml.jackson.module.kotlin.readValue
import com.fasterxml.jackson.module.kotlin.registerKotlinModule
import java.io.File

@Suppress("UNCHECKED_CAST")
val graphService = (project.extensions.extraProperties["monorepoGraphService"]
    as org.gradle.api.provider.Provider<MonorepoGraphService>)

val rootStampFile = rootProject.file("gate-stamp.json")

// ── RegistryInjectionService — shared with subproject plugins ──
//
// Root-level monorepo gate also needs the service so it can flip
// forcePublic=true under `-Pcleanlocalregistry`. registerIfAbsent is
// idempotent — same name + class returns the existing instance.
val registryInjection = gradle.sharedServices.registerIfAbsent(
    "registryInjection",
    RegistryInjectionService::class.java
) {
    parameters.repoRoot.set(rootProject.layout.projectDirectory)
}

// ── verifyNoLocalRegistry — root-level guard for monorepo gate ──
//
// Same behavior as zb.base's verifyNoLocalRegistry: scan
// package-lock.json for localhost-resolved entries; either fail with
// guidance, or under -Pcleanlocalregistry wipe offenders + force
// public-registry routing.
val verifyNoLocalRegistry = tasks.register("verifyNoLocalRegistry") {
    group = "monorepo"
    description = "Fail fast if package-lock.json carries localhost registry URLs (zbb local dev state)"
    usesService(registryInjection)

    doLast {
        val repoRoot = rootProject.rootDir
        val offenders = LocalRegistryScanner.scan(repoRoot)
        if (offenders.isEmpty()) return@doLast

        val cleanFlag = project.hasProperty("cleanlocalregistry")
        if (!cleanFlag) {
            throw GradleException(LocalRegistryScanner.buildFailureMessage(offenders))
        }

        val cleaned = LocalRegistryScanner.cleanOffendingNodeModules(repoRoot, offenders)
        val removedEntries = LocalRegistryScanner.cleanOffendingLockfileEntries(repoRoot, offenders)
        registryInjection.get().forcePublic = true
        if (cleaned.isNotEmpty()) {
            logger.lifecycle("verifyNoLocalRegistry: --clean — wiped ${cleaned.size} node_modules entries:")
            for (entry in cleaned.take(10)) logger.lifecycle("  - $entry")
            if (cleaned.size > 10) logger.lifecycle("  ...and ${cleaned.size - 10} more")
        }
        if (removedEntries > 0) {
            logger.lifecycle("verifyNoLocalRegistry: --clean — removed $removedEntries lockfile entries")
        }
        if (cleaned.isEmpty() && removedEntries == 0) {
            logger.lifecycle("verifyNoLocalRegistry: --clean — nothing to wipe; forcing public registry on next install.")
        }
        logger.lifecycle("verifyNoLocalRegistry: forcing public registry for the rest of this build (forcePublic=true).")
    }
}

// ── verifyNoPrepublishLeftover — block commits with prepublish drift ──
//
// `Prepublish.resolve()` mutates a workspace package's package.json with
// hoisted root deps + overrides as part of `monorepoPublish`. The mutation is
// supposed to be undone by `restorePackage` (finalizedBy publishPackage). If a
// publish run is interrupted (Ctrl-C, network failure, skipped publishPackage)
// the mutated state can end up committed — leading to per-package files with
// duplicated overrides and pinned RC versions that break workspace hoisting in
// downstream consumers. The dataloader package.json drift is the canonical
// case; it's the only package with `bin` entries so its prepublish mutation is
// large enough to be obvious in diffs, but the same flow affects every
// workspace package.
//
// Two signals indicate a leftover:
//   1. `package.json.prepublish-backup` exists alongside a workspace
//      package.json — direct evidence that `restorePackage` never ran.
//   2. A non-root workspace package.json declares an `overrides` block —
//      `overrides` is npm-root-only metadata; if it appears in a workspace
//      package, it was copied there by `Prepublish.resolve()`.
val verifyNoPrepublishLeftover = tasks.register("verifyNoPrepublishLeftover") {
    group = "monorepo"
    description = "Fail fast if any workspace package.json carries prepublish leftovers (mutated state from an interrupted publish)"

    doLast {
        val offenders = PrepublishLeftoverScanner.scan(rootProject.rootDir)
        if (offenders.isEmpty()) return@doLast
        throw GradleException(PrepublishLeftoverScanner.buildFailureMessage(offenders))
    }
}

// ── monorepoGateCheck — cheap pre-flight for CI ─────────────────────

tasks.register("monorepoGateCheck") {
    group = "monorepo"
    description = "Validate the committed gate-stamp.json against current source. Exit 0 if valid, 1 otherwise. Cheap — no build/test/vault required."
    // No dependsOn — this task does NOT trigger gate, build, or anything else.
    // It only reads files and exits.

    doLast {
        val service = graphService.get()

        // The marker file lets CI distinguish "stamp is invalid" (a normal
        // state — gate-run handles it) from "the check itself crashed"
        // (infrastructure error — fail the workflow). The marker is written
        // BEFORE we throw on invalid, so an absent marker means we never
        // reached the validation logic at all (e.g. plugin failed to load,
        // JVM crashed, build-tools missing).
        val markerDir = rootProject.file(ZBB_GRADLE_DIR)
        val markerFile = File(markerDir, "gate-check.marker")
        // Wipe any stale marker from a previous run before we start.
        markerDir.mkdirs()
        markerFile.delete()

        fun writeMarker(valid: Boolean, reason: String) {
            markerFile.writeText("valid=$valid\nreason=$reason\nts=${java.time.Instant.now()}\n")
        }

        val stamp = GateStampIO.read(rootStampFile)

        if (stamp == null) {
            // "No stamp" is treated like "invalid" — gate-run will produce
            // one. This is a recoverable state, not an infrastructure error.
            writeMarker(valid = false, reason = "stamp-missing")
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

        // Scope-aware: when `-Pmonorepo.scope=<pkg>` is set (subpackage
        // invocation from zbb's lifecycle dispatcher), validate only
        // that package's stamp entry. Without this, a scoped gate-check
        // would fail on every OTHER package's stale stamp, even though
        // the user only asked about one package.
        val scopeFilter = (project.findProperty("monorepo.scope") as? String)?.takeIf { it.isNotBlank() }

        var allValid = true
        for ((name, pkg) in service.graph.packages) {
            // Skip private packages (they're not in the gate stamp anyway)
            if (pkg.private) continue
            if (scopeFilter != null && name != scopeFilter) continue

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
            writeMarker(valid = false, reason = "stamp-invalid")
            throw GradleException("gate-stamp.json is invalid for one or more packages — run `zbb gate` to refresh")
        }
        writeMarker(valid = true, reason = "stamp-valid")
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
    dependsOn(verifyNoLocalRegistry)
    dependsOn(verifyNoPrepublishLeftover)
    // monorepoBuild + monorepoTest + monorepoDockerBuild are added in
    // zb.monorepo-build (when applied). Wire conditionally so this plugin
    // works even if -build isn't applied.
    rootProject.tasks.findByName("monorepoBuild")?.let { dependsOn(it) }
    rootProject.tasks.findByName("monorepoTest")?.let { dependsOn(it) }
    rootProject.tasks.findByName("monorepoDockerBuild")?.let { dependsOn(it) }
    // monorepoPublishDryRun validates the full publish path (change
    // detection + prepublish dry-run + npm pack --dry-run) without
    // mutating files or pushing. Wired here so `zbb gate` locally
    // exercises the same code paths as `zbb publish` in CI. If gate
    // passes locally, publish will pass in CI — that's the contract.
    rootProject.tasks.findByName("monorepoPublishDryRun")?.let { dependsOn(it) }

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

        // Scope-aware full-gate write: when `-Pmonorepo.scope=<pkg>` is
        // set, only the scoped package's tasks actually ran. The others'
        // task states are "skipped" (never executed). Rewriting the
        // whole stamp would wipe out correct entries for the unscoped
        // packages. Strategy: in scope mode, build the entry for the
        // scoped package only, then merge it into whatever the existing
        // stamp has for the other packages.
        val gateScope = (project.findProperty("monorepo.scope") as? String)?.takeIf { it.isNotBlank() }

        // Build per-package entries. When scope is set, skip everyone
        // else so we don't emit "skipped" rows for packages that simply
        // weren't in scope this run.
        val packageEntries = linkedMapOf<String, PackageStampEntry>()
        for ((name, pkg) in packages) {
            if (pkg.private) continue
            if (gateScope != null && name != gateScope) continue

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
            // dockerBuild is recorded only for packages whose substack declares
            // a `docker:` block — for everyone else the entry is omitted (not
            // "skipped"), because docker is opt-in and "skipped" would imply
            // we tried and chose not to run it.
            val isDockerized = service.dockerizedPackages.containsKey(pkg.relDir.substringAfterLast("/"))
            if (isDockerized) {
                tasksMap["dockerBuild"] = mapTaskState(subproject?.tasks?.findByName("dockerBuild"))
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

        // Merge existing stamp in scope mode so we don't drop entries for
        // packages that weren't in this run's scope.
        val mergedEntries = linkedMapOf<String, PackageStampEntry>()
        if (gateScope != null) {
            val existing = GateStampIO.read(rootStampFile)
            if (existing != null) {
                mergedEntries.putAll(existing.packages)
            }
        }
        mergedEntries.putAll(packageEntries)

        // Sort packages by name so every user gets the same gate-stamp.json
        // regardless of filesystem directory ordering.
        val sortedEntries = mergedEntries.entries
            .sortedBy { it.key }
            .associateTo(linkedMapOf()) { it.toPair() }

        val stamp = GateStamp(
            version = 1,
            branch = branch,
            packages = sortedEntries,
        )

        GateStampIO.write(rootStampFile, stamp)
        if (gateScope != null) {
            logger.lifecycle("Wrote ${rootStampFile.name} (scope=$gateScope, ${packageEntries.size} updated / ${sortedEntries.size} total)")
        } else {
            logger.lifecycle("Wrote ${rootStampFile.name} with ${packageEntries.size} packages")
        }

        // Emit gate_stamp_written event so the display renders an explicit
        // footer confirming the stamp exists and how many packages it covers.
        @Suppress("UNCHECKED_CAST")
        val emitter = (rootProject.extensions.extraProperties["monorepoEventEmitter"]
            as? org.gradle.api.provider.Provider<com.zerobias.buildtools.lifecycle.EventEmitter>)
        emitter?.get()?.emitGateStampWritten(rootStampFile.name, packageEntries.size)
    }
}

// Wipe stale per-task logs + the events file whenever `:monorepoGate` is
// in the task graph. Stale logs from previous runs mislead debugging —
// e.g. a failed test from version 1.0.37 left `app-test.log` behind and
// made it look like the current run's :app:test was failing when the task
// hadn't even been invoked.
//
// taskGraph.whenReady runs AFTER gradle builds the graph but BEFORE any
// task executes, so there's no race against writers. We only wipe when
// monorepoGate is actually being invoked — ad-hoc `./gradlew :pkg:test`
// runs leave logs alone so users can inspect their most recent work.
gradle.taskGraph.whenReady {
    val gateInGraph = allTasks.any { it.path == ":monorepoGate" }
    if (!gateInGraph) return@whenReady

    val logsDir = rootProject.file("$ZBB_GRADLE_DIR/logs")
    if (logsDir.exists()) {
        logsDir.deleteRecursively()
    }
    logsDir.mkdirs()

    // The events file is truncated-on-open by EventEmitter's
    // writer, but we delete it here too so there's no window where users
    // might look at a half-stale file while the build is spinning up.
    val eventsFile = rootProject.file("$ZBB_GRADLE_DIR/events.jsonl")
    if (eventsFile.exists()) {
        eventsFile.delete()
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

    // When --clean is active, verifyNoLocalRegistry wipes stale node_modules
    // entries and lockfile entries. workspaceInstall must run AFTER that so
    // npm install re-resolves the cleaned packages from the public registry.
    rootProject.tasks.findByName("workspaceInstall")?.mustRunAfter(verifyNoLocalRegistry)

    // monorepoPublishDryRun lives in zb.monorepo-publish (sibling plugin).
    // When applied, it must also run both root-level guards so direct
    // invocation doesn't bypass the gate's localhost-URL or prepublish-leftover
    // checks.
    rootProject.tasks.findByName("monorepoPublishDryRun")?.dependsOn(verifyNoLocalRegistry)
    rootProject.tasks.findByName("monorepoPublishDryRun")?.dependsOn(verifyNoPrepublishLeftover)
}
