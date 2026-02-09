import com.github.gradle.node.npm.task.NpmTask
import com.github.gradle.node.npm.task.NpxTask
import com.zerobias.buildtools.module.ZbExtension
import com.zerobias.buildtools.module.OpenApiSpecAssembler
import com.zerobias.buildtools.module.ProductInfoDereferencer

plugins {
    id("zb.base")
    id("com.github.node-gradle.node")
}

val zb = extensions.getByType<ZbExtension>()
val npmDistTag: String = extra["npmDistTag"] as String

// ── Node.js configuration (uses system Node from nvm) ──

node {
    download.set(false)  // Use nvm-managed Node, don't download
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
}

tasks.named("buildHubSdk") {
    dependsOn(buildHubSdkExec)
}

val buildImageExec by tasks.registering(Exec::class) {
    group = "lifecycle"
    description = "Build Docker image"
    dependsOn(tasks.named("compile"))
    onlyIf { project.file("Dockerfile").exists() }
    workingDir(project.projectDir)
    val registry = project.findProperty("dockerRegistry")?.toString() ?: "localhost"
    val imageName = zb.dockerImageName.get()
    val ver = project.version.toString()
    commandLine("docker", "build",
        "-t", "${imageName}:local",
        "-t", "${registry}/${imageName}:${ver}",
        ".")
    inputs.file("Dockerfile").optional()
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
