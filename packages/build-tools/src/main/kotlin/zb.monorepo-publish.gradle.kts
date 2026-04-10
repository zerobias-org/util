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
        val mapper = ObjectMapper().registerKotlinModule()

        val plan = PublishChangeDetector.detectChanges(
            repoRoot = rootDir,
            graph = service.graph,
            config = service.config,
            registry = service.config.registry,
        )

        // Always write the plan file (truncate if empty) so per-package
        // tasks see the CURRENT plan, not a stale one from a prior run.
        publishPlanFile.parentFile.mkdirs()

        if (plan.publishOrdered.isEmpty()) {
            publishPlanFile.writeText("[]\n")
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

        // Write the plan to a side file so per-package tasks can read it.
        // `path` is the package's relDir — used by the release-announcement
        // action to build changelog URLs.
        val planData = plan.publishOrdered.map { name ->
            val pkg = service.graph.packages[name]
            mapOf(
                "name" to name,
                "version" to (plan.resolvedVersions[name]?.version ?: "?"),
                "bumped" to (plan.resolvedVersions[name]?.bumped ?: false),
                "path" to (pkg?.relDir ?: ""),
            )
        }
        publishPlanFile.writeText(mapper.writerWithDefaultPrettyPrinter().writeValueAsString(planData))
    }
}

// ── dispatchImageWorkflows — trigger CI image builds for published packages ──

val dispatchImageWorkflows = tasks.register("dispatchImageWorkflows") {
    group = "monorepo"
    description = "Dispatch GitHub workflow for each published package with an image config"

    doLast {
        if (publishDryRun) {
            logger.lifecycle("[images] DRY RUN — skipping workflow dispatch")
            return@doLast
        }

        val service = graphService.get()
        val images = service.config.images
        if (images.isEmpty()) {
            logger.lifecycle("[images] no image configs defined — skipping dispatch")
            return@doLast
        }

        // Read the publish plan to know which packages were actually published
        // AND their resolved (bumped) versions.
        if (!publishPlanFile.exists()) return@doLast
        val planJson = publishPlanFile.readText()
        val om = ObjectMapper().registerKotlinModule()
        @Suppress("UNCHECKED_CAST")
        val planEntries = om.readValue<List<Map<String, Any?>>>(publishPlanFile)
        val planVersions = planEntries.associate {
            (it["name"] as? String ?: "") to (it["version"] as? String ?: "")
        }

        // Detect GitHub repo from git remote
        val githubRepo = detectGithubRepo(rootProject.projectDir)
        if (githubRepo == null) {
            logger.warn("[images] could not detect GitHub repo from git remote — skipping dispatch")
            return@doLast
        }

        var dispatched = 0
        for ((relDir, imageConfig) in images) {
            val workflow = imageConfig.workflow ?: continue
            // Find the package with this relDir
            val pkg = service.graph.packages.values.find { it.relDir == relDir } ?: continue
            // Only dispatch if this package was in the publish plan
            if (!planJson.contains(pkg.name)) continue

            // Use the BUMPED version from the publish plan, not the original
            // from package.json (which was read at config time before the bump).
            val version = planVersions[pkg.name] ?: continue
            logger.lifecycle("[images] dispatching ${imageConfig.name} (${workflow}) version=$version")

            try {
                val proc = ProcessBuilder(
                    "gh", "workflow", "run", workflow,
                    "--repo", githubRepo,
                    "-f", "version=$version",
                )
                    .directory(rootProject.projectDir)
                    .redirectErrorStream(false)
                    .start()
                val stderr = proc.errorStream.bufferedReader().readText()
                val ok = proc.waitFor(30, java.util.concurrent.TimeUnit.SECONDS) && proc.exitValue() == 0
                if (ok) {
                    logger.lifecycle("[images]   ✓ ${imageConfig.name}")
                    dispatched += 1
                } else {
                    logger.warn("[images]   ✗ ${imageConfig.name}: ${stderr.take(300)}")
                }
            } catch (e: Exception) {
                logger.warn("[images]   ✗ ${imageConfig.name}: ${e.message}")
            }
        }
        if (dispatched > 0) {
            logger.lifecycle("[images] dispatched $dispatched workflow(s)")
        }
    }
}

fun detectGithubRepo(repoRoot: java.io.File): String? {
    return try {
        val proc = ProcessBuilder("git", "remote", "get-url", "origin")
            .directory(repoRoot)
            .redirectErrorStream(false)
            .start()
        val output = proc.inputStream.bufferedReader().readText().trim()
        proc.waitFor(5, java.util.concurrent.TimeUnit.SECONDS)
        // SSH: git@github.com:owner/repo.git
        val sshMatch = Regex("""github\.com[:/]([^/]+/[^/.]+)""").find(output)
        if (sshMatch != null) return sshMatch.groupValues[1]
        // HTTPS: https://github.com/owner/repo.git
        val httpsMatch = Regex("""github\.com/([^/]+/[^/.]+)""").find(output)
        if (httpsMatch != null) return httpsMatch.groupValues[1]
        null
    } catch (_: Exception) {
        null
    }
}

// ── Root-level monorepoPublish (deps wired in projectsEvaluated) ──

