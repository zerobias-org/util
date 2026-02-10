import com.github.gradle.node.npm.task.NpmTask
import com.github.gradle.node.npm.task.NpxTask
import com.zerobias.buildtools.module.ZbExtension
import com.zerobias.buildtools.module.OpenApiSpecAssembler
import com.zerobias.buildtools.module.ProductInfoDereferencer
import com.zerobias.buildtools.module.ServerEntryPointGenerator

plugins {
    id("zb.base")
    id("com.github.node-gradle.node")
}

val zb = extensions.getByType<ZbExtension>()
val npmDistTag: String = extra["npmDistTag"] as String

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

// ── Intermediate file paths for incremental builds ──
// Files stay in project root (not build/) so $ref resolution works with node_modules

val assembledSpec = project.file("full-assembled.yml")
val bundledSpec = project.file("full-bundled.yml")

// ════════════════════════════════════════════════════════════
// VALIDATE phase
// ════════════════════════════════════════════════════════════

val validateSpec by tasks.registering(NpxTask::class) {
    group = "lifecycle"
    description = "Lint OpenAPI specification with Redocly"
    workingDir.set(project.projectDir)
    command.set("@redocly/cli")
    // Auto-detect redocly config: redocly.yaml or .redocly.yaml
    val configFile = if (project.file(".redocly.yaml").exists()) ".redocly.yaml" else "redocly.yaml"
    args.set(listOf("lint", "api.yml", "--config", configFile))
    inputs.file("api.yml")
    inputs.file(configFile).optional()
    outputs.file(layout.buildDirectory.file("validated-spec.marker"))
    doLast {
        layout.buildDirectory.file("validated-spec.marker").get().asFile.apply {
            parentFile.mkdirs()
            writeText("validated")
        }
    }
}

tasks.named("validate") {
    dependsOn(validateSpec)
}

// ════════════════════════════════════════════════════════════
// GENERATE phase — stages G2 through G8
//
// Pipeline: assembleSpec → npmInstall → bundleSpec →
//           dereferenceProductInfos → [generateApi, copyDistributionSpec] →
//           postGenerate
//
// Uses intermediate files in build/spec/ for proper incremental builds.
// ════════════════════════════════════════════════════════════

// G2: assembleSpec — build full-assembled.yml from api.yml + optional $ref injections
val assembleSpec by tasks.registering {
    group = "lifecycle"
    description = "Assemble spec from api.yml with ConnectionProfile/State refs"
    inputs.file("api.yml")
    if (project.file("connectionProfile.yml").exists()) {
        inputs.file("connectionProfile.yml")
    }
    if (project.file("connectionState.yml").exists()) {
        inputs.file("connectionState.yml")
    }
    outputs.file(assembledSpec)
    doLast {
        OpenApiSpecAssembler.assemble(project.projectDir, assembledSpec)
    }
}

// G3: npmInstall — install npm dependencies (needed for bundleSpec $ref resolution)
val npmInstallModule by tasks.registering(NpmTask::class) {
    group = "lifecycle"
    description = "Install npm dependencies"
    npmCommand.set(listOf("install"))
    workingDir.set(project.projectDir)
    inputs.file("package.json")
    inputs.file("package-lock.json").optional()
    outputs.dir("node_modules")
}

// G4: bundleSpec — inline all $ref entries via Redocly CLI
val bundleSpec by tasks.registering(NpxTask::class) {
    group = "lifecycle"
    description = "Bundle all \$ref entries into self-contained spec"
    dependsOn(assembleSpec, npmInstallModule)
    workingDir.set(project.projectDir)
    command.set("@redocly/cli")
    args.set(listOf("bundle", assembledSpec.name, "--output", bundledSpec.name))
    inputs.file(assembledSpec)
    inputs.dir("node_modules")
    outputs.file(bundledSpec)
}

// G5: dereferenceProductInfos — resolve $refs in x-product-infos → final full.yml
val dereferenceProductInfos by tasks.registering {
    group = "lifecycle"
    description = "Dereference product info refs, produce final full.yml"
    dependsOn(bundleSpec)
    inputs.file(bundledSpec)
    inputs.dir("node_modules")
    outputs.file("full.yml")
    doLast {
        ProductInfoDereferencer.dereference(
            bundledSpec,
            project.file("full.yml"),
            project.projectDir
        )
    }
}

