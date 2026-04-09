@file:OptIn(ExperimentalStdlibApi::class)

import com.github.gradle.node.npm.task.NpmTask
import com.github.gradle.node.npm.task.NpxTask
import com.zerobias.buildtools.module.ZbExtension

plugins {
    id("zb.base")
    id("com.github.node-gradle.node")
}

val zb = extensions.getByType<ZbExtension>()
val npmDistTag: String = extra["npmDistTag"] as String
@Suppress("UNCHECKED_CAST")
val npmDistTags: List<String> = extra["npmDistTags"] as List<String>

// ── Node.js configuration (uses system Node from nvm) ──
// Resolve nvm-managed Node from .nvmrc so the Gradle daemon uses the correct version
// even when its inherited PATH points to a different system Node.

val nvmDir = System.getenv("NVM_DIR")?.let { java.io.File(it) }
    ?: java.io.File(System.getProperty("user.home"), ".nvm")
val nvmrcFile = project.rootDir.resolve(".nvmrc")
val nvmNodeVersion = if (nvmrcFile.exists()) nvmrcFile.readText().trim().removePrefix("v") else null
val nvmNodeBinDir: String? = if (nvmNodeVersion != null) {
    val binDir = nvmDir.resolve("versions/node/v${nvmNodeVersion}/bin")
    if (binDir.exists()) binDir.absolutePath else null
} else null

node {
    download.set(false)  // Use nvm-managed Node, don't download
}

// Inject nvm Node bin dir at the front of PATH for all NpxTask/NpmTask instances
// so they find the correct node/npx/npm binaries.
if (nvmNodeBinDir != null) {
    tasks.withType<NpxTask>().configureEach {
        val currentPath = System.getenv("PATH") ?: ""
        environment.put("PATH", "${nvmNodeBinDir}:${currentPath}")
    }
    tasks.withType<NpmTask>().configureEach {
        val currentPath = System.getenv("PATH") ?: ""
        environment.put("PATH", "${nvmNodeBinDir}:${currentPath}")
    }
}

// ════════════════════════════════════════════════════════════
// VALIDATE phase
// ════════════════════════════════════════════════════════════

val validateCollectorbot by tasks.registering {
    group = "lifecycle"
    description = "Validate collectorbot-specific requirements"
    doLast {
        require(project.file("collector.yml").exists()) {
            "Collector bots must have collector.yml"
        }
        require(project.file("hub.yml").exists()) {
            "Collector bots must have hub.yml"
        }
        require(project.file("parameters.yml").exists()) {
            "Collector bots must have parameters.yml"
        }
    }
}

tasks.named("validate") {
    dependsOn(validateCollectorbot)
}

// ════════════════════════════════════════════════════════════
// LINT — eslint on src/
// ════════════════════════════════════════════════════════════

val lintExec by tasks.registering(Exec::class) {
    group = "lifecycle"
    description = "Run eslint on source code using shared config from @zerobias-org/eslint-config"
    dependsOn(tasks.named("compile"))
    workingDir(project.projectDir)
    doFirst {
        // Generate ephemeral eslint.config.js in the module directory
        // Must be local (not in node_modules) so eslint's base path is correct
        val configFile = project.file("eslint.config.js")
        val sharedConfigPath = "node_modules/@zerobias-org/eslint-config/eslint.config.js"
        if (!configFile.exists() && project.file(sharedConfigPath).exists()) {
            configFile.writeText(project.file(sharedConfigPath).readText())
        }

        val npxPath = if (nvmNodeBinDir != null) "$nvmNodeBinDir/npx" else "npx"
        commandLine(npxPath, "eslint", "src/")
    }
    doLast {
        // Clean up ephemeral config
        project.file("eslint.config.js").delete()
    }
    onlyIf { project.file("src").exists() }
}

tasks.named("lint") {
    dependsOn(lintExec)
}

// ════════════════════════════════════════════════════════════
// GENERATE phase
//
// Pipeline: npmInstall → generateModels → generateHubClient
// ════════════════════════════════════════════════════════════

// gradle-node-plugin requires package-lock.json at config time.
// New collectorbots won't have one yet — create stub so npm install can run.
if (!project.file("package-lock.json").exists()) {
    project.file("package-lock.json").writeText("{}")
}

