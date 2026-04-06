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
    var npmInstallDeps: List<String> = emptyList()  // Additional task dependencies for npmInstall

    // Cross-project build ordering for monorepos with workspace dependencies
    // Maps workspace package dir name to Gradle project name (e.g., "core" to "core")
    var workspaceDeps: Map<String, String> = emptyMap()
    // Additional task dependencies for npmGenerate (e.g., listOf(":core:npmGenerate"))
    var npmGenerateDeps: List<String> = emptyList()
    // Additional task dependencies for npmTranspile (e.g., listOf(":core:npmTranspile"))
    var npmTranspileDeps: List<String> = emptyList()
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
// Clean — delete generated/ and dist/ (outside build/)
// ============================================================

tasks.named("clean") {
    doLast {
        delete("generated")
        delete("dist")
    }
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

    dependsOn("npmInstall", "npmGenerate")

    npmCommand.set(listOf("run", "lint"))

    environment.put("FORCE_COLOR", "1")

    inputs.files(fileTree("src") { include("**/*.ts") })
    inputs.files(fileTree("generated") { include("**/*.ts") })

    // Stamp file so Gradle can track up-to-date state
    val lintStamp = layout.buildDirectory.file("lint.stamp")
    outputs.file(lintStamp)

    onlyIf { extension.enableLint }

    doLast {
        lintStamp.get().asFile.apply {
            parentFile.mkdirs()
            writeText("lint passed at ${java.time.Instant.now()}")
        }
    }
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
}

// Wire up cross-project build ordering after extension is configured
afterEvaluate {
    if (extension.npmGenerateDeps.isNotEmpty()) {
        tasks.named("npmGenerate") {
            dependsOn(extension.npmGenerateDeps)
        }
    }
    if (extension.npmTranspileDeps.isNotEmpty()) {
        tasks.named("npmTranspile") {
            dependsOn(extension.npmTranspileDeps)
        }
    }
}

// ============================================================
// Docker Tasks
// ============================================================

// Build service to serialize prepublish-standalone across parallel subprojects
// (it temporarily mutates package.json in-place)
abstract class PrepublishLockService : BuildService<BuildServiceParameters.None>
val prepublishLock = gradle.sharedServices.registerIfAbsent("prepublishLock", PrepublishLockService::class.java) {}

// npmPack holds the prepublish lock only for the duration of:
//   prepublish-standalone → npm pack → restore
// This allows other subprojects' docker builds to run concurrently.
tasks.register("npmPack") {
    group = "docker"
    description = "Run prepublish-standalone and npm pack (serialized across subprojects)"

    dependsOn(npmBuild)
    usesService(prepublishLock)

    val imageDir = projectDir.resolve(extension.dockerContext)

    inputs.files(fileTree("src") { include("**/*.ts") })
    inputs.files(fileTree("generated") { include("**/*.ts") })
    inputs.file("package.json")
    inputs.file(projectDir.resolve("../package.json"))

    // Stamp file as durable output (the .tgz is consumed by prepareDockerContext)
    val packStamp = layout.buildDirectory.file("npm-pack.stamp")
    outputs.file(packStamp)

    doFirst {
        // Clean any leftover tarballs
        imageDir.listFiles { f -> f.name.endsWith(".tgz") }?.forEach { delete(it) }

        val packageJson = projectDir.resolve("package.json")
        val packageJsonBackup = projectDir.resolve("package.json.gradle-bak")
        val prepublishScript = projectDir.resolve("../node_modules/@zerobias-org/devops-tools/scripts/prepublish-standalone.sh")

        try {
            if (prepublishScript.exists()) {
                // Back up package.json preserving timestamps so Gradle caching isn't invalidated
                ExecUtils.exec(
                    command = listOf("cp", "-a", packageJson.absolutePath, packageJsonBackup.absolutePath),
                    workingDir = projectDir
                )

                println("Running prepublish-standalone...")
                ExecUtils.exec(
                    command = listOf("bash", prepublishScript.absolutePath),
                    workingDir = projectDir
                )
            } else {
                println("WARNING: prepublish-standalone.sh not found — Docker image may be missing dependencies")
            }

            println("Running npm pack...")
            ExecUtils.exec(
                command = listOf("npm", "pack", "--pack-destination", imageDir.absolutePath),
                workingDir = projectDir
            )
        } finally {
            // Restore original package.json with preserved timestamps
            if (packageJsonBackup.exists()) {
                ExecUtils.exec(
                    command = listOf("mv", packageJsonBackup.absolutePath, packageJson.absolutePath),
                    workingDir = projectDir
                )
            }
        }

        packStamp.get().asFile.apply {
            parentFile.mkdirs()
            writeText("packed at ${java.time.Instant.now()}")
        }
    }
}

