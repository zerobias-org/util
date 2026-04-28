@file:OptIn(ExperimentalStdlibApi::class)

import com.github.gradle.node.npm.task.NpmTask
import com.zerobias.buildtools.content.ContentValidator
import com.zerobias.buildtools.tasks.NeonDataloaderTask

/**
 * zb.content — leaf plugin for content-catalog NPM packages that ship
 * YAML artifacts (vendor, suite, product) rather than TypeScript code.
 *
 * No generate/compile/Docker phases. Wires:
 *   validate        → ContentValidator (schema check of index.yml + package.json)
 *   testIntegration → DataloaderTask (loads artifact into active slot's Postgres)
 *   publishNpm      → npm publish --tag next + shrinkwrap staging
 *   promoteAll      → dist-tag promotion (next → dev/qa/uat/latest)
 *
 * Per-package build.gradle.kts is one line:
 *   plugins { id("zb.content") }
 */

plugins {
    id("zb.base")
    id("com.github.node-gradle.node")
}

val npmDistTag: String = extra["npmDistTag"] as String
@Suppress("UNCHECKED_CAST")
val npmDistTags: List<String> = extra["npmDistTags"] as List<String>

// ── Node.js configuration (npm publish path uses NpmTask) ──
// Resolve nvm-managed Node from .nvmrc so the Gradle daemon uses the correct
// version even when its inherited PATH points to a different system Node.
val nvmDir = System.getenv("NVM_DIR")?.let { java.io.File(it) }
    ?: java.io.File(System.getProperty("user.home"), ".nvm")
val nvmrcFile = project.rootDir.resolve(".nvmrc")
val nvmNodeVersion = if (nvmrcFile.exists()) nvmrcFile.readText().trim().removePrefix("v") else null
val nvmNodeBinDir: String? = if (nvmNodeVersion != null) {
    val binDir = nvmDir.resolve("versions/node/v${nvmNodeVersion}/bin")
    if (binDir.exists()) binDir.absolutePath else null
} else null

node {
    download.set(false)
}

if (nvmNodeBinDir != null) {
    tasks.withType<NpmTask>().configureEach {
        val currentPath = System.getenv("PATH") ?: ""
        environment.put("PATH", "${nvmNodeBinDir}:${currentPath}")
    }
}

// ════════════════════════════════════════════════════════════
// VALIDATE phase — schema check ported from scripts/validate.ts
// ════════════════════════════════════════════════════════════

val validateContent by tasks.registering {
    group = "lifecycle"
    description = "Validate content package schema (index.yml + package.json)"
    inputs.file("index.yml")
    inputs.file("package.json")
    doLast {
        val result = ContentValidator.validate(project.projectDir)
        logger.lifecycle("Validated content package: ${result.code}")
    }
}

tasks.named("validate") {
    dependsOn(validateContent)
}

// ════════════════════════════════════════════════════════════
// NPM INSTALL — required for publish (shrinkwrap staging needs lockfile
// with deps resolved). Skipped for packages without dependencies.
// ════════════════════════════════════════════════════════════

val npmInstallContent by tasks.registering(NpmTask::class) {
    group = "lifecycle"
    description = "Install npm dependencies"
    npmCommand.set(listOf("install"))
    // --no-workspaces: install ONLY this package, don't walk up to the
    //   workspace root and resolve sibling packages. zbb still uses the
    //   root `workspaces` declaration for content-package discovery, but
    //   we don't want each per-vendor install to rewrite root
    //   package-lock.json — that left the working tree dirty and broke
    //   zb.base.pushVersion's rebase fallback when the matrix raced.
    //   See zerobias-org/vendor run 25018847869.
    // --no-package-lock: don't write a per-package package-lock.json
    //   either. Content packages have at most one external dep that
    //   lockfile-pins to "latest", so the lockfile carries no real
    //   determinism — it would just be more dirty-tree noise.
    args.set(listOf("--no-workspaces", "--no-package-lock"))
    workingDir.set(project.projectDir)
    inputs.file("package.json")
    outputs.dir("node_modules")
}

// ════════════════════════════════════════════════════════════
// TEST INTEGRATION — load artifact into an ephemeral Neon branch.
//
// NeonDataloaderTask provisions a Neon Postgres branch on-the-fly via the
// Neon API, runs dataloader with the branch's PG env injected directly
// into the subprocess (overriding any inherited shell PG vars), then
// deletes the branch. Same pattern as zb.typescript's testDataloaderExec.
//
// Requires NEON_API_KEY + NEON_PROJECT_ID in the env. Locally these come
// from the slot via vault refs declared in the repo's zbb.yaml; in CI
// they're imported via hashicorp/vault-action before gate runs.
//
// Skips cleanly (no failure) when NEON_API_KEY is absent — keeps local
// gate runs without vault credentials from blowing up.
// ════════════════════════════════════════════════════════════

