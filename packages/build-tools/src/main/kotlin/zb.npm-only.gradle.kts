@file:OptIn(ExperimentalStdlibApi::class)

import com.github.gradle.node.npm.task.NpmTask
import com.zerobias.buildtools.tasks.OrgPublish
import com.zerobias.buildtools.util.PackageJsonReader

/**
 * zb.npm-only — leaf plugin for NPM packages that ship configuration or
 * metadata and nothing else: no TypeScript to compile, no Docker image, and
 * no catalog artifact to load.
 *
 * Motivating case: the context-pack toolchain packs, which are a
 * `package.json` plus a `tsconfig.json`. Their whole job is to pin a
 * toolchain for consumers.
 *
 * Why not zb.content — content packages ARE catalog artifacts, so that
 * plugin wires `testIntegration` to the dataloader ("the universal 'is this
 * loadable?' contract") and publishes through the `next → dev/qa/uat/latest`
 * channel promotion. Neither applies here: there is nothing to load, and a
 * toolchain pin has no environment channels. Running the dataloader against
 * one of these packages either fails or, when ZB_TOKEN is absent, silently
 * passes — a gate whose headline check is vacuous is worse than no check.
 *
 * Why not zb.typescript* — those assume src/, generate, compile and an image.
 *
 * Wires:
 *   validate    → repo-supplied via rootProject.extra["npmOnlyValidator"]
 *                  (no default; a missing slot is a build-time error, same
 *                   contract as zb.content's contentValidator)
 *   publishNpm  → npm publish directly to its final dist-tag
 *   promoteAll  → no-op (nothing to promote; publish is already final)
 *
 * Per-package build.gradle.kts is one line:
 *   plugins { id("zb.npm-only") }
 *
 * Per-repo validator (root build.gradle.kts):
 *
 *   extra["npmOnlyValidator"] = { proj: org.gradle.api.Project ->
 *       val pkg = com.fasterxml.jackson.module.kotlin.jacksonObjectMapper()
 *           .readTree(proj.file("package.json"))
 *       // e.g. a pin-carrying pack must not use ranges in `dependencies`
 *       pkg["dependencies"]?.fields()?.forEach { (name, spec) ->
 *           require(spec.asText().first().isDigit()) {
 *               "$name must be an exact pin, got ${spec.asText()}"
 *           }
 *       }
 *   }
 *
 * NOTE ON PINS: this plugin does not itself rewrite dependency versions, but
 * `Prepublish.resolve()` (zb.monorepo-*) does — it replaces a package's
 * versions with the monorepo ROOT's. A repo hosting pin-carrying packages
 * must therefore either avoid the monorepo plugins or keep its root
 * package.json dependency-free. See context-pack's README.
 */

plugins {
    id("zb.base")
    id("com.github.node-gradle.node")
}

@Suppress("UNCHECKED_CAST")
val npmDistTags: List<String> = extra["npmDistTags"] as List<String>

// ── Node.js configuration ──
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
    nvmNodeBinDir?.let { nodeProjectDir.set(project.rootDir) }
}

// ════════════════════════════════════════════════════════════
// VALIDATE — repo-supplied. No default: a repo that adopts this plugin has
// to say what "valid" means for its packages, exactly as with zb.content.
// ════════════════════════════════════════════════════════════

val validateNpmOnly by tasks.registering {
    group = "lifecycle"
    description = "Validate npm-only package — repo-supplied via rootProject.extra[\"npmOnlyValidator\"]"
    inputs.file("package.json")
    doLast {
        @Suppress("UNCHECKED_CAST")
        val validator: ((org.gradle.api.Project) -> Unit) =
            if (rootProject.extra.has("npmOnlyValidator")) {
                rootProject.extra.get("npmOnlyValidator") as (org.gradle.api.Project) -> Unit
            } else throw GradleException(
                "[zb.npm-only] No npmOnlyValidator declared on root project. " +
                "Set rootProject.extra[\"npmOnlyValidator\"] in your root " +
                "build.gradle.kts — see the zb.npm-only header comment for an " +
                "example."
            )

        validator(project)
        logger.lifecycle("[validate] passed for ${project.path}")
    }
}

tasks.named("validate") {
    dependsOn(validateNpmOnly)
}

// No generate / compile / test / image phases: there is no source, no test
// suite and no artifact to load. `gate` therefore reduces to validate, which
// is the honest shape for these packages — rather than a dataloader step that
// would be vacuous or failing.

// ════════════════════════════════════════════════════════════
// PUBLISH
// ════════════════════════════════════════════════════════════

val isDryRun: Boolean = extra["isDryRun"] as Boolean
val isOrgPublish: Boolean = extra["isOrgPublish"] as Boolean

