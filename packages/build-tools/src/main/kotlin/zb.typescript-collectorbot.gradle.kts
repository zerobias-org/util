@file:OptIn(ExperimentalStdlibApi::class)

import com.github.gradle.node.npm.task.NpmTask
import com.github.gradle.node.npm.task.NpxTask
import com.zerobias.buildtools.collectorbot.CollectorbotEntryPointGenerator
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

// Render the Docker container entry point run.ts from package.json identity.
// The output lands next to generated/inversify.config.ts so the relative
// `./inversify.config.js` import resolves after tsc.
val generateCollectorbotRun by tasks.registering {
    group = "lifecycle"
    description = "Generate generated/run.ts entry point for Docker container"
    dependsOn(generateHubClient)
    inputs.file("package.json")
    outputs.file("generated/run.ts")
    doLast {
        val identity = CollectorbotEntryPointGenerator.readPackageIdentity(project.projectDir)
        val content = CollectorbotEntryPointGenerator.generate(identity)
        val outFile = project.file("generated/run.ts")
        outFile.parentFile.mkdirs()
        outFile.writeText(content)
        logger.lifecycle("Generated ${outFile.relativeTo(project.projectDir)} for ${identity.scope}/${identity.name}")
    }
}

tasks.named("generate") {
    dependsOn(npmInstallCollectorbot, generateModels, generateHubClient, generateCollectorbotRun)
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
    doFirst {
        // Self-heal stale tsbuildinfo: if dist/ was wiped externally but
        // the tsbuildinfo cache still thinks the build is up-to-date,
        // tsc silently no-ops and leaves dist/ empty. Clear the cache so
        // tsc is forced into a full emit. Same defensive fix as
        // zb.typescript.gradle.kts.
        val distDir = project.file("dist")
        val distEmpty = !distDir.exists() ||
            (distDir.isDirectory && (distDir.listFiles()?.isEmpty() ?: true))
        if (distEmpty) {
            val tsBuildInfoFiles = project.projectDir.listFiles { _, name ->
                name == "tsconfig.tsbuildinfo" ||
                (name.startsWith("tsconfig.") && name.endsWith(".tsbuildinfo"))
            }
            if (tsBuildInfoFiles != null && tsBuildInfoFiles.isNotEmpty()) {
                for (f in tsBuildInfoFiles) {
                    if (f.delete()) {
                        logger.lifecycle("transpile: cleared stale ${'$'}{f.name} (dist/ was empty)")
                    }
                }
            }
        }
    }
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

// ════════════════════════════════════════════════════════════
// Docker Image Build + Publish (Multi-Arch buildx -> ECR + GHCR)
//
// Image name derives from package.json: {scopeWithoutAt}-{nameAfterSlash}
//   @auditlogic/collectorbot-github-github  → auditlogic-collectorbot-github-github
//   @zerobias-org/collectorbot-foo-bar      → zerobias-org-collectorbot-foo-bar
//
// This matches the formula hub-client-server uses in ContainerManager.ts to
// pull the preview image, so both org scopes work with no client changes.
// ════════════════════════════════════════════════════════════

fun collectorbotImageName(): String =
    CollectorbotEntryPointGenerator.readPackageIdentity(project.projectDir).imageName

// Dockerfile output lives under build/docker/ (Gradle's conventional build
// output dir) rather than generated/ because transpile declares
// `inputs.dir("generated")` and Gradle 8.10 strict mode flags any task
// that writes under there without an explicit transpile dependency as an
// implicit-dependency violation. build/ is outside transpile's input tree.
val generateCollectorbotDockerfile by tasks.registering {
    group = "lifecycle"
    description = "Generate Dockerfile for collectorbot container"
    val dockerDir = layout.buildDirectory.dir("docker")
    outputs.dir(dockerDir)
    onlyIf { !project.file("Dockerfile").exists() }
    doLast {
        val outDir = dockerDir.get().asFile
        outDir.mkdirs()

        // Stage a real .npmrc into build/docker/ so the Dockerfile can COPY
        // it from inside the build context. The project's own .npmrc is
        // typically a symlink to the repo root (e.g. ../../../../.npmrc)
        // whose target lives *outside* the docker build context; BuildKit
        // then fails during checksum with "too many links" when it tries
        // to resolve the symlink. readText() follows the symlink and gives
        // us the real content, which we write as a regular file.
        val projectNpmrc = project.file(".npmrc")
        if (projectNpmrc.exists()) {
            outDir.resolve(".npmrc").writeText(projectNpmrc.readText())
        }

        // Single-stage: copy the host's pre-installed node_modules directly.
        // Matches the proven pattern used by zb.typescript.gradle.kts for
        // modules. An earlier multi-stage attempt that ran `npm install
        // --omit=dev` inside the deps stage failed with 401 Unauthorized
        // because the in-container npm install needs NPM_TOKEN/ZB_TOKEN
        // which aren't available. Host's node_modules already has the
        // packages resolved; accepting the devDep bloat is simpler than
        // wiring build secrets.
        //
        // All COPY sources are explicit paths inside the build context —
        // no globs, no out-of-context symlinks — because glob resolution
        // walks the tree and blows up on node_modules link farms, and
        // BuildKit rejects symlinks whose targets escape the context.
        val dockerfile = """
            |FROM node:22-alpine
            |LABEL org.opencontainers.image.source=https://github.com/auditlogic/collectorbot
            |RUN apk update && apk add ca-certificates openssl git && rm -rf /var/cache/apk/*
            |WORKDIR /opt/collectorbot
            |COPY dist ./dist
            |COPY node_modules ./node_modules
            |COPY package.json ./
            |COPY *.yml ./
            |COPY build/docker/.npmrc ./.npmrc
            |CMD ["node", "dist/generated/run.js"]
        """.trimMargin() + "\n"
        outDir.resolve("Dockerfile").writeText(dockerfile)
    }
}

fun collectorbotDockerfilePath(): String =
    if (project.file("Dockerfile").exists()) "Dockerfile"
    else layout.buildDirectory.file("docker/Dockerfile").get().asFile
        .relativeTo(project.projectDir).path

val buildImageExec by tasks.registering(Exec::class) {
    group = "lifecycle"
    description = "Build collectorbot Docker image"
    dependsOn(tasks.named("compile"), generateCollectorbotDockerfile)
    workingDir(project.projectDir)
    commandLine("echo", "placeholder")
    doFirst {
        val imageName = collectorbotImageName()
        val ver = project.version.toString()
        val dockerfilePath = collectorbotDockerfilePath()
        commandLine("docker", "build",
            "-f", dockerfilePath,
            "-t", "${imageName}:local",
            "-t", "${imageName}:${ver}",
            ".")
    }
}

tasks.named("buildImage") {
    dependsOn(buildImageExec)
}

@Suppress("UNCHECKED_CAST")
val collectorbotPreflightChecks = extra["preflightChecks"] as TaskProvider<*>
val collectorbotIsDryRun: Boolean = extra["isDryRun"] as Boolean

val ensureCollectorbotEcrRepo by tasks.registering(Exec::class) {
    group = "publish"
    description = "Create ECR repository for collectorbot if it does not exist"
    onlyIf { !collectorbotIsDryRun }
    workingDir(project.projectDir)
    commandLine("echo", "placeholder")
    isIgnoreExitValue = true
    doFirst {
        val awsRegion = System.getenv("AWS_REGION")
            ?: throw GradleException("AWS_REGION not set in slot env — add to zbb.yaml")
        val imageName = collectorbotImageName()
        commandLine("aws", "ecr", "create-repository",
            "--repository-name", imageName,
            "--region", awsRegion)
    }
}

val publishImageEcr by tasks.registering(Exec::class) {
    group = "publish"
    description = "Build and push multi-arch collectorbot Docker image to ECR"
    dependsOn(tasks.named("buildImage"), ensureCollectorbotEcrRepo, collectorbotPreflightChecks)
    workingDir(project.projectDir)
    commandLine("echo", "placeholder")
    doFirst {
        val imageName = collectorbotImageName()
        val ver = project.version.toString().substringBefore("+")
        if (collectorbotIsDryRun) {
            val ecrRegistry = System.getenv("ECR_REGISTRY") ?: "<ECR_REGISTRY>"
            logger.lifecycle("[DRY RUN] Would push multi-arch collectorbot image to ECR: ${ecrRegistry}/${imageName}:${ver}")
            throw org.gradle.api.tasks.StopExecutionException()
        }
        val ecrRegistry = System.getenv("ECR_REGISTRY")
            ?: throw GradleException("ECR_REGISTRY not set in slot env — add to zbb.yaml")
        val dockerfilePath = collectorbotDockerfilePath()
        val ecrImage = "${ecrRegistry}/${imageName}:${ver}"
        commandLine("bash", "-c", """
            docker buildx build -f $dockerfilePath --platform linux/amd64,linux/arm64 -t $ecrImage --push . 2>&1 && exit 0

            echo "Buildx push failed with host credentials — retrying with explicit ECR auth..."
            TMPCONF=${'$'}(mktemp -d)
            if [ -d ~/.docker/buildx ]; then ln -sf ${'$'}(realpath ~/.docker/buildx) ${'$'}TMPCONF/buildx; fi
            ECR_TOKEN=${'$'}(aws ecr get-login-password --region ${System.getenv("AWS_REGION") ?: "us-east-1"})
            AUTH=${'$'}(echo -n "AWS:${'$'}ECR_TOKEN" | base64 -w0)
            echo '{"auths":{"$ecrRegistry":{"auth":"'"${'$'}AUTH"'"}}}' > ${'$'}TMPCONF/config.json
            DOCKER_CONFIG=${'$'}TMPCONF docker buildx build -f $dockerfilePath --platform linux/amd64,linux/arm64 -t $ecrImage --push .
            EXIT=${'$'}?
            rm -rf ${'$'}TMPCONF
            exit ${'$'}EXIT
        """.trimIndent())
    }
}

val publishImageGhcr by tasks.registering(Exec::class) {
    group = "publish"
    description = "Build and push multi-arch collectorbot Docker image to GHCR"
    dependsOn(tasks.named("buildImage"), publishImageEcr, collectorbotPreflightChecks)
    workingDir(project.projectDir)
    commandLine("echo", "placeholder")
    doFirst {
        val imageName = collectorbotImageName()
        val ver = project.version.toString().substringBefore("+")
        if (collectorbotIsDryRun) {
            val ghcrRegistry = System.getenv("GHCR_REGISTRY") ?: "<GHCR_REGISTRY>"
            logger.lifecycle("[DRY RUN] Would push multi-arch collectorbot image to GHCR: ${ghcrRegistry}/${imageName}:${ver}")
            throw org.gradle.api.tasks.StopExecutionException()
        }
        val ghcrRegistry = System.getenv("GHCR_REGISTRY")
            ?: throw GradleException("GHCR_REGISTRY not set in slot env — add to zbb.yaml")
        val dockerfilePath = collectorbotDockerfilePath()
        val ghcrImage = "${ghcrRegistry}/${imageName}:${ver}"
        val npmToken = System.getenv("NPM_TOKEN")
            ?: throw GradleException("NPM_TOKEN not set — needed for GHCR push")
        commandLine("bash", "-c", """
            docker buildx build -f $dockerfilePath --platform linux/amd64,linux/arm64 -t $ghcrImage --push . 2>&1 && exit 0

            echo "Buildx push failed with host credentials — retrying with explicit GHCR auth..."
            TMPCONF=${'$'}(mktemp -d)
            if [ -d ~/.docker/buildx ]; then ln -sf ${'$'}(realpath ~/.docker/buildx) ${'$'}TMPCONF/buildx; fi
            AUTH=${'$'}(echo -n "auditlogic:$npmToken" | base64 -w0)
            echo '{"auths":{"ghcr.io":{"auth":"'"${'$'}AUTH"'"}}}' > ${'$'}TMPCONF/config.json
            DOCKER_CONFIG=${'$'}TMPCONF docker buildx build -f $dockerfilePath --platform linux/amd64,linux/arm64 -t $ghcrImage --push .
            EXIT=${'$'}?
            rm -rf ${'$'}TMPCONF
            exit ${'$'}EXIT
        """.trimIndent())
    }
}

tasks.named("publishImage") {
    dependsOn(publishImageEcr, publishImageGhcr)
}

val collectorbotChangedSinceTag: Boolean = extra["changedSinceTag"] as Boolean

listOf(
    "publishImageEcr",
    "publishImageGhcr"
).forEach { taskName ->
    tasks.named(taskName) {
        onlyIf {
            if (!collectorbotChangedSinceTag) {
                logger.lifecycle("[$taskName] Skipping -- no changes since last tag")
            }
            collectorbotChangedSinceTag
        }
    }
}