tasks.register("prepareDockerContext") {
    group = "docker"
    description = "Extract npm pack tarball into Docker build context"

    dependsOn("npmPack")

    val imageDir = projectDir.resolve(extension.dockerContext)
    val dockerContextDir = imageDir.resolve("package")

    inputs.file(layout.buildDirectory.file("npm-pack.stamp"))
    outputs.dir(dockerContextDir)

    doFirst {
        // Clean previous context and stale lockfile
        delete(dockerContextDir)
        delete(imageDir.resolve("package-lock.json"))

        val tarball = imageDir.listFiles { f -> f.name.endsWith(".tgz") }?.firstOrNull()
            ?: throw GradleException("No tarball found — npmPack may have failed")

        println("Extracting ${tarball.name}...")
        ExecUtils.exec(
            command = listOf("tar", "-xzf", tarball.name),
            workingDir = imageDir
        )

        delete(tarball)

        // Bundle local workspace dependencies into Docker context
        if (extension.workspaceDeps.isNotEmpty()) {
            val localDepsDir = dockerContextDir.resolve("local_deps")
            localDepsDir.mkdirs()

            val packageJsonFile = dockerContextDir.resolve("package.json")
            var packageJsonText = packageJsonFile.readText()

            for ((_, wsPath) in extension.workspaceDeps) {
                val wsProjectDir = projectDir.resolve("../$wsPath")
                val wsPackageJson = wsProjectDir.resolve("package.json")
                if (!wsPackageJson.exists()) continue

                val wsPackageJsonObj = groovy.json.JsonSlurper().parseText(wsPackageJson.readText()) as Map<*, *>
                val wsName = wsPackageJsonObj["name"] as? String ?: continue
                val wsVersion = wsPackageJsonObj["version"] as? String ?: continue

                // Only bundle if this is actually a dependency in the packed package.json
                if (!packageJsonText.contains("\"$wsName\"")) continue

                // Run prepublish-standalone on workspace dep to resolve its dependencies
                val wsPrepublishScript = projectDir.resolve("../node_modules/@zerobias-org/devops-tools/scripts/prepublish-standalone.sh")
                val wsPackageJsonBackup = wsProjectDir.resolve("package.json.gradle-bak")
                val wsRootDir = projectDir.resolve("..")

                if (wsPrepublishScript.exists()) {
                    ExecUtils.exec(
                        command = listOf("cp", "-a", wsPackageJson.absolutePath, wsPackageJsonBackup.absolutePath),
                        workingDir = wsProjectDir
                    )
                    try {
                        ExecUtils.exec(
                            command = listOf("bash", wsPrepublishScript.absolutePath, wsRootDir.absolutePath, "--library"),
                            workingDir = wsProjectDir
                        )
                    } catch (e: Exception) {
                        // Restore on failure and continue
                        if (wsPackageJsonBackup.exists()) {
                            ExecUtils.exec(
                                command = listOf("mv", wsPackageJsonBackup.absolutePath, wsPackageJson.absolutePath),
                                workingDir = wsProjectDir
                            )
                        }
                        println("  ⚠ prepublish-standalone failed for $wsName, using as-is")
                    }
                }

                // npm pack the workspace package into local_deps as a tarball
                println("Packing local workspace dep: $wsName")
                try {
                    ExecUtils.exec(
                        command = listOf("npm", "pack", "--pack-destination", localDepsDir.absolutePath),
                        workingDir = wsProjectDir
                    )
                } finally {
                    // Always restore original package.json
                    if (wsPackageJsonBackup.exists()) {
                        ExecUtils.exec(
                            command = listOf("mv", wsPackageJsonBackup.absolutePath, wsPackageJson.absolutePath),
                            workingDir = wsProjectDir
                        )
                    }
                }

                // Find the tarball that was just created
                val wsTarball = localDepsDir.listFiles { f ->
                    f.name.endsWith(".tgz") && !f.name.startsWith(".")
                }?.sortedByDescending { it.lastModified() }?.firstOrNull()

                if (wsTarball != null) {
                    // Patch package.json to use file: reference to the tarball
                    packageJsonText = packageJsonText.replace(
                        "\"$wsName\": \"$wsVersion\"",
                        "\"$wsName\": \"file:./local_deps/${wsTarball.name}\""
                    )
                    println("  ✓ Bundled $wsName → local_deps/${wsTarball.name}")
                }
            }

            packageJsonFile.writeText(packageJsonText)
        }

        println("✓ Docker context prepared at: $dockerContextDir")
    }
}

