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
import com.zerobias.buildtools.util.PathConstants.ZBB_GRADLE_DIR
import com.zerobias.buildtools.monorepo.StampValidator
import com.zerobias.buildtools.util.ReleaseAnnouncement
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
        //
        // --force does NOT bypass this — it only bypasses the gate stamp
        // validation below. Use --dry-run to preview from a feature branch.
        if (!publishDryRun) {
            val branch = currentBranch(rootDir)
            if (branch != "main" && branch != "master") {
                throw GradleException(
                    "Cannot publish from branch '$branch'. Switch to main, " +
                    "or pass --dry-run."
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

val publishPlanFile = rootProject.file("$ZBB_GRADLE_DIR/publish-plan.json")

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

        // Version patching (patchPackageJsonVersion + cross-workspace
        // updateDependencyVersion) deliberately DOES NOT run here — it is
        // deferred to commitVersionBumps.doLast so every per-package build
        // runs against the ORIGINAL package.json state (same state `zbb
        // gate` sees locally). Building against the pre-bump state is how
        // we guarantee local-gate / CI-publish parity; bumping then
        // running the build causes workspace resolution to see versions
        // that don't exist on the registry yet.

        // Write the plan to a side file so per-package tasks can read it.
        // `path` is the package's relDir — used by the release-announcement
        // action to build changelog URLs.
        val planData = plan.publishOrdered.map { name ->
            val pkg = service.graph.packages[name]
            mapOf(
                "name" to name,
                "version" to (plan.resolvedVersions[name]?.version ?: "?"),
                "bumped" to (plan.resolvedVersions[name]?.bumped ?: false),
                // `location` is what the release-announcement action's
                // generate_slack_message.sh reads for changelog URLs and
                // what the publish-release-event code uses for package dirs.
                "location" to (pkg?.relDir ?: ""),
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
        val githubRepo = ReleaseAnnouncement.detectGithubRepo(rootProject.projectDir)
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
            if (!planJson.contains("\"${pkg.name}\"")) continue

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


// ── publishJavaPackages — maven-central publish for Java workspaces ──
//
// Discovers every package applying `zb.maven-central-publish` (scanning
// packages/*/build.gradle(.kts)), runs change detection against the
// package's last `<name>-v*` annotated tag, and for changed packages:
//   1. Resolves the next version by querying the package's own Gradle
//      (which uses VersionResolver to check Maven Central + GH Packages
//      metadata) — so two publishes never collide on the same version.
//   2. Spawns `./gradlew publishAndReleaseToMavenCentral` in the package's
//      own Gradle root. These Java packages are deliberately NOT included
//      as monorepo subprojects (see util's settings.gradle.kts), so they
//      must be invoked as standalone Gradle builds.
//   3. On success, creates an annotated tag `<name>-v<version>` pointing
//      at HEAD. Annotated tags are required so the `git push --follow-tags`
//      in monorepoPublish.doLast actually pushes them (lightweight tags
//      are ignored by --follow-tags).
//
// Tag-based change detection (not HEAD~1) means a failed publish retries
// on the next push even if that push didn't touch the package — the diff
// still reaches back to the last SUCCESSFUL tag, so the unpublished change
// remains visible to the detector until it's tagged.
//
// Env inheritance: this task spawns `./gradlew` as a child process, which
// inherits all env vars including the ORG_GRADLE_PROJECT_* signing +
// Sonatype creds that `zbb exec` (or the CI workflow's vault-action step)
// exported into the parent process.

fun discoverJavaPackages(repoRoot: java.io.File): List<java.io.File> {
    val packagesDir = repoRoot.resolve("packages")
    if (!packagesDir.isDirectory) return emptyList()
    return packagesDir.listFiles()
        ?.filter { it.isDirectory }
        ?.filter { dir ->
            listOf(dir.resolve("build.gradle"), dir.resolve("build.gradle.kts")).any { f ->
                f.exists() && f.readText().contains("zb.maven-central-publish")
            }
        }
        ?.sortedBy { it.name }
        ?: emptyList()
}

fun runGit(repoRoot: java.io.File, vararg args: String): Pair<Int, String> {
    val proc = ProcessBuilder(listOf("git") + args)
        .directory(repoRoot)
        .redirectErrorStream(true)
        .start()
    val output = proc.inputStream.bufferedReader().readText()
    proc.waitFor(30, java.util.concurrent.TimeUnit.SECONDS)
    return proc.exitValue() to output
}

fun resolveGradleVersion(pkgDir: java.io.File): String? {
    return try {
        val proc = ProcessBuilder("./gradlew", "-q", "properties")
            .directory(pkgDir)
            .redirectErrorStream(false)
            .start()
        val stdout = proc.inputStream.bufferedReader().readText()
        proc.waitFor(300, java.util.concurrent.TimeUnit.SECONDS)
        if (proc.exitValue() != 0) return null
        stdout.lines()
            .firstOrNull { it.startsWith("version: ") }
            ?.substringAfter("version: ")
            ?.trim()
            ?.takeIf { it.isNotBlank() }
    } catch (_: Exception) {
        null
    }
}

val javaPublishFile = rootProject.file("$ZBB_GRADLE_DIR/java-publish.json")

val publishJavaPackages = tasks.register("publishJavaPackages") {
    group = "monorepo"
    description = "Publish Java packages (zb.maven-central-publish consumers) to Maven Central and tag"

    doLast {
        val repoRoot = rootProject.projectDir
        val javaPkgs = discoverJavaPackages(repoRoot)

        // Start fresh each run so stale entries from a prior failed run
        // don't leak into this run's announcement.
        javaPublishFile.parentFile.mkdirs()
        javaPublishFile.writeText("[]\n")

        if (javaPkgs.isEmpty()) {
            logger.lifecycle("[java-publish] no packages apply zb.maven-central-publish — nothing to do")
            return@doLast
        }

        // Coordinates the publishJavaPackages task shares with
        // monorepoPublish.doLast for Slack announce. Each successful
        // publish appends {name, version, location} so the announce
        // picks up Java releases alongside npm ones.
        val publishedForAnnounce = mutableListOf<Map<String, String>>()

        val failures = mutableListOf<String>()
        var published = 0
        var skipped = 0

        for (pkgDir in javaPkgs) {
            val name = pkgDir.name

            val (tagListExit, tagListOut) = runGit(
                repoRoot, "tag", "-l", "$name-v*", "--sort=-version:refname"
            )
            val latestTag = if (tagListExit == 0) {
                tagListOut.lines().firstOrNull()?.trim()?.takeIf { it.isNotEmpty() }
            } else null

            // Bootstrap case: no prior `<name>-v*` tag means this package has
            // never been published through this flow. Publish unconditionally
            // to establish the baseline tag. Falling back to HEAD~1 here is
            // wrong: if the triggering commit didn't touch the package, we'd
            // skip a package that genuinely needs its first publish —
            // especially when a previous run failed before tagging. Once
            // `<name>-v*` exists, tag-based detection takes over.
            if (latestTag == null) {
                logger.lifecycle("[java-publish] $name: no prior $name-v* tag — forcing publish to bootstrap")
            } else {
                // Exclude files that change for npm-side reasons (package.json
                // version bump in chore(release), CHANGELOG generation, lockfile
                // updates) but don't affect the published Java artifact. Without
                // these exclusions, every npm publish in the same dir
                // re-publishes the Java jar at a new version even though the
                // bytecode is byte-identical to the prior tag.
                val (diffExit, diffOut) = runGit(
                    repoRoot, "diff", "--name-only", latestTag, "HEAD", "--",
                    "packages/$name/",
                    ":(exclude)packages/$name/package.json",
                    ":(exclude)packages/$name/package-lock.json",
                    ":(exclude)packages/$name/CHANGELOG.md",
                )
                if (diffExit == 0 && diffOut.isBlank()) {
                    logger.lifecycle("[java-publish] $name unchanged since $latestTag — skipping")
                    skipped++
                    continue
                }
            }

            if (publishDryRun) {
                val reason = latestTag ?: "bootstrap (no prior tag)"
                logger.lifecycle("[java-publish] DRY RUN: would publish $name (changed since $reason)")
                skipped++
                continue
            }

            val version = resolveGradleVersion(pkgDir)
            if (version == null) {
                logger.error("[java-publish] $name: could not resolve version via ./gradlew properties")
                failures.add(name)
                continue
            }

            logger.lifecycle("[java-publish] $name → $version (publishing)")

            // `publish` is the aggregator from zb.maven-central-publish that runs
            // publishToMavenLocal + publishToMavenCentral + publishToGithub. Using
            // it (not `publishAndReleaseToMavenCentral`) ensures the artifact also
            // lands on GitHub Packages, which is what `1.+` resolution actually
            // reads from in CI — Maven Central propagation has historically been
            // lossy for these artifacts and downstream consumers all hit the
            // GitHub Packages mirror anyway.
            val publishProc = ProcessBuilder("./gradlew", "publish")
                .directory(pkgDir)
                .inheritIO()
                .start()
            publishProc.waitFor(30, java.util.concurrent.TimeUnit.MINUTES)

            if (publishProc.exitValue() != 0) {
                logger.error("[java-publish] $name PUBLISH FAILED")
                failures.add(name)
                continue
            }

            val tag = "$name-v$version"
            val (tagCheckExit, _) = runGit(repoRoot, "rev-parse", "--verify", tag)
            if (tagCheckExit == 0) {
                logger.warn("[java-publish] $name: tag $tag already exists — not re-creating")
            } else {
                val (tagExit, tagOut) = runGit(
                    repoRoot, "tag", "-a", tag, "-m", "Release $name@$version"
                )
                if (tagExit == 0) {
                    logger.lifecycle("[java-publish] tagged $tag")
                    published++
                } else {
                    logger.warn("[java-publish] $name: tag creation failed: $tagOut")
                }
            }

            // Record for Slack announce. Name uses the dir — matches what
            // the tag uses and what developers recognize. Location is the
            // relative path from repo root so the changelog URL resolves
            // (even if Java packages typically don't ship CHANGELOG.md).
            publishedForAnnounce.add(
                mapOf("name" to name, "version" to version, "location" to "packages/$name")
            )
        }

        val mapper = com.fasterxml.jackson.databind.ObjectMapper()
        javaPublishFile.writeText(
            mapper.writerWithDefaultPrettyPrinter().writeValueAsString(publishedForAnnounce)
        )

        logger.lifecycle("[java-publish] summary: published=$published skipped=$skipped failed=${failures.size}")

        if (failures.isNotEmpty()) {
            throw GradleException("[java-publish] ${failures.size} package(s) failed: ${failures.joinToString(", ")}")
        }
    }
}

// ── Root-level monorepoPublish (deps wired in projectsEvaluated) ──

val monorepoPublish = tasks.register("monorepoPublish") {
    group = "monorepo"
    description = "Build + publish changed workspace packages (monorepoBuild dep added in projectsEvaluated)"
    dependsOn(publishGuard, publishPlan, publishJavaPackages)
    finalizedBy(dispatchImageWorkflows)
}

// ── monorepoPublishDryRun — validate publish flow without pushing ──
//
// Runs the publish code paths WITHOUT mutating files or pushing anything:
//   1. PublishChangeDetector.detectChanges() — identifies which packages
//      would publish (same logic as publishPlan).
//   2. Prepublish.resolve(dryRun = true) — runs the package.json mutation
//      logic and reports errors without writing files.
//   3. `npm pack --dry-run --json` per package — validates tarball layout
//      and verifies entryCount + unpackedSize are non-trivial. This is the
//      check that would have caught the 2-30 kB empty tarballs from the
//      earlier phase-3 publish bug: if `dist/` is missing, unpackedSize
//      will be orders of magnitude smaller than expected.
//
// Wired into monorepoGate so `zbb gate` locally runs the full publish
// path short of the actual push. This is the guarantee behind "gate
// passes ⇒ publish will pass in CI".
//
// Depends on monorepoBuild (wired in projectsEvaluated below) so dist/
// exists when npm pack inspects the package.
@Suppress("UNCHECKED_CAST")
val eventEmitter = (rootProject.extensions.extraProperties["monorepoEventEmitter"]
    as org.gradle.api.provider.Provider<com.zerobias.buildtools.lifecycle.EventEmitter>)

val monorepoPublishDryRun = tasks.register("monorepoPublishDryRun") {
    group = "monorepo"
    description = "Validate the publish flow without mutating or pushing (change detection + prepublish dry-run + npm pack --dry-run)"
    usesService(eventEmitter)

    doLast {
        val service = graphService.get()
        val rootDir = rootProject.projectDir

        // 1. Change detection — same logic publishPlan uses at publish time.
        val plan = PublishChangeDetector.detectChanges(
            repoRoot = rootDir,
            graph = service.graph,
            config = service.config,
            registry = service.config.registry,
        )

        // Emit publish_plan event so the display can render a summary box.
        // Always emit (even for empty plans) so the display knows the check ran.
        val planEvents = plan.publishOrdered.map { name ->
            val rv = plan.resolvedVersions[name]!!
            Triple(name, rv.version, rv.bumped)
        }
        eventEmitter.get().emitPublishPlan(planEvents)

        if (plan.publishOrdered.isEmpty()) {
            logger.lifecycle("[publish-dry-run] no packages have changes since their last published tag")
            return@doLast
        }

        logger.lifecycle("[publish-dry-run] ${plan.publishOrdered.size} package(s) would publish:")
        for (name in plan.publishOrdered) {
            val rv = plan.resolvedVersions[name]!!
            val bump = if (rv.bumped) " (auto-bumped)" else ""
            logger.lifecycle("  ${name} → ${rv.version}$bump")
        }

        val errors = mutableListOf<String>()
        val mapper = ObjectMapper().registerKotlinModule()

        // 2. prepublish dry-run per package — validates resolve logic
        //    without writing to disk.
        for (name in plan.publishOrdered) {
            val pkg = service.graph.packages[name] ?: continue
            try {
                val targetDir = pkg.publishDirectory?.let { pkg.dir.resolve(it) }
                val result = Prepublish.resolve(
                    pkg.dir, rootDir,
                    Prepublish.Options(dryRun = true, targetDir = targetDir),
                )
                logger.lifecycle("  ✓ ${name}: prepublish would resolve ${result.dependencies.size} deps")
            } catch (e: Exception) {
                errors.add("${name}: prepublish dry-run failed — ${e.message}")
            }
        }

        // 3. npm pack --dry-run per package — validates tarball contents
        //    against the package's own declarations.
        //
        // Principled check: for every entry the package's package.json
        // declares (`files` patterns, `main`, `bin` paths), verify that
        // entry actually appears in the tarball. This catches both:
        //
        //   - The empty-tarball bug from earlier (`files: ["dist"]` but
        //     dist/ wasn't built → no dist/* in tarball)
        //   - Packages that declare files that were never produced (e.g.
        //     `files: ["bom.json"]` but the build doesn't generate bom.json)
        //   - `bin` entries pointing at nonexistent paths
        //
        // It does NOT false-positive on intentionally tiny packages — a
        // package that declares `files: ["index.js"]` and ships index.js
        // passes cleanly, no matter how small the tarball.
        for (name in plan.publishOrdered) {
            val pkg = service.graph.packages[name] ?: continue
            // For packages with `publishConfig.directory`, run npm pack from
            // the subdir so the validation inspects the actual published
            // tarball (e.g. dist/ for ng-packagr) rather than the source root.
            val packDir = pkg.publishDirectory?.let { pkg.dir.resolve(it) } ?: pkg.dir
            val packProc = ProcessBuilder("npm", "pack", "--dry-run", "--json")
                .directory(packDir)
                .redirectErrorStream(false)
                .start()
            val stdout = packProc.inputStream.bufferedReader().readText()
            val stderr = packProc.errorStream.bufferedReader().readText()
            val finished = packProc.waitFor(60, java.util.concurrent.TimeUnit.SECONDS)
            if (!finished || packProc.exitValue() != 0) {
                errors.add("${name}: npm pack --dry-run failed — ${stderr.take(500)}")
                continue
            }

            val packInfo: Map<String, Any?>? = try {
                @Suppress("UNCHECKED_CAST")
                val packArr = mapper.readValue<List<Map<String, Any?>>>(stdout)
                packArr.firstOrNull()
            } catch (e: Exception) {
                errors.add("${name}: could not parse npm pack --dry-run output — ${e.message}")
                null
            }
            if (packInfo == null) {
                if (errors.none { it.startsWith("${name}:") }) {
                    errors.add("${name}: npm pack --dry-run returned empty array")
                }
                continue
            }

            // Extract the tarball file paths.
            @Suppress("UNCHECKED_CAST")
            val tarballPaths = ((packInfo["files"] as? List<Map<String, Any?>>) ?: emptyList())
                .mapNotNull { it["path"] as? String }

            // Read the package's package.json and pull out files/main/bin.
            // Same publishDir treatment as npm pack: validate against the
            // actually-published file, not the source root.
            val pkgJsonFile = java.io.File(packDir, "package.json")
            if (!pkgJsonFile.exists()) {
                errors.add("${name}: package.json not found at ${pkgJsonFile.absolutePath}")
                continue
            }
            val pkgJson: Map<String, Any?> = try {
                @Suppress("UNCHECKED_CAST")
                mapper.readValue(pkgJsonFile)
            } catch (e: Exception) {
                errors.add("${name}: failed to parse package.json — ${e.message}")
                continue
            }

            val missing = mutableListOf<String>()

            // 3a. Each entry in `files` must match at least one tarball path.
            //     A `files` entry can be:
            //       - An exact filename:   "index.js"
            //       - A directory name:    "dist"             (recursive)
            //       - A glob pattern:      "test/**" / "*.ts" (minimatch-style)
            //
            //     For exact + directory forms we do a cheap prefix check;
            //     for anything containing glob chars we use JDK's built-in
            //     PathMatcher (`glob:...`) which handles `**`, `*`, `?`,
            //     `{a,b}` etc. the same way npm's internal matcher does.
            val fs = java.nio.file.FileSystems.getDefault()
            @Suppress("UNCHECKED_CAST")
            val filesField = (pkgJson["files"] as? List<*>)?.mapNotNull { it as? String } ?: emptyList()
            for (rawPattern in filesField) {
                val pattern = rawPattern.removePrefix("./").removeSuffix("/")
                val hasGlob = pattern.contains('*') || pattern.contains('?') || pattern.contains('[')

                val matches = if (hasGlob) {
                    val matcher = try {
                        fs.getPathMatcher("glob:$pattern")
                    } catch (_: Exception) {
                        null
                    }
                    if (matcher == null) {
                        // Invalid glob — fall back to literal compare, still
                        // useful as a sanity check.
                        tarballPaths.any { it == pattern }
                    } else {
                        tarballPaths.any { path ->
                            try {
                                matcher.matches(java.nio.file.Paths.get(path))
                            } catch (_: Exception) {
                                false
                            }
                        }
                    }
                } else {
                    // No glob metacharacters — exact filename or directory.
                    tarballPaths.any { path ->
                        path == pattern || path.startsWith("$pattern/")
                    }
                }

                if (!matches) {
                    missing.add("'files' entry not in tarball: $rawPattern")
                }
            }

            // 3b. `main` must point to a file actually in the tarball
            //     (only when present — not all packages declare main).
            val mainField = pkgJson["main"] as? String
            if (mainField != null) {
                val normalized = mainField.removePrefix("./")
                if (!tarballPaths.any { it == normalized }) {
                    missing.add("'main' not in tarball: $mainField")
                }
            }

            // 3c. Every `bin` entry must point to a file actually in the
            //     tarball. `bin` can be a string (single bin) or a map.
            val binField = pkgJson["bin"]
            when (binField) {
                is String -> {
                    val normalized = binField.removePrefix("./")
                    if (!tarballPaths.any { it == normalized }) {
                        missing.add("'bin' not in tarball: $binField")
                    }
                }
                is Map<*, *> -> {
                    for ((binName, binPath) in binField) {
                        val pathStr = binPath as? String ?: continue
                        val normalized = pathStr.removePrefix("./")
                        if (!tarballPaths.any { it == normalized }) {
                            missing.add("'bin.$binName' not in tarball: $pathStr")
                        }
                    }
                }
                else -> { /* no bin field, nothing to check */ }
            }

            if (missing.isNotEmpty()) {
                errors.add("${name}: ${missing.joinToString("; ")}")
                continue
            }

            val entryCount = (packInfo["entryCount"] as? Number)?.toInt() ?: 0
            val unpackedSize = (packInfo["unpackedSize"] as? Number)?.toLong() ?: 0L
            logger.lifecycle("  ✓ ${name}: tarball $entryCount files, $unpackedSize bytes unpacked")
        }

        if (errors.isNotEmpty()) {
            throw GradleException(
                "publish dry-run failed for ${errors.size} package(s):\n  " +
                errors.joinToString("\n  ") +
                "\n\nFix these before committing — `zbb publish` will fail in CI with the same errors."
            )
        }
        logger.lifecycle("[publish-dry-run] ✓ all ${plan.publishOrdered.size} package(s) pass dry-run validation")
    }
}

// ── Per-subproject task wiring (after projectsEvaluated) ────────────

gradle.projectsEvaluated {
    val service = graphService.get()
    val rootDir = rootProject.projectDir

    // Orphan packages: declared in the workspace graph (package.json) but
    // not registered as gradle subprojects in settings.gradle.kts. Their
    // publish tasks are registered on rootProject with a synthetic name
    // (suffixed by sanitized relDir) so the publish chain still runs.
    // Tracked here so the wiring blocks below can include them in the
    // `monorepoPublish` / `publishJavaPackages` / `commitVersionBumps`
    // dependency graph alongside subproject-owned tasks.
    val orphanPublishTasks = mutableListOf<TaskProvider<*>>()
    val orphanPrepublishTasks = mutableListOf<TaskProvider<*>>()

    // Register per-package publish tasks for ALL eligible packages.
    // The per-package publishPackage task uses `onlyIf` to check whether the
    // package is in the publish plan (set of changed packages). This way the
    // tasks exist for Gradle's graph but skip execution for unchanged packages.
    //
    // Orphan handling: when a workspace package has no matching gradle
    // subproject (typically content-only npm packages with no build step),
    // we register the same tasks on rootProject under a synthetic name.
    // Without this, version bump + tag creation + git push run for the
    // package (those iterate the workspace graph) but the actual `npm
    // publish` is silently skipped — leaving phantom tags pointing at
    // versions that were never pushed to the registry.
    for ((pkgName, pkg) in service.graph.packages) {
        if (pkg.private) continue
        if (service.config.skipPublish.contains(pkgName)) continue

        val gradlePath = ":" + pkg.relDir.replace("/", ":")
        val subproject = rootProject.findProject(gradlePath)
        val isOrphan = subproject == null
        val taskOwner = subproject ?: rootProject
        val nameSuffix = if (isOrphan) "_" + pkg.relDir.replace(Regex("[^A-Za-z0-9]+"), "_") else ""
        val capturedPkgName = pkgName

        if (isOrphan) {
            logger.lifecycle(
                "[publish] $pkgName has no gradle subproject ($gradlePath); " +
                    "registering publish tasks on rootProject"
            )
        }

        // ── prepublishPackage ──
        // Honors `publishConfig.directory` (npm-standard): when set, Prepublish
        // writes the resolved package.json into that subdirectory (e.g. dist/
        // for ng-packagr) instead of mutating the package root. The source
        // package.json is left untouched, so no backup is needed.
        val publishSubdir = pkg.publishDirectory?.let { pkg.dir.resolve(it) }
        val prepublishTask = taskOwner.tasks.register("prepublishPackage$nameSuffix") {
            group = "monorepo"
            description = "Run Kotlin Prepublish for $pkgName"
            dependsOn(publishPlan)
            onlyIf { publishPlanFile.exists() && publishPlanFile.readText().contains("\"$capturedPkgName\"") }
            doLast {
                // If this is the stack package, regenerate zbb.yaml from the
                // root manifest so the published package includes the current
                // stack config. Consumers download this via `zbb stack add`.
                if (pkg.relDir == "stack") {
                    val rootZbbYaml = rootDir.resolve("zbb.yaml")
                    val stackZbbYaml = pkg.dir.resolve("zbb.yaml")
                    if (rootZbbYaml.exists()) {
                        rootZbbYaml.copyTo(stackZbbYaml, overwrite = true)
                        logger.lifecycle("[prepublish] regenerated stack/zbb.yaml from root")
                    }
                }

                logger.lifecycle("[prepublish] $pkgName")
                val opts = Prepublish.Options(dryRun = publishDryRun, targetDir = publishSubdir)
                val result = Prepublish.resolve(pkg.dir, rootDir, opts)
                if (publishDryRun) {
                    logger.lifecycle("[prepublish] DRY RUN: ${result.dependencies.size} resolved deps")
                }
            }
        }

        // ── restorePackage (idempotent) ──
        // When `publishConfig.directory` is set, Prepublish writes to that
        // subdir and skips backup creation (the source package.json is never
        // mutated). The backup check below is a natural no-op in that case,
        // and the subdir itself is regenerated by the next build — so nothing
        // to restore on either side.
        val restoreTask = taskOwner.tasks.register("restorePackage$nameSuffix") {
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
        // Custom `publish` script (if present) wins and runs from the package
        // root — it's the explicit escape hatch and may have its own cd logic.
        // Otherwise we publish from `publishConfig.directory` if set, falling
        // back to the package root (the common case).
        val publishTask = taskOwner.tasks.register<Exec>("publishPackage$nameSuffix") {
            group = "monorepo"
            description = "Run `npm publish` for $pkgName"

            val publishScript = pkg.scripts["publish"]
            if (publishScript != null && publishScript.isNotBlank()) {
                workingDir = pkg.dir
                commandLine = listOf("npm", "run", "publish")
            } else {
                workingDir = publishSubdir ?: pkg.dir
                commandLine = listOf("npm", "publish", "--access", "public")
            }

            dependsOn(publishGuard, publishPlan, prepublishTask)
            finalizedBy(restoreTask)

            onlyIf {
                if (!publishPlanFile.exists() || !publishPlanFile.readText().contains("\"$capturedPkgName\"")) {
                    false  // not in the publish plan
                } else if (publishDryRun) {
                    logger.lifecycle("[publish] DRY RUN: would publish $pkgName from ${pkg.dir}")
                    false
                } else {
                    true
                }
            }
        }

        if (isOrphan) {
            orphanPublishTasks.add(publishTask)
            orphanPrepublishTasks.add(prepublishTask)
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
        // Orphan packages live on rootProject — wire them in too.
        for (t in orphanPublishTasks) dependsOn(t)
    }

    // ── Order Java publish AFTER all npm publishes ──
    // Without this, Gradle parallelism could start Java publish while
    // npm packages are still in flight (or even before them). Sequencing
    // npm → Java matches the prior workflow order and keeps Java's
    // failure impact isolated: if Java fails, npm already shipped.
    publishJavaPackages.configure {
        for ((pkgName, pkg) in service.graph.packages) {
            if (pkg.private) continue
            if (service.config.skipPublish.contains(pkgName)) continue
            val gradlePath = ":" + pkg.relDir.replace("/", ":")
            val subproject = rootProject.findProject(gradlePath) ?: continue
            subproject.tasks.findByName("publishPackage")?.let { dependsOn(it) }
        }
        for (t in orphanPublishTasks) dependsOn(t)
    }

    // ── Patch versions + commit BEFORE per-package publish ──
    // Runs AFTER every eligible package's build (wired in projectsEvaluated
    // below). Patching deferred from publishPlan to here so builds compile
    // against the original package.json state. If any build fails upstream,
    // this task never runs → no commit, no prepublish, no publish, no tag.
    val commitVersionBumps = tasks.register("commitVersionBumps") {
        group = "monorepo"
        description = "Patch bumped versions + git commit the version-bumped package.json files"
        dependsOn(publishPlan)
        onlyIf { !publishDryRun && publishPlanFile.exists() && publishPlanFile.readText() != "[]" }

        doLast {
            val repoRoot = rootProject.projectDir
            val om = ObjectMapper().registerKotlinModule()

            @Suppress("UNCHECKED_CAST")
            val plan = om.readValue<List<Map<String, Any?>>>(publishPlanFile)

            // ── Apply the bumped versions to each package.json ──
            // Moved from publishPlan so the preceding build step compiles
            // against the original state (parity with local `zbb gate`).
            //
            // For packages with `publishConfig.directory`, we also patch the
            // subdir's package.json (e.g. dist/ for ng-packagr). The build
            // generated that file from the pre-bump root, so it has stale
            // version/dep values that npm would actually publish.
            for (entry in plan) {
                val name = entry["name"] as? String ?: continue
                val newVersion = entry["version"] as? String ?: continue
                val bumped = entry["bumped"] as? Boolean ?: false
                val pkg = service.graph.packages[name] ?: continue
                if (bumped || newVersion != pkg.version) {
                    PublishChangeDetector.patchPackageJsonVersion(pkg.dir, newVersion)
                    logger.lifecycle("  [version] ${name}: ${pkg.version} → ${newVersion}")
                    pkg.publishDirectory?.let { subdir ->
                        val publishDir = pkg.dir.resolve(subdir)
                        if (publishDir.resolve("package.json").exists()) {
                            PublishChangeDetector.patchPackageJsonVersion(publishDir, newVersion)
                        }
                    }
                }
            }

            // Cross-update workspace dependency references so published
            // tarballs reference the resolved (potentially bumped) versions
            // of their workspace deps. Build a name→version map from the
            // plan (the in-memory ResolvedVersion map from publishPlan is
            // out of scope by the time this doLast runs).
            val planVersions = plan.mapNotNull { e ->
                val n = e["name"] as? String
                val v = e["version"] as? String
                if (n != null && v != null) n to v else null
            }.toMap()
            for (entry in plan) {
                val name = entry["name"] as? String ?: continue
                val pkg = service.graph.packages[name] ?: continue
                for (depName in pkg.internalDeps) {
                    val depVersion = planVersions[depName] ?: continue
                    PublishChangeDetector.updateDependencyVersion(pkg.dir, depName, depVersion)
                    pkg.publishDirectory?.let { subdir ->
                        val publishDir = pkg.dir.resolve(subdir)
                        if (publishDir.resolve("package.json").exists()) {
                            PublishChangeDetector.updateDependencyVersion(publishDir, depName, depVersion)
                        }
                    }
                }
            }

            // Stage all version-bumped package.json files
            val filesToStage = mutableListOf<String>()
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
    // Orphan prepublish tasks live on rootProject — wire them too.
    for (t in orphanPrepublishTasks) {
        t.configure { dependsOn(commitVersionBumps) }
    }

    // ── Build each package being published ─────────────────────────
    //
    // Publish MUST run after build — otherwise tarballs go out without
    // dist/. --force bypasses the gate stamp check ONLY; it never bypasses
    // the build requirement.
    //
    // CRITICAL: the per-package task selection here MUST mirror what
    // `monorepoBuild` (in zb.monorepo-build step 5) does for each package.
    // If the publish graph ever diverges from the gate/build graph, we end
    // up with "passes local gate, fails CI publish" bugs where hub-specific
    // Gradle wire-ups (like a subproject's custom `build` that dependsOn a
    // dangling root task) fire on one path but not the other. Keeping the
    // two in sync is the only way `zbb gate` locally is a reliable
    // predictor of `zbb publish` in CI.
    //
    // hasExistingBuildInfra is duplicated here (instead of imported) because
    // precompiled script plugins can't share top-level functions. The two
    // definitions must stay identical — update both.
    fun publishHasExistingBuildInfra(subproject: org.gradle.api.Project): Boolean {
        if (subproject.tasks.findByName("compileJava") != null) return true
        if (subproject.tasks.findByName("compileKotlin") != null) return true
        if (subproject.tasks.findByName("compileGroovy") != null) return true
        return false
    }
    // FAIL-FAST wiring: commitVersionBumps depends on EVERY eligible
    // package's build. Since every prepublishPackage depends on
    // commitVersionBumps (wired above at line 751), and every
    // publishPackage depends on its prepublishPackage, this makes the
    // entire per-package publish chain wait for ALL builds to finish
    // green before anything publishes. A single transpile failure
    // anywhere in the monorepo now blocks npm publish across the board —
    // preventing the partial-publish / ghost-publish state where some
    // packages land on the registry while others' builds are still
    // failing (or never ran).
    val buildPhases = service.config.buildPhases  // ["lint", "generate", "transpile"] default
    for ((pkgName, pkg) in service.graph.packages) {
        if (pkg.private) continue
        if (service.config.skipPublish.contains(pkgName)) continue
        val gradlePath = ":" + pkg.relDir.replace("/", ":")
        val subproject = rootProject.findProject(gradlePath) ?: continue
        val prepublish = subproject.tasks.findByName("prepublishPackage") ?: continue

        if (publishHasExistingBuildInfra(subproject)) {
            // JVM subproject — mirror monorepoBuild: use the existing `build`.
            subproject.tasks.findByName("build")?.let { buildTask ->
                prepublish.dependsOn(buildTask)
                commitVersionBumps.configure { dependsOn(buildTask) }
            }
        } else {
            // Pure-npm subproject — mirror monorepoBuild: use the fallback
            // phase tasks registered by zb.monorepo-build. Do NOT wire `build`
            // here: for subprojects that apply only the `base` plugin, `build`
            // exists but may dependsOn hub-specific custom tasks that are not
            // in the gate graph, causing publish to diverge from gate.
            for (phase in buildPhases) {
                subproject.tasks.findByName(phase)?.let { phaseTask ->
                    prepublish.dependsOn(phaseTask)
                    commitVersionBumps.configure { dependsOn(phaseTask) }
                }
            }
        }
    }

    // ── Wire monorepoPublishDryRun deps to match monorepoPublish ─────
    //
    // The dry-run task needs dist/ to exist when `npm pack` runs, so it
    // depends on monorepoBuild (if present — same pattern as gate/publish).
    // This matches monorepoPublish's build dep via prepublishPackage, but
    // because monorepoPublishDryRun doesn't go through publishPlan /
    // prepublishPackage tasks, we wire the build dep directly.
    rootProject.tasks.findByName("monorepoBuild")?.let { buildTask ->
        monorepoPublishDryRun.configure { dependsOn(buildTask) }
    }

    // ── Tag + push after all packages are published ──
    monorepoPublish.configure {
        doLast {
            if (!publishDryRun && publishPlanFile.exists()) {
                val om = ObjectMapper().registerKotlinModule()
                @Suppress("UNCHECKED_CAST")
                val plan = om.readValue<List<Map<String, Any?>>>(publishPlanFile)

                // Create an annotated git tag for each published package.
                //
                // Tag format: `<shortName>@<version>` (scope stripped).
                // This MUST match what PublishChangeDetector.getLastPublishedTag
                // looks up — which does `git describe --match=<shortName>@*`.
                // If the format ever drifts (e.g. a scoped tag while lookup
                // strips the scope, or vice versa), the detector silently
                // treats every package as "never published" and re-publishes
                // them on every run.
                //
                // Annotated tags (`-a`) are required so `git push --follow-tags`
                // actually pushes them. Lightweight tags (plain `git tag`) are
                // ignored by --follow-tags and get stranded on the CI runner.
                for (entry in plan) {
                    val name = entry["name"] as? String ?: continue
                    val version = entry["version"] as? String ?: continue
                    val shortName = name.replace(Regex("^@[^/]+/"), "")
                    val tag = "$shortName@$version"
                    try {
                        val proc = ProcessBuilder(
                            "git", "tag", "-a", tag, "-m", "Release $name@$version"
                        )
                            .directory(rootProject.projectDir)
                            .redirectErrorStream(true)
                            .start()
                        proc.waitFor(5, java.util.concurrent.TimeUnit.SECONDS)
                        logger.lifecycle("[publish] tagged $tag")
                    } catch (_: Exception) {
                        logger.warn("[publish] failed to create tag: $tag")
                    }
                }

                // Push the version-bump commit + annotated tags.
                // --follow-tags pushes annotated tags reachable from pushed commits.
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

                // Release announcement: Slack + Lambda event for each package.
                // Gated on env vars — silently skips when not in CI.
                val announcePkgs = mutableListOf<ReleaseAnnouncement.PublishedPackage>()
                for (entry in plan) {
                    val n = entry["name"] as? String ?: continue
                    val v = entry["version"] as? String ?: continue
                    val loc = entry["location"] as? String ?: continue
                    announcePkgs.add(ReleaseAnnouncement.PublishedPackage(n, v, loc))
                }

                // Merge in Java publishes from publishJavaPackages (side file
                // .zbb-gradle/java-publish.json). isJava=true keeps them out
                // of the Lambda event path (no package.json / npm dist-tags)
                // but includes them in the Slack message.
                if (javaPublishFile.exists()) {
                    val javaMapper = ObjectMapper().registerKotlinModule()
                    try {
                        @Suppress("UNCHECKED_CAST")
                        val javaEntries = javaMapper.readValue<List<Map<String, String>>>(javaPublishFile)
                        for (entry in javaEntries) {
                            val n = entry["name"] ?: continue
                            val v = entry["version"] ?: continue
                            val loc = entry["location"] ?: continue
                            announcePkgs.add(
                                ReleaseAnnouncement.PublishedPackage(n, v, loc, isJava = true)
                            )
                        }
                    } catch (e: Exception) {
                        logger.warn("[announce] failed to read java-publish.json: ${e.message}")
                    }
                }

                val announceBranch = currentBranch(rootProject.projectDir)
                val githubRepo = ReleaseAnnouncement.detectGithubRepo(rootProject.projectDir)
                ReleaseAnnouncement.announce(announcePkgs, rootProject.projectDir, announceBranch, githubRepo, logger)
            }
        }
    }
}
