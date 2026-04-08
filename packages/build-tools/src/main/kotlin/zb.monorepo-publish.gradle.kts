/**
 * Publish orchestration plugin for zbb monorepos. Applied at the root project.
 *
 * Mirrors `lib/monorepo/Publisher.ts` but uses the Kotlin Prepublish.kt port
 * (no node subprocess) and Gradle's task graph for ordering + concurrency.
 *
 * Per-subproject tasks (registered for each non-private workspace package):
 *   - prepublishPackage  : runs Prepublish.resolve() to mutate package.json
 *                          with resolved root deps (creates .prepublish-backup)
 *   - publishPackage     : runs `npm publish` from the package dir
 *                          dependsOn(prepublishPackage)
 *                          finalizedBy(restorePackage)  ← always cleans up
 *   - restorePackage     : restores package.json from backup, idempotent
 *
 * Root tasks:
 *   - monorepoPublish : aggregator that depends on all eligible per-package
 *                       publishPackage tasks. Eligibility: not private, not
 *                       in monorepo.skipPublish. Validates the gate stamp
 *                       before publishing (refuses if any package's stamp
 *                       is invalid, unless -PskipStampCheck=true).
 *
 * --dry-run support: pass `-PdryRun=true` (zbb appends this when you run
 *  `zbb publish --dry-run`). prepublishPackage runs in dry-run mode (no
 *  file mutation), publishPackage skips the actual `npm publish`.
 *
 * Usage:
 *   plugins {
 *       id("zb.monorepo-base")
 *       id("zb.monorepo-publish")
 *   }
 */

import com.zerobias.buildtools.monorepo.GateStampIO
import com.zerobias.buildtools.monorepo.GateStampResult
import com.zerobias.buildtools.monorepo.MonorepoGraphService
import com.zerobias.buildtools.monorepo.Prepublish
import com.zerobias.buildtools.monorepo.StampValidator
import com.fasterxml.jackson.databind.ObjectMapper
import com.fasterxml.jackson.module.kotlin.readValue
import com.fasterxml.jackson.module.kotlin.registerKotlinModule
import org.gradle.api.tasks.Exec

@Suppress("UNCHECKED_CAST")
val graphService = (project.extensions.extraProperties["monorepoGraphService"]
    as org.gradle.api.provider.Provider<MonorepoGraphService>)

// ── CLI flags from zbb (passed via -P properties) ────────────────────
val publishDryRun = (project.findProperty("dryRun") as? String)?.toBoolean() ?: false
val publishForce = (project.findProperty("force") as? String)?.toBoolean() ?: false
val publishSkipStampCheck = (project.findProperty("skipStampCheck") as? String)?.toBoolean() ?: false

// ── Helper: current git branch ───────────────────────────────────────
fun currentBranch(repoRoot: java.io.File): String {
    return try {
        val proc = ProcessBuilder("git", "rev-parse", "--abbrev-ref", "HEAD")
            .directory(repoRoot)
            .redirectErrorStream(false)
            .start()
        proc.waitFor()
        proc.inputStream.bufferedReader().readText().trim()
    } catch (_: Exception) {
        "unknown"
    }
}

// ── publishGuard — branch + stamp validation, runs FIRST ───────────
//
// Separate task so it runs BEFORE any per-package publishPackage actions.
// (If we used doFirst on monorepoPublish, it would run AFTER its
// dependencies — too late to prevent npm publish from executing.)

val publishGuard = tasks.register("publishGuard") {
    group = "monorepo"
    description = "Branch + gate stamp validation gate for publish (runs before any npm publish)"

    doLast {
        val service = graphService.get()
        val rootDir = rootProject.projectDir

        // ── Branch guard ──
        if (!publishForce && !publishDryRun) {
            val branch = currentBranch(rootDir)
            if (branch != "main" && branch != "master") {
                throw GradleException(
                    "Cannot publish from branch '$branch'. Switch to main, " +
                    "or pass -Pforce=true / --dry-run."
                )
            }
        }

        // ── Gate stamp validation ──
        if (!publishSkipStampCheck && !publishForce) {
            val stampFile = rootDir.resolve("gate-stamp.json")
            val stamp = GateStampIO.read(stampFile)
            if (stamp == null) {
                throw GradleException(
                    "gate-stamp.json not found at ${stampFile.absolutePath}.\n" +
                    "Run `zbb gate` first, or pass -PskipStampCheck=true to bypass."
                )
            }

            val validator = StampValidator(
                sourceFiles = service.config.sourceFiles,
                sourceDirs = service.config.sourceDirs,
                testPhases = service.config.testPhases.toSet(),
            )
            val rootPkg: Map<String, Any?>? = try {
                @Suppress("UNCHECKED_CAST")
                ObjectMapper().registerKotlinModule()
                    .readValue<Map<String, Any?>>(rootDir.resolve("package.json"))
            } catch (_: Exception) { null }

            val invalid = mutableListOf<String>()
            for ((name, pkg) in service.graph.packages) {
                if (pkg.private) continue
                if (service.config.skipPublish.contains(name)) continue
                val result = validator.validate(pkg.dir, name, stamp, rootPkg)
                if (result != GateStampResult.VALID) {
                    invalid.add("$name: $result")
                }
            }
            if (invalid.isNotEmpty()) {
                throw GradleException(
                    "gate-stamp.json is invalid for these packages:\n  " +
                    invalid.joinToString("\n  ") +
                    "\nRun `zbb gate` to refresh, then commit and retry."
                )
            }
            logger.lifecycle("[publish] gate stamp valid for all eligible packages")
        }

        if (publishDryRun) {
            logger.lifecycle("[publish] DRY RUN — no files mutated, no `npm publish` executed")
        }
    }
}