// Inject locally-published packages from zbb registry into the Docker context.
// Reads ZBB_LOCAL_DEPS env var (JSON: [{name, version, tarball}]) set by zbb build.
// Copies tarballs into package/local_deps/ and patches package.json to use file: refs.
tasks.register("injectLocalDeps") {
    group = "docker"
    description = "Inject locally-published zbb registry packages into Docker context"

    dependsOn("prepareDockerContext")

    val dockerContextDir = projectDir.resolve(extension.dockerContext)
    val packageDir = dockerContextDir.resolve("package")

    doFirst {
        // Read from file written by zbb (env vars don't reach the Gradle daemon)
        val localDepsFile = projectDir.resolve("../.zbb-local-deps/manifest.json")
        if (!localDepsFile.exists()) return@doFirst
        val localDepsJson = localDepsFile.readText()
        if (localDepsJson.isBlank()) return@doFirst

        @Suppress("UNCHECKED_CAST")
        val deps = (groovy.json.JsonSlurper().parseText(localDepsJson) as? List<Map<String, String>>) ?: return@doFirst
        if (deps.isEmpty()) return@doFirst

        val localDepsDir = packageDir.resolve("local_deps")
        localDepsDir.mkdirs()

        val packageJsonFile = packageDir.resolve("package.json")
        val packageJson = groovy.json.JsonSlurper().parseText(packageJsonFile.readText()) as MutableMap<String, Any?>

        @Suppress("UNCHECKED_CAST")
        val dependencies = packageJson["dependencies"] as? MutableMap<String, String> ?: mutableMapOf()
        @Suppress("UNCHECKED_CAST")
        val overrides = packageJson["overrides"] as? MutableMap<String, Any?> ?: mutableMapOf()

        for (dep in deps) {
            val name = dep["name"] ?: continue
            val tarball = dep["tarball"] ?: continue
            val tarballFile = java.io.File(tarball)
            if (!tarballFile.exists()) {
                println("  [registry] Warning: tarball not found: $tarball")
                continue
            }

            val destFile = localDepsDir.resolve(tarballFile.name)
            tarballFile.copyTo(destFile, overwrite = true)

            val fileRef = "file:local_deps/${tarballFile.name}"
            if (dependencies.containsKey(name)) {
                dependencies[name] = fileRef
            }
            if (overrides.containsKey(name)) {
                overrides[name] = fileRef
            }
            println("  [registry] Injected $name → $fileRef")
        }

        packageJson["dependencies"] = dependencies
        packageJson["overrides"] = overrides
        packageJsonFile.writeText(groovy.json.JsonOutput.prettyPrint(groovy.json.JsonOutput.toJson(packageJson)))
    }
}

tasks.register("dockerBuild") {
    group = "docker"
    description = "Build Docker image"

    dependsOn("injectLocalDeps")

    val imageName = provider { "${extension.imageName}:${extension.imageTag}" }
    val dockerContextDir = projectDir.resolve(extension.dockerContext)

    // Inputs: the prepared context (output of prepareDockerContext) + Dockerfile
    inputs.dir(dockerContextDir.resolve("package"))
    inputs.files(fileTree(dockerContextDir) {
        include("Dockerfile", "GradleDockerfile", "start.sh", ".npmrc")
    })

    // Docker image tag as output marker — use a stamp file since docker images aren't files
    val imageStamp = layout.buildDirectory.file("docker-image.stamp")
    outputs.file(imageStamp)

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

        // Prefer GradleDockerfile if present, fall back to Dockerfile
        val gradleDockerfile = dockerContextDir.resolve("GradleDockerfile")
        val dockerfileArgs = if (gradleDockerfile.exists()) {
            println("Using GradleDockerfile")
            listOf("-f", "GradleDockerfile")
        } else {
            println("Using default Dockerfile")
            emptyList()
        }

        val networkArgs = emptyList<String>()

        // Use ProcessBuilder with inheritIO for streaming output during build
        val fullCommand = listOf(
            "docker", "build",
            "--progress=plain",
            "-t", image,
            "--build-arg", "npm_token=${npmToken}",
            "--build-arg", "zb_token=${zbToken}"
        ) + networkArgs + dockerfileArgs + listOf(".")

        val dockerProcess = ProcessBuilder(fullCommand)
            .directory(dockerContextDir)
            .inheritIO()
            .start()
        val dockerExit = dockerProcess.waitFor()
        if (dockerExit != 0) {
            throw GradleException("Docker build failed (exit $dockerExit)")
        }

        // Write stamp file so Gradle can track up-to-date state
        imageStamp.get().asFile.apply {
            parentFile.mkdirs()
            writeText("$image built at ${java.time.Instant.now()}")
        }

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