// G6: copyDistributionSpec — create module-{name}.yml distribution artifact
val copyDistributionSpec by tasks.registering {
    group = "lifecycle"
    description = "Copy bundled spec to distribution artifact (module-{name}.yml)"
    dependsOn(dereferenceProductInfos)
    inputs.file("full.yml")
    inputs.property("includeConnectionProfile", zb.includeConnectionProfileInDist)
    outputs.file(project.provider {
        val moduleName = OpenApiSpecAssembler.resolveModuleName(project.projectDir)
        project.file("${moduleName}.yml")
    })
    doLast {
        val moduleName = OpenApiSpecAssembler.resolveModuleName(project.projectDir)
        val fullYml = project.file("full.yml")
        val distYml = project.file("${moduleName}.yml")

        if (zb.includeConnectionProfileInDist.get()) {
            fullYml.copyTo(distYml, overwrite = true)
        } else {
            OpenApiSpecAssembler.copyWithoutConnectionSchemas(fullYml, distYml)
        }
    }
}

// G7: generateApi — run hub-generator codegen on full.yml
val generateApi by tasks.registering(NpxTask::class) {
    group = "lifecycle"
    description = "Generate TypeScript interfaces from OpenAPI spec"
    dependsOn(dereferenceProductInfos, npmInstallModule)
    workingDir.set(project.projectDir)
    command.set("hub-generator")
    args.set(project.provider {
        buildList {
            add("generate")
            add("-g"); add("hub-module")
            add("-i"); add("full.yml")
            add("-o"); add("generated/")
            if (zb.hasConnectionProfile.get()) {
                add("-p"); add("isConnector=true")
            }
            if (project.file("connectionState.yml").exists()) {
                add("-p"); add("hasState=true")
            }
            addAll(zb.generatorArgs.get())
        }
    })
    inputs.file("full.yml")
    inputs.property("hasConnectionProfile", zb.hasConnectionProfile)
    inputs.property("generatorArgs", zb.generatorArgs)
    outputs.dir("generated")
}

// G8: postGenerate — optional escape hatch for module-specific fixes
val postGenerate by tasks.registering {
    group = "lifecycle"
    description = "Run post-generation fixes (edge case escape hatch)"
    dependsOn(generateApi)
    onlyIf { zb.postGenerateScript.isPresent }
    doLast {
        project.exec {
            workingDir(project.projectDir)
            commandLine("bash", "-c", zb.postGenerateScript.get())
        }
    }
}

// Wire all generate stages into the lifecycle
tasks.named("generate") {
    dependsOn(copyDistributionSpec, generateApi, postGenerate)
}

// ════════════════════════════════════════════════════════════
// COMPILE phase
// ════════════════════════════════════════════════════════════