// ── Root-level monorepoPublish (deps wired in projectsEvaluated) ──

val monorepoPublish = tasks.register("monorepoPublish") {
    group = "monorepo"
    description = "Publish all non-private workspace packages (gated by publishGuard)"
    dependsOn(publishGuard)
}

// ── Per-subproject task wiring (after projectsEvaluated) ────────────

gradle.projectsEvaluated {
    val service = graphService.get()
    val rootDir = rootProject.projectDir

    for ((pkgName, pkg) in service.graph.packages) {
        if (pkg.private) continue
        if (service.config.skipPublish.contains(pkgName)) continue

        val gradlePath = ":" + pkg.relDir.replace("/", ":")
        val subproject = rootProject.findProject(gradlePath) ?: continue

        // ── prepublishPackage ──
        val prepublishTask = subproject.tasks.register("prepublishPackage") {
            group = "monorepo"
            description = "Run Kotlin Prepublish for $pkgName (mutates package.json with resolved root deps)"
            doLast {
                logger.lifecycle("[prepublish] $pkgName")
                if (publishDryRun) {
                    val result = Prepublish.resolve(pkg.dir, rootDir, Prepublish.Options(dryRun = true))
                    logger.lifecycle("[prepublish] DRY RUN: ${result.dependencies.size} resolved deps")
                } else {
                    Prepublish.resolve(pkg.dir, rootDir, Prepublish.Options())
                }
            }
        }

        // ── restorePackage (idempotent — safe to call without prior prepublish) ──
        val restoreTask = subproject.tasks.register("restorePackage") {
            group = "monorepo"
            description = "Restore $pkgName package.json from .prepublish-backup (idempotent)"
            doLast {
                val backup = pkg.dir.resolve("package.json.prepublish-backup")
                val target = pkg.dir.resolve("package.json")
                if (backup.exists()) {
                    backup.copyTo(target, overwrite = true)
                    backup.delete()
                    logger.lifecycle("[restore] $pkgName: package.json restored")
                }
            }
        }

        // ── publishPackage ──
        subproject.tasks.register<Exec>("publishPackage") {
            group = "monorepo"
            description = "Run `npm publish` for $pkgName"
            workingDir = pkg.dir

            // Default: `npm publish --access public`. Repos can override per-
            // package via a `publish` npm script if they need different flags.
            val publishScript = pkg.scripts["publish"]
            commandLine = if (publishScript != null && publishScript.isNotBlank()) {
                listOf("npm", "run", "publish")
            } else {
                listOf("npm", "publish", "--access", "public")
            }

            // Guard runs BEFORE any per-package work; prepublish prepares the
            // package.json; restore always runs (even on failure) to clean up.
            dependsOn(publishGuard)
            dependsOn(prepublishTask)
            finalizedBy(restoreTask)

            onlyIf {
                if (publishDryRun) {
                    logger.lifecycle("[publish] DRY RUN: would run ${commandLine.joinToString(" ")} in ${pkg.dir}")
                    false  // skip execution
                } else {
                    true
                }
            }
        }
    }

    // ── Wire root monorepoPublish to depend on all per-package publishPackage tasks ──
    monorepoPublish.configure {
        for ((pkgName, pkg) in service.graph.packages) {
            if (pkg.private) continue
            if (service.config.skipPublish.contains(pkgName)) continue
            val gradlePath = ":" + pkg.relDir.replace("/", ":")
            val subproject = rootProject.findProject(gradlePath) ?: continue
            subproject.tasks.findByName("publishPackage")?.let { dependsOn(it) }
        }
    }
}