val testIntegrationDataloader by tasks.registering(NeonDataloaderTask::class) {
    packageDir.set(layout.projectDirectory)
    // Dataloader resolves the artifact's dependencies from node_modules; without
    // an explicit dep on npmInstallContent gradle 8+ flags the implicit input
    // and fails the build (validation-type problem on parallel runs).
    dependsOn(npmInstallContent)
}

tasks.named("testIntegration") {
    dependsOn(testIntegrationDataloader)
}

// ════════════════════════════════════════════════════════════
// PUBLISH phase — npm publish with version patching & promotion
// (mirrors zb.typescript-collectorbot publish phase, minus Docker)
// ════════════════════════════════════════════════════════════

val isDryRun: Boolean = extra["isDryRun"] as Boolean
@Suppress("UNCHECKED_CAST")
val preflightChecks = extra["preflightChecks"] as TaskProvider<*>
@Suppress("UNCHECKED_CAST")
val stagedPackages = extra["stagedPackages"] as MutableList<Pair<String, java.io.File>>

fun patchPackageJsonVersion(pkgFile: java.io.File, newVersion: String): String {
    val originalContent = pkgFile.readText()
    val patchedContent = originalContent.replace(
        Regex(""""version"\s*:\s*"[^"]+""""),
        """"version": "$newVersion""""
    )
    pkgFile.writeText(patchedContent)
    return originalContent
}

var originalPackageJson: String? = null

val patchPackageJson by tasks.registering {
    group = "publish"
    description = "Patch package.json with resolved version"
    doLast {
        val pkgFile = project.file("package.json")
        val ver = project.version.toString()
        originalPackageJson = patchPackageJsonVersion(pkgFile, ver)
        logger.lifecycle("Patched package.json version to $ver")
    }
}

val restorePackageJson by tasks.registering {
    group = "publish"
    description = "Restore original package.json after publish"
    doLast {
        val pkgFile = project.file("package.json")
        val content = originalPackageJson
        if (content != null) {
            pkgFile.writeText(content)
            logger.lifecycle("Restored original package.json")
        }
    }
}

// Stage an npm-shrinkwrap.json alongside package-lock.json so the npm pack
// tarball contains a lockfile. npm's `pack` hard-excludes package-lock.json
// but auto-includes npm-shrinkwrap.json. Mirrors the original vendor
// publish.sh which runs `npm shrinkwrap` before publish.
val stageShrinkwrapForPublish by tasks.registering {
    group = "publish"
    description = "Copy package-lock.json to npm-shrinkwrap.json for the publish tarball"
    doLast {
        val lock = project.file("package-lock.json")
        val shrink = project.file("npm-shrinkwrap.json")
        if (lock.exists()) {
            lock.copyTo(shrink, overwrite = true)
            logger.lifecycle("Staged npm-shrinkwrap.json from package-lock.json")
        } else {
            logger.warn("No package-lock.json found — tarball will not contain a lockfile")
        }
    }
}

val cleanupShrinkwrapAfterPublish by tasks.registering {
    group = "publish"
    description = "Remove ephemeral npm-shrinkwrap.json after publish (idempotent)"
    doLast {
        val shrink = project.file("npm-shrinkwrap.json")
        if (shrink.exists() && shrink.delete()) {
            logger.lifecycle("Removed ephemeral npm-shrinkwrap.json")
        }
    }
}

fun readPackageNameVersion(): Pair<String, String> {
    val pkgJson = project.file("package.json")
    require(pkgJson.exists()) { "package.json not found in ${project.projectDir}" }
    val content = pkgJson.readText()
    val name = Regex(""""name"\s*:\s*"([^"]+)"""").find(content)?.groupValues?.get(1)
        ?: throw GradleException("Cannot find 'name' in package.json")
    val version = Regex(""""version"\s*:\s*"([^"]+)"""").find(content)?.groupValues?.get(1)
        ?: throw GradleException("Cannot find 'version' in package.json")
    return name to version
}

fun isAlreadyPublished(name: String, version: String, workDir: java.io.File): Boolean {
    return try {
        val output = com.zerobias.buildtools.util.ExecUtils.execCapture(
            command = listOf("npm", "view", "${name}@${version}", "version"),
            workingDir = workDir,
            throwOnError = false
        ).trim()
        output == version
    } catch (e: Exception) {
        false
    }
}

val publishNpmExec by tasks.registering(NpmTask::class) {
    group = "publish"
    description = "Publish content npm package with --tag next (staging)"
    dependsOn(
        tasks.named("gate"),
        npmInstallContent,
        patchPackageJson,
        stageShrinkwrapForPublish,
        preflightChecks
    )
    finalizedBy(restorePackageJson, cleanupShrinkwrapAfterPublish)

    npmCommand.set(listOf("publish"))
    args.set(listOf("--tag", "next"))
    workingDir.set(project.projectDir)

    doFirst {
        val (name, _) = readPackageNameVersion()
        val ver = project.version.toString()
        if (isDryRun) {
            logger.lifecycle("[DRY RUN] Would publish ${name}@${ver} with --tag next")
            throw org.gradle.api.tasks.StopExecutionException()
        }
        if (isAlreadyPublished(name, ver, project.projectDir)) {
            logger.lifecycle("[publishNpmExec] ${name}@${ver} already published — skipping (will still promote)")
            stagedPackages.add(name to project.projectDir)
            throw org.gradle.api.tasks.StopExecutionException()
        }
    }
    doLast {
        val (name, _) = readPackageNameVersion()
        stagedPackages.add(name to project.projectDir)
    }
}

tasks.named("publishNpm") {
    dependsOn(publishNpmExec)
}

// ── Promotion: move from 'next' tag to correct dist-tags ──

fun promotePackage(name: String, ver: String, workDir: java.io.File, tags: List<String>) {
    for (tag in tags) {
        logger.lifecycle("  Tagging ${name}@${ver} → $tag")
        com.zerobias.buildtools.util.ExecUtils.exec(
            command = listOf("npm", "dist-tag", "add", "${name}@${ver}", tag),
            workingDir = workDir,
            throwOnError = true
        )
    }
    try {
        com.zerobias.buildtools.util.ExecUtils.exec(
            command = listOf("npm", "dist-tag", "rm", name, "next"),
            workingDir = workDir,
            throwOnError = false
        )
    } catch (_: Exception) {}
}

val promoteNpm by tasks.registering {
    group = "publish"
    description = "Promote npm package from 'next' to all applicable dist-tags"
    doLast {
        val (name, _) = readPackageNameVersion()
        val ver = project.version.toString()
        if (isDryRun) {
            logger.lifecycle("[DRY RUN] Would promote ${name}@${ver} to tags: ${npmDistTags.joinToString(", ")}")
            return@doLast
        }
        logger.lifecycle("Promoting ${name}@${ver}")
        promotePackage(name, ver, project.projectDir, npmDistTags)
    }
}

tasks.named("promoteAll") {
    dependsOn(promoteNpm)
}

// ════════════════════════════════════════════════════════════
// RELEASE MARKER — drop a pending-release record for the
// downstream `finalizePublish` task to consume.
//
// Only fires when running with `-PnoFinalize=true` (CI matrix mode).
// In local dev (default) this task is a no-op because zb.base.publish
// still does end-to-end commit/tag/push itself.
// ════════════════════════════════════════════════════════════

val emitReleaseMarker by tasks.registering {
    group = "publish"
    description = "Drop a release-pending marker so the finalize tail job can batch the commit + tag + push"
    onlyIf { (project.findProperty("noFinalize") as? String) == "true" }
    mustRunAfter(promoteNpm)
    doLast {
        val rootDir = project.rootDir
        val markerDir = rootDir.resolve(".zbb-monorepo/release-pending")
        markerDir.mkdirs()
        val (name, _) = readPackageNameVersion()
        val ver = project.version.toString()
        val pkgPath = project.projectDir.relativeTo(rootDir).path
        // Sanitize the npm name into a filesystem-safe identifier:
        //   @zerobias-org/vendor-github → zerobias-org_vendor-github
        val safeName = name.removePrefix("@").replace('/', '_')
        val tagName = "${pkgPath.replace('/', '-')}-v$ver"

        // JSON shape consumed by zb.base.finalizePublish:
        //   { "name": "@scope/pkg", "version": "X.Y.Z", "path": "package/dir", "tag": "package-dir-vX.Y.Z" }
        val marker = markerDir.resolve("$safeName.json")
        marker.writeText(
            """{"name":"$name","version":"$ver","path":"$pkgPath","tag":"$tagName"}"""
        )
        logger.lifecycle("[release-marker] dropped ${marker.relativeTo(rootDir)}")
    }
}

// Wire as a finalizer on the npm publish step so the marker is only
// dropped when the npm artifact actually lands. If publishNpmExec
// short-circuits via `isAlreadyPublished`, the marker still drops —
// that's the correct behavior on rerun (finalize will see the marker,
// see no pending diff against HEAD, and skip the commit).
tasks.named("publishNpmExec") {
    finalizedBy(emitReleaseMarker)
}
