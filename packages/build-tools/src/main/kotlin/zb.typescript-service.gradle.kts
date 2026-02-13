/**
 * Shared TypeScript service build plugin.
 *
 * Provides standard tasks for TypeScript-based services:
 * - NPM dependency management (via node-gradle plugin)
 * - Code generation
 * - Linting
 * - Transpilation
 * - Docker image building
 *
 * Usage:
 *   plugins {
 *       id("zb.typescript-service")
 *   }
 *
 *   zbTypeScript {
 *       nodeVersion = "22.21.1"
 *       imageName = "my-service"
 *       imageTag = "dev"
 *   }
 */

import com.github.gradle.node.npm.task.NpmTask
import com.zerobias.buildtools.util.ExecUtils

plugins {
    id("base")
    id("com.github.node-gradle.node")
}

// Extension for configuration
open class TypeScriptServiceExtension {
    var nodeVersion: String = "22.21.1"
    var imageName: String = "typescript-service"
    var imageTag: String = "dev"
    var enableLint: Boolean = true
    var enableGenerate: Boolean = true
    var dockerContext: String = "../image"  // Relative to project dir
}

val extension = extensions.create<TypeScriptServiceExtension>("zbTypeScript")

// Configure node-gradle plugin
node {
    // Use system Node (via nvm) instead of downloading
    download.set(false)

    // Node version is set by extension, but node-gradle needs it for task execution
    // When download=false, this is informational
    version.set(provider { extension.nodeVersion })

    // Use project directory for package.json
    nodeProjectDir.set(projectDir)
}

// ============================================================
// NPM Tasks (provided by node-gradle plugin)
// ============================================================

// npmInstall is auto-created by node-gradle plugin
// It monitors package.json and runs npm install when needed

// Custom npm tasks using NpmTask
tasks.register<NpmTask>("npmGenerate") {
    group = "build"
    description = "Run code generation"

    dependsOn("npmInstall")

    npmCommand.set(listOf("run", "generate"))

    inputs.files(fileTree("src") { include("**/*.ts") })
    inputs.files(fileTree(projectDir) { include("*.yml", "*.yaml") })
    outputs.dir("generated")

    onlyIf { extension.enableGenerate }
}

tasks.register<NpmTask>("npmLint") {
    group = "verification"
    description = "Run ESLint"

    dependsOn("npmInstall")

    npmCommand.set(listOf("run", "lint"))

    environment.put("FORCE_COLOR", "1")

    inputs.files(fileTree("src") { include("**/*.ts") })
    inputs.files(fileTree("generated") { include("**/*.ts") })
    outputs.upToDateWhen { false }  // Lint check, always run

    onlyIf { extension.enableLint }
}

tasks.register<NpmTask>("npmTranspile") {
    group = "build"
    description = "Transpile TypeScript to JavaScript"

    dependsOn("npmGenerate")

    npmCommand.set(listOf("run", "transpile"))

    inputs.files(fileTree("src") { include("**/*.ts") })
    inputs.files(fileTree("generated") { include("**/*.ts") })
    inputs.file("tsconfig.json")
    outputs.dir("dist")
}

val npmBuild by tasks.registering {
    group = "build"
    description = "Full NPM build (lint + generate + transpile)"

    if (extension.enableLint) {
        dependsOn("npmLint")
    }
    dependsOn("npmTranspile")

    doLast {
        println("✓ TypeScript build complete")
    }
}

// ============================================================
// Docker Tasks
// ============================================================

tasks.register("prepareDockerContext") {
    group = "docker"
    description = "Prepare Docker build context using npm pack"

    dependsOn(npmBuild)

    val dockerContextDir = projectDir.resolve(extension.dockerContext).resolve("package")

    doFirst {
        println("Preparing Docker context...")

        // Clean previous context
        delete(dockerContextDir)

        // Run npm pack
        println("Running npm pack...")
        ExecUtils.exec(
            command = listOf("npm", "pack", "--pack-destination", dockerContextDir.parentFile.absolutePath),
            workingDir = projectDir
        )

        // Find and extract tarball
        val tarball = dockerContextDir.parentFile.listFiles { f -> f.name.endsWith(".tgz") }?.firstOrNull()
            ?: throw GradleException("No tarball found after npm pack")

        println("Extracting ${tarball.name}...")
        ExecUtils.exec(
            command = listOf("tar", "-xzf", tarball.name),
            workingDir = dockerContextDir.parentFile
        )

        // Clean up tarball
        delete(tarball)

        println("✓ Docker context prepared at: $dockerContextDir")
    }
}

tasks.register("dockerBuild") {
    group = "docker"
    description = "Build Docker image"

    dependsOn("prepareDockerContext")

    val imageName = provider { "${extension.imageName}:${extension.imageTag}" }
    val dockerContextDir = projectDir.resolve(extension.dockerContext)

    doFirst {
        val image = imageName.get()
        println("Building Docker image: $image")
        println("Context: $dockerContextDir")

        // Verify tokens are available
        val npmToken = System.getenv("NPM_TOKEN") ?: ""
        val zbToken = System.getenv("ZB_TOKEN") ?: ""
        if (npmToken.isEmpty() || zbToken.isEmpty()) {
            println("WARNING: NPM_TOKEN or ZB_TOKEN not set - Docker build may fail")
        }

        ExecUtils.exec(
            command = listOf(
                "docker", "build",
                "-t", image,
                "--build-arg", "npm_token=${npmToken}",
                "--build-arg", "zb_token=${zbToken}",
                "."
            ),
            workingDir = dockerContextDir
        )

        println("✓ Docker image built: $image")
    }
}

// ============================================================
// Lifecycle Integration
// ============================================================

tasks.named("build") {
    group = "lifecycle"
    description = "Build everything including Docker image"

    dependsOn(npmBuild, "dockerBuild")
}
