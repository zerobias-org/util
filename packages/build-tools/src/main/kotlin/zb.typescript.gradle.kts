import com.github.gradle.node.npm.task.NpmTask
import com.github.gradle.node.npm.task.NpxTask
import com.zerobias.buildtools.ZbExtension

plugins {
    id("zb.base")
    id("com.github.node-gradle.node")
}

val zb = extensions.getByType<ZbExtension>()
val npmDistTag: String = extra["npmDistTag"] as String

// ── Node.js configuration (managed by Gradle) ──

node {
    version.set(project.property("nodeVersion") as String)
    download.set(true)
}

// ── GENERATE phase ──

val generateFull by tasks.registering(NpxTask::class) {
    group = "lifecycle"
    description = "Inflate and merge OpenAPI specs"
    dependsOn(tasks.named("validate"))
    workingDir.set(project.projectDir)
    command.set("hub-generator")
    args.set(listOf("generate", "-g", "hub-module-full", "-i", "api.yml", "-o", "generated/"))
}

val generateApi by tasks.registering(NpxTask::class) {
    group = "lifecycle"
    description = "Generate TypeScript interfaces from OpenAPI"
    dependsOn(generateFull)
    workingDir.set(project.projectDir)
    command.set("hub-generator")
    args.set(listOf("generate", "-g", "hub-module", "-i", "generated/full.yml", "-o", "generated/"))
}

val generateTestClient by tasks.registering(NpxTask::class) {
    group = "lifecycle"
    description = "Generate test client from OpenAPI"
    dependsOn(generateFull)
    workingDir.set(project.projectDir)
    command.set("hub-generator")
    args.set(listOf("generate", "-g", "hub-module-test-client", "-i", "generated/full.yml", "-o", "test/generated/"))
}

tasks.named("generate") {
    dependsOn(generateFull, generateApi, generateTestClient)
}

// ── NPM INSTALL (Gradle tracks inputs/outputs for caching) ──

val npmInstallModule by tasks.registering(NpmTask::class) {
    group = "lifecycle"
    description = "Install npm dependencies"
    npmCommand.set(listOf("install"))
    workingDir.set(project.projectDir)
    inputs.file(project.file("package.json"))
    inputs.file(project.file("package-lock.json")).optional()
    outputs.dir(project.file("node_modules"))
}

// ── COMPILE phase ──

val transpile by tasks.registering(NpxTask::class) {
    group = "lifecycle"
    description = "Compile TypeScript (ESM)"
    dependsOn(npmInstallModule, tasks.named("generate"))
    workingDir.set(project.projectDir)
    command.set("tsc")
    inputs.dir("src")
    inputs.dir("generated").optional()
    outputs.dir("dist")
}

tasks.named("compile") {
    dependsOn(transpile)
}

// ── TEST phase ──

val unitTestExec by tasks.registering(NpxTask::class) {
    group = "lifecycle"
    description = "Run mocha unit tests"
    dependsOn(tasks.named("compile"))
    workingDir.set(project.projectDir)
    command.set("mocha")
    args.set(listOf("--recursive", "test/unit/"))
}

tasks.named("unitTest") {
    dependsOn(unitTestExec)
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
}

tasks.named("testDocker") {
    dependsOn(testDockerExec)
}

// ── BUILD ARTIFACTS ──

val buildHubSdkExec by tasks.registering(NpxTask::class) {
    group = "lifecycle"
    description = "Generate hub-server caller SDK"
    dependsOn(generateFull)
    workingDir.set(project.projectDir)
    command.set("hub-generator")
    args.set(listOf("generate", "-g", "api-client", "-i", "generated/full.yml", "-o", "hub-sdk/generated/"))
}

tasks.named("buildHubSdk") {
    dependsOn(buildHubSdkExec)
}

val buildImageExec by tasks.registering(Exec::class) {
    group = "lifecycle"
    description = "Build Docker image"
    dependsOn(tasks.named("compile"))
    workingDir(project.projectDir)
    val registry = project.property("dockerRegistry") as String
    val imageName = zb.dockerImageName.get()
    val ver = project.version.toString()
    commandLine("docker", "build",
        "-t", "${imageName}:local",
        "-t", "${registry}/${imageName}:${ver}",
        ".")
}

tasks.named("buildImage") {
    dependsOn(buildImageExec)
}

// ── PUBLISH ──

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
    val registry = project.property("dockerRegistry") as String
    val imageName = zb.dockerImageName.get()
    val ver = project.version.toString()
    commandLine("docker", "push", "${registry}/${imageName}:${ver}")
}

tasks.named("publishImage") {
    dependsOn(publishImageExec)
}
