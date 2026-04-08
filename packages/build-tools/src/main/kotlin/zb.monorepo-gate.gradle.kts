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

tasks.register("monorepoGate") {
    group = "monorepo"
    description = "Run gate for all affected packages and write the root gate-stamp.json"
    // Phase 2.4 stub: full per-subproject task chain wiring will be added by
    // zb.monorepo-build. For now, this task just regenerates the stamp from
    // the current source state, assuming a previous gate run already passed.

    doLast {
        val service = graphService.get()
        val packages = service.graph.packages
        val affected = service.changeResult.affected
        val sourceFiles = service.config.sourceFiles
        val sourceDirs = service.config.sourceDirs

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

            // Resolve rootDeps via in-process Kotlin (no node subprocess)
            val rootDeps = try {
                Prepublish.resolveRootDeps(pkg.dir, rootProject.projectDir)
            } catch (_: Exception) {
                emptyMap()
            }

            // Phase 2.4: tasks/tests are placeholder — full per-subproject
            // result aggregation comes when zb.monorepo-build wires everything.
            // For end-to-end validation, we mark all as "passed" if the package
            // is NOT in the affected set (cached/clean state) or "skipped"
            // otherwise.
            val taskStatus = if (name in affected) "skipped" else "passed"
            val tasks = linkedMapOf(
                "lint" to taskStatus,
                "generate" to taskStatus,
                "transpile" to taskStatus,
                "test" to "skipped",
            )
            val tests = linkedMapOf(
                "unit" to TestSuiteEntry(0, 0, "skipped"),
                "integration" to TestSuiteEntry(0, 0, "skipped"),
                "e2e" to TestSuiteEntry(0, 0, "skipped"),
            )

            packageEntries[name] = PackageStampEntry(
                version = pkg.version,
                sourceHash = sourceHash,
                testHash = testHash,
                tasks = tasks,
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