@Suppress("UNCHECKED_CAST")
val preflightChecks = extra["preflightChecks"] as TaskProvider<*>

fun patchPackageJsonVersion(pkgFile: java.io.File, newVersion: String): String {
    val originalContent = pkgFile.readText()
    val patchedContent = originalContent.replace(
        Regex(""""version"\s*:\s*"[^"]+""""),
        """"version": "$newVersion"""",
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
        val content = originalPackageJson
        if (content != null) {
            project.file("package.json").writeText(content)
            logger.lifecycle("Restored original package.json")
        }
    }
}

fun readPackageNameVersion(): Pair<String, String> =
    PackageJsonReader.readNameVersion(project.file("package.json"))

fun isAlreadyPublished(name: String, version: String, workDir: java.io.File): Boolean {
    return try {
        com.zerobias.buildtools.util.ExecUtils.execCapture(
            command = listOf("npm", "view", "${name}@${version}", "version"),
            workingDir = workDir,
            throwOnError = false,
        ).trim() == version
    } catch (e: Exception) {
        false
    }
}

// Publish lands on `next` first, then promoteNpm moves it to the branch's
// real dist-tags.
//
// This is NOT optional bookkeeping: OrgPublish.npmPublishArgs() returns
// ["--tag", "next"] for every non-org publish, so a package published through
// this plugin is ALWAYS staged on `next`. An earlier version of this plugin
// treated promotion as a no-op on the assumption that publishing went straight
// to the final tag — the result was three released versions of context-pack
// while `latest` still pointed at the first one, so every consumer resolving
// `latest` silently got the oldest build.
//
// The staging step is also useful in its own right: `next` gives a pack major
// somewhere to sit while it is piloted on a real consumer, before the fleet
// resolves it.
val publishNpmExec by tasks.registering(NpmTask::class) {
    group = "publish"
    description = "Publish npm-only package"
    dependsOn(tasks.named("gate"), patchPackageJson, preflightChecks)
    finalizedBy(restorePackageJson)

    npmCommand.set(listOf("publish"))
    args.set(OrgPublish.npmPublishArgs(isOrgPublish))
    workingDir.set(project.projectDir)

    doFirst {
        val (name, _) = readPackageNameVersion()
        val ver = project.version.toString()
        if (isDryRun) {
            logger.lifecycle("[DRY RUN] Would publish ${name}@${ver}")
            throw org.gradle.api.tasks.StopExecutionException()
        }
        if (isAlreadyPublished(name, ver, project.projectDir)) {
            logger.lifecycle("[publishNpmExec] ${name}@${ver} already published — skipping")
            throw org.gradle.api.tasks.StopExecutionException()
        }
    }
}

tasks.named("publishNpm") {
    dependsOn(publishNpmExec)
}

// ── Promotion: move from the `next` staging tag to the real dist-tags ──
//
// Mirrors zb.content.promoteNpm. Without this a published version is reachable
// only as `@next`, and `latest` keeps pointing at whatever was there before.
fun promotePackage(name: String, ver: String, workDir: java.io.File, tags: List<String>) {
    for (tag in tags) {
        logger.lifecycle("  Tagging ${name}@${ver} → $tag")
        com.zerobias.buildtools.util.ExecUtils.exec(
            command = listOf("npm", "dist-tag", "add", "${name}@${ver}", tag),
            workingDir = workDir,
            throwOnError = true,
        )
    }
    // Best-effort: drop the staging tag once the real ones point at this
    // version. A failure here leaves a harmless dangling `next`.
    try {
        com.zerobias.buildtools.util.ExecUtils.exec(
            command = listOf("npm", "dist-tag", "rm", name, "next"),
            workingDir = workDir,
            throwOnError = false,
        )
    } catch (_: Exception) {
    }
}

val promoteNpm by tasks.registering {
    group = "publish"
    description = "Promote the npm package from 'next' to all applicable dist-tags"
    // Gradle can otherwise schedule promote before publish, which dist-tags a
    // version that does not exist yet (404) and fail-fasts the build before
    // publishNpmExec runs. Same hazard zb.content documents.
    mustRunAfter(publishNpmExec)
    // An org publish takes no dist-tag at all — promoting it would surface one
    // org's private artifact as the default for every consumer.
    onlyIf { !isOrgPublish }
    doLast {
        val (name, _) = readPackageNameVersion()
        val ver = project.version.toString()
        if (isDryRun) {
            logger.lifecycle("[DRY RUN] Would promote ${name}@${ver} to: ${npmDistTags.joinToString(", ")}")
            return@doLast
        }
        logger.lifecycle("Promoting ${name}@${ver}")
        promotePackage(name, ver, project.projectDir, npmDistTags)
    }
}

tasks.named("promoteAll") {
    dependsOn(promoteNpm)
}
