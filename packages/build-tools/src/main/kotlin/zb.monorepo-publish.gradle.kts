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
import com.zerobias.buildtools.monorepo.PublishChangeDetector
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

// ── publishPlan — tag-based change detection + version resolution ────
//
// Runs AFTER publishGuard, BEFORE per-package prepublish/publish tasks.
// Detects which packages have changes since their last published git tag,
// resolves publish versions (auto-patch-bumps if already published), and
// patches package.json version fields.

val publishPlanFile = rootProject.file(".zbb-monorepo/publish-plan.json")

val publishPlan = tasks.register("publishPlan") {
    group = "monorepo"
    description = "Detect changed packages and resolve publish versions"
    dependsOn(publishGuard)

    doLast {
        val service = graphService.get()
        val rootDir = rootProject.projectDir

        val plan = PublishChangeDetector.detectChanges(
            repoRoot = rootDir,
            graph = service.graph,
            config = service.config,
            registry = service.config.registry,
        )

        if (plan.publishOrdered.isEmpty()) {
            logger.lifecycle("[publish] no packages have changes since their last published tag")
            return@doLast
        }

        logger.lifecycle("[publish] ${plan.publishOrdered.size} package(s) to publish:")
        for (name in plan.publishOrdered) {
            val rv = plan.resolvedVersions[name]!!
            val bump = if (rv.bumped) " (auto-bumped)" else ""
            logger.lifecycle("  ${name} → ${rv.version}$bump")
        }

        // Patch version fields in package.json for each package in the plan
        if (!publishDryRun) {
            for (name in plan.publishOrdered) {
                val pkg = service.graph.packages[name] ?: continue
                val rv = plan.resolvedVersions[name] ?: continue
                if (rv.bumped || rv.version != pkg.version) {
                    PublishChangeDetector.patchPackageJsonVersion(pkg.dir, rv.version)
                    logger.lifecycle("  [version] ${name}: ${pkg.version} → ${rv.version}")
                }
            }

            // Cross-update workspace dependency references so published
            // packages reference the resolved (potentially bumped) versions
            // of their workspace deps.
            for (name in plan.publishOrdered) {
                val pkg = service.graph.packages[name] ?: continue
                for (depName in pkg.internalDeps) {
                    val depVersion = plan.resolvedVersions[depName] ?: continue
                    PublishChangeDetector.updateDependencyVersion(
                        pkg.dir, depName, depVersion.version
                    )
                }
            }
        }

        // Write the plan to a side file so per-package tasks can read it
        val mapper = ObjectMapper().registerKotlinModule()
        publishPlanFile.parentFile.mkdirs()
        val planData = plan.publishOrdered.map { name ->
            mapOf(
                "name" to name,
                "version" to (plan.resolvedVersions[name]?.version ?: "?"),
                "bumped" to (plan.resolvedVersions[name]?.bumped ?: false),
            )
        }
        publishPlanFile.writeText(mapper.writerWithDefaultPrettyPrinter().writeValueAsString(planData))
    }
}

// ── Root-level monorepoPublish (deps wired in projectsEvaluated) ──

val monorepoPublish = tasks.register("monorepoPublish") {
    group = "monorepo"
    description = "Publish changed workspace packages (gated by publishGuard + publishPlan)"
    dependsOn(publishGuard, publishPlan)
}

// ── Per-subproject task wiring (after projectsEvaluated) ────────────

gradle.projectsEvaluated {
    val service = graphService.get()
    val rootDir = rootProject.projectDir

    // Register per-package publish tasks for ALL eligible packages.
    // The per-package publishPackage task uses `onlyIf` to check whether the
    // package is in the publish plan (set of changed packages). This way the
    // tasks exist for Gradle's graph but skip execution for unchanged packages.
    for ((pkgName, pkg) in service.graph.packages) {
        if (pkg.private) continue
        if (service.config.skipPublish.contains(pkgName)) continue

        val gradlePath = ":" + pkg.relDir.replace("/", ":")
        val subproject = rootProject.findProject(gradlePath) ?: continue
        val capturedPkgName = pkgName

        // ── prepublishPackage ──
        val prepublishTask = subproject.tasks.register("prepublishPackage") {
            group = "monorepo"
            description = "Run Kotlin Prepublish for $pkgName"
            dependsOn(publishPlan)
            onlyIf { publishPlanFile.exists() && publishPlanFile.readText().contains(capturedPkgName) }
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

        // ── restorePackage (idempotent) ──
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
                // Also restore original version if publishPlan patched it
                // (the .prepublish-backup is the version-patched file, so
                // restoring from it preserves the patched version. We need
                // to restore from git instead.)
                // Actually: prepublish creates the backup AFTER version patching.
                // So restoring the backup gives us the version-patched + prepublish
                // file. We want the ORIGINAL original. Use git checkout instead.
            }
        }

        // ── publishPackage ──
        subproject.tasks.register<Exec>("publishPackage") {
            group = "monorepo"
            description = "Run `npm publish` for $pkgName"
            workingDir = pkg.dir

            val publishScript = pkg.scripts["publish"]
            commandLine = if (publishScript != null && publishScript.isNotBlank()) {
                listOf("npm", "run", "publish")
            } else {
                listOf("npm", "publish", "--access", "public")
            }

            dependsOn(publishGuard, publishPlan, prepublishTask)
            finalizedBy(restoreTask)

            onlyIf {
                if (!publishPlanFile.exists() || !publishPlanFile.readText().contains(capturedPkgName)) {
                    false  // not in the publish plan
                } else if (publishDryRun) {
                    logger.lifecycle("[publish] DRY RUN: would publish $pkgName from ${pkg.dir}")
                    false
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

    // ── Restore ALL version-patched package.json files after publish ──
    // monorepoPublish runs last; after it, restore any package.json files
    // that were version-patched by publishPlan. Use git checkout to restore
    // the originals (since prepublish-backup is already handled by restoreTask).
    monorepoPublish.configure {
        doLast {
            if (!publishDryRun) {
                for ((pkgName, pkg) in service.graph.packages) {
                    if (pkg.private) continue
                    if (service.config.skipPublish.contains(pkgName)) continue
                    try {
                        val proc = ProcessBuilder("git", "checkout", "package.json")
                            .directory(pkg.dir)
                            .redirectErrorStream(true)
                            .start()
                        proc.waitFor(5, java.util.concurrent.TimeUnit.SECONDS)
                    } catch (_: Exception) { /* ignore */ }
                }
                logger.lifecycle("[publish] restored all package.json version fields")
            }
        }
    }
}