val transpile by tasks.registering(NpxTask::class) {
    group = "lifecycle"
    description = "Compile TypeScript (ESM)"
    dependsOn(npmInstallModule, tasks.named("generate"))
    workingDir.set(project.projectDir)
    command.set("tsc")
    inputs.dir("src")
    inputs.dir("generated")
    inputs.file("tsconfig.json").optional()
    outputs.dir("dist")
    // Clean stale server files that would cause compilation errors.
    // Server files are re-generated by generateServerEntry/generateServerApi
    // and compiled by compileServer in the Docker build pipeline.
    doFirst {
        val serverEntry = project.file("generated/server-entry.ts")
        if (serverEntry.exists()) serverEntry.delete()
        val serverDir = project.file("generated/server")
        if (serverDir.exists()) serverDir.deleteRecursively()
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

val testIntegrationExec by tasks.registering(NpxTask::class) {
    group = "lifecycle"
    description = "Run mocha integration tests"
    dependsOn(tasks.named("compile"))
    workingDir.set(project.projectDir)
    command.set("mocha")
    args.set(listOf("--recursive", "test/integration/"))
    onlyIf { project.file("test/integration").exists() }
}

tasks.named("testIntegration") {
    dependsOn(testIntegrationExec)
}

val testDockerExec by tasks.registering(NpxTask::class) {
    group = "lifecycle"
    description = "Run Docker integration tests with module-tester"
    dependsOn(tasks.named("compile"))
    workingDir.set(project.projectDir)
    command.set("mocha")
    args.set(listOf(
        "--config", ".mocharc.docker.json",
        "--inline-diffs",
        "--reporter=list",
        "--timeout", "180000",
        "test/docker/**/*.ts"
    ))
    if (project.hasProperty("profile")) {
        environment.put("npm_config_profile", project.property("profile") as String)
    }
    onlyIf { project.file("test/docker").exists() }
}

tasks.named("testDocker") {
    dependsOn(testDockerExec)
}

// ════════════════════════════════════════════════════════════
// DOCKER SERVER — generate REST server + Dockerfile for Docker builds
//
// Pipeline: installServerDeps → generateServerApi → generateServerEntry
//           → compileServer → generateDockerfile → buildImageExec
//
// These tasks only run when buildImage or testDocker is in the task graph.
// ════════════════════════════════════════════════════════════

// Helper: check if Docker-related tasks are in the graph
fun isDockerBuild(): Boolean {
    return try {
        gradle.taskGraph.hasTask(tasks.named("buildImage").get()) ||
        gradle.taskGraph.hasTask(tasks.named("testDocker").get())
    } catch (_: Exception) {
        false
    }
}

// Install server runtime dependencies (Express, OpenAPI validator, etc.)
val installServerDeps by tasks.registering(NpmTask::class) {
    group = "lifecycle"
    description = "Install server runtime dependencies for Docker image"
    dependsOn(npmInstallModule)
    workingDir.set(project.projectDir)
    npmCommand.set(listOf("install"))
    args.set(listOf(
        "-E",
        "express@4.18.1",
        "express-async-errors@3.1.1",
        "express-openapi-validator@4.13.6",
        "esprima@4.0.1",
        "pem@1.14.6"
    ))
    onlyIf { isDockerBuild() }
}

val installServerDevDeps by tasks.registering(NpmTask::class) {
    group = "lifecycle"
    description = "Install server dev dependencies for Docker image"
    dependsOn(installServerDeps)
    workingDir.set(project.projectDir)
    npmCommand.set(listOf("install"))
    args.set(listOf(
        "-D", "-E",
        "@types/express@4.17.13"
    ))
    onlyIf { isDockerBuild() }
}

val installServerPlatformDeps by tasks.registering(NpmTask::class) {
    group = "lifecycle"
    description = "Install server platform dependencies for Docker image"
    dependsOn(installServerDevDeps)
    workingDir.set(project.projectDir)
    npmCommand.set(listOf("install"))
    args.set(listOf(
        "-E",
        "@zerobias-org/types-core-js@latest",
        "@zerobias-org/logger@latest",
        "@zerobias-org/util-hub-module-utils@latest",
        "@zerobias-com/hub-core@latest"
    ))
    onlyIf { isDockerBuild() }
}

// Generate REST server controllers from OpenAPI spec
val generateServerApi by tasks.registering(NpxTask::class) {
    group = "lifecycle"
    description = "Generate REST server controllers from OpenAPI spec"
    dependsOn(dereferenceProductInfos, npmInstallModule)
    mustRunAfter(transpile)  // Avoid output overlap with generated/ directory
    workingDir.set(project.projectDir)
    command.set("hub-generator")
    args.set(listOf(
        "generate",
        "-g", "hub-module-server",
        "-i", "full.yml",
        "-o", "generated/",
        "-p", "modulePackage=../api"
    ))
    inputs.file("full.yml")
    outputs.file(layout.buildDirectory.file("server-api-generated.marker"))
    onlyIf { isDockerBuild() }
    doLast {
        val serverDir = project.file("generated/server")
        if (serverDir.exists()) {
            serverDir.listFiles()?.filter { it.extension == "ts" && it.name != "index.ts" }?.forEach { file ->
                var content = file.readText()
                // Fix 1: header params like "If-Match" generate invalid variable names
                content = content.replace("let If-Match:", "let ifMatch:")
                // Fix 2: controllers import from ../api/index.js which doesn't re-export
                // model types (ObjectSerializer, model classes). Redirect to ../../src/index.js
                // which re-exports from both generated/api and generated/model.
                content = content.replace("from '../api/index.js'", "from '../../src/index.js'")
                file.writeText(content)
            }
        }
        layout.buildDirectory.file("server-api-generated.marker").get().asFile.apply {
            parentFile.mkdirs()
            writeText("generated")
        }
    }
}

// Generate server-entry.ts — the Express app entry point
val generateServerEntry by tasks.registering {
    group = "lifecycle"
    description = "Generate server-entry.ts entry point"
    dependsOn(generateServerApi)
    mustRunAfter(transpile)  // Avoid output overlap with generated/ directory
    inputs.file("full.yml")
    outputs.file(layout.buildDirectory.file("server-entry-generated.marker"))
    onlyIf { isDockerBuild() }
    doLast {
        val pascal = ServerEntryPointGenerator.resolveModulePascalName(project.projectDir)
        val content = ServerEntryPointGenerator.generate(pascal)
        project.file("generated/server-entry.ts").writeText(content)
        layout.buildDirectory.file("server-entry-generated.marker").get().asFile.apply {
            parentFile.mkdirs()
            writeText("generated")
        }
    }
}

// Re-compile TypeScript to include generated server code
val compileServer by tasks.registering(NpxTask::class) {
    group = "lifecycle"
    description = "Compile TypeScript including server code"
    dependsOn(transpile, generateServerEntry, installServerPlatformDeps)
    workingDir.set(project.projectDir)
    command.set("tsc")
    inputs.file(layout.buildDirectory.file("server-api-generated.marker"))
    inputs.file(layout.buildDirectory.file("server-entry-generated.marker"))
    outputs.file(layout.buildDirectory.file("server-compiled.marker"))
    onlyIf { isDockerBuild() }
    doLast {
        layout.buildDirectory.file("server-compiled.marker").get().asFile.apply {
            parentFile.mkdirs()
            writeText("compiled")
        }
    }
}

// Generate a default Dockerfile if one doesn't exist
val generateDockerfile by tasks.registering {
    group = "lifecycle"
    description = "Generate default Dockerfile for module"
    dependsOn(compileServer)
    outputs.file("Dockerfile")
    onlyIf { isDockerBuild() && !project.file("Dockerfile").exists() }
    doLast {
        val dockerfile = """
            |FROM node:22-alpine
            |LABEL org.opencontainers.image.source https://github.com/auditlogic/module
            |RUN apk update && apk add ca-certificates openssl && rm -rf /var/cache/apk/*
            |WORKDIR /opt/module
            |COPY dist ./dist
            |COPY node_modules ./node_modules
            |COPY package.json .
            |COPY *.yml .
            |EXPOSE 8888
            |CMD ["node", "dist/generated/server-entry.js"]
        """.trimMargin() + "\n"
        project.file("Dockerfile").writeText(dockerfile)
    }
}

// ════════════════════════════════════════════════════════════
// BUILD ARTIFACTS
// ════════════════════════════════════════════════════════════

// A1: Hub SDK — generate api-client SDK for hub-server callers
val buildHubSdkExec by tasks.registering(NpxTask::class) {
    group = "lifecycle"
    description = "Generate hub-server caller SDK"
    dependsOn(dereferenceProductInfos, npmInstallModule)
    workingDir.set(project.projectDir)
    command.set("hub-generator")
    args.set(listOf("generate", "-g", "api-client", "-i", "full.yml", "-o", "hub-sdk/generated/"))
    inputs.file("full.yml")
    outputs.dir("hub-sdk/generated")
    doLast {
        // Fix: ConnectionProfile is a type-only export from util-api-client-base.
        // The generator emits a value re-export which fails at runtime in ESM.
        val sdkIndex = project.file("hub-sdk/generated/api/index.ts")
        if (sdkIndex.exists()) {
            var content = sdkIndex.readText()
            content = content.replace(
                "export { ConnectionProfile } from '@zerobias-org/util-api-client-base'",
                "export type { ConnectionProfile } from '@zerobias-org/util-api-client-base'"
            )
            sdkIndex.writeText(content)
        }
    }
}

tasks.named("buildHubSdk") {
    dependsOn(buildHubSdkExec)
}

val buildImageExec by tasks.registering(Exec::class) {
    group = "lifecycle"
    description = "Build Docker image"
    dependsOn(compileServer, generateDockerfile)
    workingDir(project.projectDir)
    val registry = project.findProperty("dockerRegistry")?.toString() ?: "localhost"
    val imageName = zb.dockerImageName.get()
    val ver = project.version.toString()
    commandLine("docker", "build",
        "-t", "${imageName}:local",
        "-t", "${registry}/${imageName}:${ver}",
        ".")
    inputs.file("Dockerfile")
    inputs.dir("dist")
    inputs.file("package.json")
}

tasks.named("buildImage") {
    dependsOn(buildImageExec)
}

// ════════════════════════════════════════════════════════════
// PUBLISH
// ════════════════════════════════════════════════════════════

val publishNpmExec by tasks.registering(NpmTask::class) {
    group = "publish"
    description = "Publish npm package with dist-tag"
    dependsOn(tasks.named("gate"))
    npmCommand.set(listOf("publish"))
    args.set(listOf("--tag", npmDistTag))
    workingDir.set(project.projectDir)
}

tasks.named("publishNpm") {
    dependsOn(publishNpmExec)
}

val publishImageExec by tasks.registering(Exec::class) {
    group = "publish"
    description = "Push Docker image to registry"
    dependsOn(tasks.named("buildImage"))
    workingDir(project.projectDir)
    val registry = project.findProperty("dockerRegistry")?.toString() ?: "localhost"
    val imageName = zb.dockerImageName.get()
    val ver = project.version.toString()
    commandLine("docker", "push", "${registry}/${imageName}:${ver}")
}

tasks.named("publishImage") {
    dependsOn(publishImageExec)
}