val npmInstallCollectorbot by tasks.registering(NpmTask::class) {
    group = "lifecycle"
    description = "Install npm dependencies"
    npmCommand.set(listOf("install"))
    workingDir.set(project.projectDir)
    inputs.file("package.json")
    outputs.dir("node_modules")
}

// Generate model types from parameters.yml using hub-generator
val generateModels by tasks.registering(NpxTask::class) {
    group = "lifecycle"
    description = "Generate model types from parameters.yml"
    dependsOn(npmInstallCollectorbot)
    workingDir.set(project.projectDir)
    command.set("hub-generator")
    args.set(listOf(
        "generate",
        "-g", "hub-module",
        "-i", "./parameters.yml",
        "-o", "generated/",
        "--global-property", "models,supportingFiles=index.ts"
    ))
    inputs.file("parameters.yml")
    outputs.dir("generated")
    doLast {
        // Remove the generated api/index.ts — not needed for collectorbots
        val apiIndex = project.file("generated/api/index.ts")
        if (apiIndex.exists()) apiIndex.delete()
    }
}

// Generate hub client code via hub-client-codegen
val generateHubClient by tasks.registering(NpxTask::class) {
    group = "lifecycle"
    description = "Generate hub client from hub.yml"
    dependsOn(npmInstallCollectorbot, generateModels)
    workingDir.set(project.projectDir)
    command.set("node")
    args.set(listOf("-e", "import('@zerobias-com/hub-client-codegen')"))
    inputs.file("hub.yml")
    inputs.file("package.json")
    outputs.dir("generated")
}

tasks.named("generate") {
    dependsOn(npmInstallCollectorbot, generateModels, generateHubClient)
}

// ════════════════════════════════════════════════════════════
// COMPILE phase — tsc
// ════════════════════════════════════════════════════════════

val transpile by tasks.registering(NpxTask::class) {
    group = "lifecycle"
    description = "Compile TypeScript (ESM)"
    dependsOn(npmInstallCollectorbot, tasks.named("generate"))
    workingDir.set(project.projectDir)
    command.set("tsc")
    inputs.dir("src")
    inputs.dir("generated")
    inputs.file("tsconfig.json").optional()
    outputs.dir("dist")
}

tasks.named("compile") {
    dependsOn(transpile)
}

// ════════════════════════════════════════════════════════════
// TEST phase
// ════════════════════════════════════════════════════════════

val testUnitExec by tasks.registering(NpxTask::class) {
    group = "lifecycle"
    description = "Run mocha unit tests"
    dependsOn(tasks.named("compile"))
    workingDir.set(project.projectDir)
    command.set("mocha")
    args.set(listOf("--recursive", "test/unit/"))
    onlyIf { project.file("test/unit").exists() }
}

tasks.named("testUnit") {
    dependsOn(testUnitExec)
}

// E2E tests — uses testDirect lifecycle hook (same pattern as modules)
val testE2eExec by tasks.registering(NpxTask::class) {
    group = "lifecycle"
    description = "Run mocha e2e tests"
    dependsOn(tasks.named("compile"))
    workingDir.set(project.projectDir)
    command.set("mocha")
    args.set(listOf("--recursive", "test/e2e/"))
    onlyIf { project.file("test/e2e").exists() }
}

tasks.named("testDirect") {
    dependsOn(testE2eExec)
}

// ════════════════════════════════════════════════════════════
// PUBLISH phase — npm publish with version patching & promotion
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

fun readPackageNameVersion(): Pair<String, String> {
    val pkgJson = project.file("package.json")
    require(pkgJson.exists()) { "package.json not found in ${project.projectDir}" }
    val content = pkgJson.readText()
    val name = Regex(""""name"\s*:\s*"([^"]+)"""").find(content)?.groupValues?.get(1)
        ?: throw org.gradle.api.GradleException("Cannot find 'name' in package.json")
    val version = Regex(""""version"\s*:\s*"([^"]+)"""").find(content)?.groupValues?.get(1)
        ?: throw org.gradle.api.GradleException("Cannot find 'version' in package.json")
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
    description = "Publish npm package to registry with --tag next (staging)"
    dependsOn(tasks.named("gate"), patchPackageJson, preflightChecks)
    finalizedBy(restorePackageJson)

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