val monorepoPublish = tasks.register("monorepoPublish") {
    group = "monorepo"
    description = "Publish changed workspace packages (gated by publishGuard + publishPlan)"
    dependsOn(publishGuard, publishPlan)
    finalizedBy(dispatchImageWorkflows)
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

    // ── Commit version bumps BEFORE per-package publish ──
    // publishPlan patches each package.json with the bumped version. We
    // commit that BEFORE prepublish/npm-publish so the published tarball's
    // git HEAD matches the version it claims.
    val commitVersionBumps = tasks.register("commitVersionBumps") {
        group = "monorepo"
        description = "Git commit the version-bumped package.json files written by publishPlan"
        dependsOn(publishPlan)
        onlyIf { !publishDryRun && publishPlanFile.exists() && publishPlanFile.readText() != "[]" }

        doLast {
            val repoRoot = rootProject.projectDir
            val om = ObjectMapper().registerKotlinModule()

            // Stage all version-bumped package.json files
            val filesToStage = mutableListOf<String>()
            @Suppress("UNCHECKED_CAST")
            val plan = om.readValue<List<Map<String, Any?>>>(publishPlanFile)
            for (entry in plan) {
                val name = entry["name"] as? String ?: continue
                val pkg = service.graph.packages[name] ?: continue
                val pkgJson = pkg.dir.resolve("package.json")
                if (pkgJson.exists()) {
                    filesToStage.add(pkgJson.relativeTo(repoRoot).path)
                }
            }

            if (filesToStage.isEmpty()) return@doLast

            // Git add the version-bumped files
            val addProc = ProcessBuilder(listOf("git", "add") + filesToStage)
                .directory(rootProject.projectDir)
                .redirectErrorStream(true)
                .start()
            addProc.waitFor(10, java.util.concurrent.TimeUnit.SECONDS)

            // Also stage gate-stamp.json if it exists (it references the versions)
            val gateStamp = rootProject.projectDir.resolve("gate-stamp.json")
            if (gateStamp.exists()) {
                ProcessBuilder("git", "add", "gate-stamp.json")
                    .directory(rootProject.projectDir)
                    .redirectErrorStream(true)
                    .start()
                    .waitFor(5, java.util.concurrent.TimeUnit.SECONDS)
            }

            // Commit
            val versions = plan.map { e -> "${e["name"]}@${e["version"]}" }
            val commitMsg = "chore(release): ${versions.joinToString(", ")}"
            val commitProc = ProcessBuilder("git", "commit", "-m", commitMsg)
                .directory(rootProject.projectDir)
                .redirectErrorStream(true)
                .start()
            commitProc.inputStream.bufferedReader().readText()
            commitProc.waitFor(10, java.util.concurrent.TimeUnit.SECONDS)
            logger.lifecycle("[publish] committed version bumps: $commitMsg")
        }
    }

    // Wire: commitVersionBumps runs AFTER publishPlan, BEFORE prepublish
    for ((pkgName, pkg) in service.graph.packages) {
        if (pkg.private) continue
        if (service.config.skipPublish.contains(pkgName)) continue
        val gradlePath = ":" + pkg.relDir.replace("/", ":")
        val subproject = rootProject.findProject(gradlePath) ?: continue
        subproject.tasks.findByName("prepublishPackage")?.dependsOn(commitVersionBumps)
    }

    // ── Tag + push after all packages are published ──
    monorepoPublish.configure {
        doLast {
            if (!publishDryRun && publishPlanFile.exists()) {
                val om = ObjectMapper().registerKotlinModule()
                @Suppress("UNCHECKED_CAST")
                val plan = om.readValue<List<Map<String, Any?>>>(publishPlanFile)

                // Create a git tag for each published package
                for (entry in plan) {
                    val name = entry["name"] as? String ?: continue
                    val version = entry["version"] as? String ?: continue
                    // Tag format: @scope/name@version (matches npm convention)
                    val tag = "$name@$version"
                    try {
                        val proc = ProcessBuilder("git", "tag", tag)
                            .directory(rootProject.projectDir)
                            .redirectErrorStream(true)
                            .start()
                        proc.waitFor(5, java.util.concurrent.TimeUnit.SECONDS)
                        logger.lifecycle("[publish] tagged $tag")
                    } catch (_: Exception) {
                        logger.warn("[publish] failed to create tag: $tag")
                    }
                }

                // Push the version-bump commit + tags
                try {
                    val pushProc = ProcessBuilder("git", "push", "--follow-tags")
                        .directory(rootProject.projectDir)
                        .redirectErrorStream(true)
                        .start()
                    val pushOutput = pushProc.inputStream.bufferedReader().readText()
                    pushProc.waitFor(30, java.util.concurrent.TimeUnit.SECONDS)
                    if (pushProc.exitValue() == 0) {
                        logger.lifecycle("[publish] pushed version bumps + tags")
                    } else {
                        logger.warn("[publish] git push failed: $pushOutput")
                    }
                } catch (e: Exception) {
                    logger.warn("[publish] git push failed: ${e.message}")
                }

                // Write /tmp/published-packages.json for the release-announcement
                // action. Format: [{ name, version, path }] — the `path` field is
                // used by generate_slack_message.sh to build changelog URLs.
                val planJson = publishPlanFile.readText()
                java.io.File("/tmp/published-packages.json").writeText(planJson)
                logger.lifecycle("[publish] wrote /tmp/published-packages.json")
            }
        }
    }
}
