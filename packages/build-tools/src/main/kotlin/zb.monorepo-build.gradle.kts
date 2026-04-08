/**
 * Build orchestration plugin for zbb monorepos. Applied at the root project.
 *
 * Detection-based per-subproject task wiring:
 *
 *   1. **If a subproject has its own build.gradle.kts applying zb.typescript-service**
 *      (or any other plugin that registers `npmTranspile`/`dockerBuild`), the
 *      monorepo aggregator depends on those existing tasks. No duplicates
 *      registered. The subproject controls its own lifecycle.
 *
 *   2. **If a subproject is pure npm** (no build.gradle.kts), this plugin
 *      registers fallback Exec tasks (lint/generate/transpile/test) that run
 *      the corresponding npm script in the package dir. This is the common
 *      case for utility libraries that don't need docker images.
 *
 * Repos decide per-package: opt into the rich existing tooling by adding a
 * build.gradle.kts that applies zb.typescript-service, or rely on the
 * fallbacks for simple npm packages.
 *
 * Root aggregator tasks:
 *   - workspaceInstall: `npm install` at the repo root
 *   - monorepoClean: clean every workspace package
 *   - monorepoBuild: workspaceInstall + per-package build/transpile (all affected)
 *   - monorepoTest: monorepoBuild + per-package test (all affected)
 *
 * Docker concurrency cap: when multiple subprojects have `dockerBuild` tasks
 * (from zb.typescript-service), they're capped via the DockerSemaphore
 * BuildService (default 2, override via DOCKER_BUILD_CONCURRENCY env var).
 */

import com.zerobias.buildtools.monorepo.MonorepoGraphService
import com.zerobias.buildtools.monorepo.DockerSemaphore
import com.zerobias.buildtools.monorepo.RegistryInjectionService
import org.gradle.api.tasks.Exec

@Suppress("UNCHECKED_CAST")
val graphService = (project.extensions.extraProperties["monorepoGraphService"]
    as org.gradle.api.provider.Provider<MonorepoGraphService>)

// ── DockerSemaphore — caps concurrent docker builds across subprojects ──
val dockerConcurrency = (System.getenv("DOCKER_BUILD_CONCURRENCY")
    ?: project.findProperty("docker.concurrency") as? String
    ?: "2").toIntOrNull() ?: 2

val dockerSemaphore = gradle.sharedServices.registerIfAbsent(
    "dockerSemaphore",
    DockerSemaphore::class.java
) {
    parameters.maxConcurrent.set(dockerConcurrency)
    maxParallelUsages.set(dockerConcurrency)
}

// ── RegistryInjectionService — Verdaccio-aware npm install handling ──
//
// Detects whether the active zbb slot has a healthy local Verdaccio registry
// stack with locally-published packages. If so, applies registry injection
// (lockfile move, scoped registry env vars, taint, tarball download) before
// workspaceInstall and restores in a finalizedBy task.
//
// Fixes 3 bugs from the legacy Stack.ts injectRegistryNpmrc — see the
// RegistryInjectionService.kt class doc for details.

val registryInjection = gradle.sharedServices.registerIfAbsent(
    "registryInjection",
    RegistryInjectionService::class.java
) {
    parameters.repoRoot.set(rootProject.layout.projectDirectory)
}

// ── workspaceInstall — npm install at the repo root ─────────────────
//
// Wraps npm install with optional registry injection: if a slot is loaded
// with a healthy Verdaccio + locally-published packages, the inject step
// fires (move lockfile, set scoped registry env vars, taint, download
// tarballs). Restore runs in a finalizedBy task so the working tree is
// always cleaned up, even on failure.

val workspaceInstall = tasks.register<Exec>("workspaceInstall") {
    group = "monorepo"
    description = "Run `npm install` at the repo root (workspace install)"
    workingDir = rootProject.projectDir
    commandLine = listOf("npm", "install")
    inputs.file(rootProject.file("package.json"))
    if (rootProject.file("package-lock.json").exists()) {
        inputs.file(rootProject.file("package-lock.json"))
    }
    outputs.dir(rootProject.file("node_modules"))
        .withPropertyName("nodeModules")

    usesService(registryInjection)

    doFirst {
        val service = registryInjection.get()
        if (service.isActive) {
            val overrides = service.apply { msg -> logger.lifecycle(msg) }
            // Set scoped registry env vars on this Exec spec so npm sees them.
            // doFirst runs BEFORE the actual exec, and Exec.environment is read
            // at exec time — so this works.
            for ((k, v) in overrides) {
                environment[k] = v
            }
        }
    }

    // Without registry injection, skip when node_modules exists. With injection
    // (taint), force re-run.
    outputs.upToDateWhen {
        if (registryInjection.get().isActive) false
        else rootProject.file("node_modules").exists()
    }
}

// Restore task: always runs after workspaceInstall (success OR failure)
val workspaceInstallRestore = tasks.register("workspaceInstallRestore") {
    group = "monorepo"
    description = "Restore lockfile and clean tarballs after a registry-injected install"
    usesService(registryInjection)
    onlyIf { registryInjection.get().isActive }
    doLast {
        registryInjection.get().restore { msg -> logger.lifecycle(msg) }
    }
}
workspaceInstall.configure { finalizedBy(workspaceInstallRestore) }

// ── Root aggregator tasks (registered now, deps wired below) ────────

val monorepoBuild = tasks.register("monorepoBuild") {
    group = "monorepo"
    description = "Build all affected workspace packages (lint + generate + transpile)"
    dependsOn(workspaceInstall)
}

val monorepoTest = tasks.register("monorepoTest") {
    group = "monorepo"
    description = "Run tests for all affected workspace packages"
    dependsOn(monorepoBuild)
}

tasks.register("monorepoClean") {
    group = "monorepo"
    description = "Clean all workspace packages (dist/, generated/, build/, tsbuildinfo)"
    doLast {
        val service = graphService.get()
        var cleaned = 0
        for ((_, pkg) in service.graph.packages) {
            for (sub in listOf("dist", "generated", "build")) {
                val target = pkg.dir.resolve(sub)
                if (target.exists()) {
                    target.deleteRecursively()
                    cleaned += 1
                }
            }
            val tsBuildInfo = pkg.dir.resolve("tsconfig.tsbuildinfo")
            if (tsBuildInfo.exists()) {
                tsBuildInfo.delete()
                cleaned += 1
            }
        }
        logger.lifecycle("monorepoClean: removed $cleaned artifacts across ${service.graph.packages.size} packages")
    }
}

// ── Per-subproject task wiring ──────────────────────────────────────
//
// Detection: if a subproject already has its own tasks (typically from
// applying zb.typescript-service in a per-package build.gradle.kts), use
// those. Otherwise register fallback Exec tasks that run npm scripts.
//
// Detection signal: presence of `npmTranspile` task → existing infrastructure
// is in use. zb.typescript-service registers npmInstall, npmGenerate, npmLint,
// npmTranspile, npmBuild, npmPack, prepareDockerContext, injectLocalDeps,
// dockerBuild — and names `tasks.named("build") { dependsOn(npmBuild, dockerBuild) }`.
// We just depend on those.

/**
 * Returns true if this subproject already exposes its own build tasks
 * (via zb.typescript-service or similar), in which case we should NOT
 * register fallback Exec tasks.
 */
fun hasExistingBuildInfra(subproject: org.gradle.api.Project): Boolean {
    return subproject.tasks.findByName("npmTranspile") != null
}

gradle.projectsEvaluated {
    val service = graphService.get()
    val packages = service.graph.packages
    val phases = service.config.buildPhases  // ["lint", "generate", "transpile"] by default
    val testPhases = service.config.testPhases  // ["test"] by default

    // 1. Register fallback Exec tasks for subprojects that DON'T have their
    //    own build infrastructure. Subprojects with zb.typescript-service
    //    keep their existing npm* / dockerBuild tasks untouched.
    //
    //    Each fallback task declares inputs (source files) and outputs (a
    //    stamp file written in doLast) so Gradle can skip up-to-date tasks
    //    on subsequent runs. Without this, every `zbb build` re-runs every
    //    npm script even when nothing changed.
    for ((pkgName, pkg) in packages) {
        val gradlePath = ":" + pkg.relDir.replace("/", ":")
        val subproject = rootProject.findProject(gradlePath) ?: continue
        if (hasExistingBuildInfra(subproject)) continue  // defer to existing tasks

        // Common input PATHS (always declared, regardless of existence at
        // configuration time). Using project.fileTree() with optional means
        // missing paths don't change the input set between runs — Gradle's
        // up-to-date logic stays stable.
        val srcDir = pkg.dir.resolve("src")
        val packageJson = pkg.dir.resolve("package.json")
        val tsconfigJson = pkg.dir.resolve("tsconfig.json")
        val apiYml = pkg.dir.resolve("api.yml")
        val generatedDir = pkg.dir.resolve("generated")

        // FileTree wrappers handle missing-dir cases (empty tree). For
        // single FILES, Gradle's input validation requires them to exist
        // even with .optional(), so we only declare them if they're present.
        fun fileTreeOf(dir: java.io.File) = subproject.fileTree(dir).matching { include("**/*") }

        for (phase in phases) {
            val scriptBody = pkg.scripts[phase]
            if (scriptBody.isNullOrBlank() || scriptBody.trimStart().startsWith("echo ")) {
                continue
            }
            val stampFile = pkg.dir.resolve("build/${phase}.stamp")
            subproject.tasks.register<Exec>(phase) {
                group = "monorepo"
                description = "Run `npm run $phase` for $pkgName"
                workingDir = pkg.dir
                commandLine = listOf("npm", "run", phase)
                dependsOn(workspaceInstall)

                // Directory inputs (always declared — empty FileTree if missing)
                inputs.files(fileTreeOf(srcDir)).withPropertyName("srcFiles")
                // generated/ is only an input for transpile/test (the consumers
                // of generated code). lint scans src/ only and would otherwise
                // be invalidated whenever generate produces new output, since
                // lint runs BEFORE generate in our canonical order.
                if (phase == "transpile") {
                    inputs.files(fileTreeOf(generatedDir)).withPropertyName("generatedFiles")
                }

                // Single-file inputs — only declare if the file exists today.
                // (Gradle's input validation rejects optional missing files.)
                if (packageJson.exists()) inputs.file(packageJson).withPropertyName("packageJson")
                if (tsconfigJson.exists()) inputs.file(tsconfigJson).withPropertyName("tsconfigJson")
                if (apiYml.exists()) inputs.file(apiYml).withPropertyName("apiYml")

                // Phase-specific outputs (the actual artifacts npm produces)
                when (phase) {
                    "generate" -> outputs.dir(generatedDir).withPropertyName("generatedOut")
                    "transpile" -> outputs.dir(pkg.dir.resolve("dist")).withPropertyName("distOut")
                }
                // Always write a stamp file in build/ so Gradle has a stable
                // output marker even when the npm script produces nothing
                // (e.g. lint).
                outputs.file(stampFile).withPropertyName("phaseStamp")

                doLast {
                    stampFile.parentFile.mkdirs()
                    stampFile.writeText("$phase completed at ${java.time.Instant.now()}\n")
                }
            }
        }

        for (testPhase in testPhases) {
            val scriptBody = pkg.scripts[testPhase]
            if (scriptBody.isNullOrBlank() || scriptBody.trimStart().startsWith("echo ")) {
                continue
            }
            val stampFile = pkg.dir.resolve("build/${testPhase}.stamp")
            val testDir = pkg.dir.resolve("test")
            subproject.tasks.register<Exec>(testPhase) {
                group = "monorepo"
                description = "Run `npm run $testPhase` for $pkgName"
                workingDir = pkg.dir
                commandLine = listOf("npm", "run", testPhase)
                dependsOn(workspaceInstall)

                inputs.files(fileTreeOf(srcDir)).withPropertyName("srcFiles")
                inputs.files(fileTreeOf(testDir)).withPropertyName("testFiles")
                inputs.files(fileTreeOf(generatedDir)).withPropertyName("generatedFiles")
                if (packageJson.exists()) inputs.file(packageJson).withPropertyName("packageJson")
                if (tsconfigJson.exists()) inputs.file(tsconfigJson).withPropertyName("tsconfigJson")

                outputs.file(stampFile).withPropertyName("phaseStamp")

                doLast {
                    stampFile.parentFile.mkdirs()
                    stampFile.writeText("$testPhase completed at ${java.time.Instant.now()}\n")
                }
            }
        }
    }

    // 2. Wire per-package dependsOn across subprojects based on the npm dep graph.
    //    Lint is parallel-safe (doesn't depend on other packages' build outputs).
    //    For subprojects with existing infrastructure, wire npmTranspile/npmGenerate
    //    instead of our fallback names.
    val crossProjectPhases = phases.filter { it != "lint" } + testPhases
    for ((_, pkg) in packages) {
        val gradlePath = ":" + pkg.relDir.replace("/", ":")
        val subproject = rootProject.findProject(gradlePath) ?: continue
        val usesExisting = hasExistingBuildInfra(subproject)

        for (phase in crossProjectPhases) {
            val taskName = if (usesExisting) phaseToExistingName(phase) else phase
            val task = subproject.tasks.findByName(taskName) ?: continue
            for (depName in pkg.internalDeps) {
                val depPath = service.packageNameToGradlePath[depName] ?: continue
                val depProject = rootProject.findProject(depPath) ?: continue
                val depUsesExisting = hasExistingBuildInfra(depProject)
                val depTaskName = if (depUsesExisting) phaseToExistingName(phase) else phase
                val depTask = depProject.tasks.findByName(depTaskName) ?: continue
                task.dependsOn(depTask)
            }
        }
    }

    // 3. Cross-phase ordering within a subproject (fallback Exec only).
    //    Canonical order: lint → generate → transpile → test
    //    Use mustRunAfter (not dependsOn) so requesting just one phase
    //    doesn't pull in the earlier ones.
    for ((_, pkg) in packages) {
        val gradlePath = ":" + pkg.relDir.replace("/", ":")
        val subproject = rootProject.findProject(gradlePath) ?: continue
        if (hasExistingBuildInfra(subproject)) continue

        val lint = subproject.tasks.findByName("lint")
        val generate = subproject.tasks.findByName("generate")
        val transpile = subproject.tasks.findByName("transpile")
        val test = subproject.tasks.findByName("test")

        if (lint != null && generate != null) generate.mustRunAfter(lint)
        if (transpile != null) {
            lint?.let { transpile.mustRunAfter(it) }
            generate?.let { transpile.mustRunAfter(it) }
        }
        if (test != null && transpile != null) test.mustRunAfter(transpile)
    }

    // 4. Wrap dockerBuild tasks (from zb.typescript-service) with the
    //    DockerSemaphore so concurrent docker builds are capped.
    for ((_, pkg) in packages) {
        val gradlePath = ":" + pkg.relDir.replace("/", ":")
        val subproject = rootProject.findProject(gradlePath) ?: continue
        val dockerBuild = subproject.tasks.findByName("dockerBuild") ?: continue
        dockerBuild.usesService(dockerSemaphore)
    }

    // 5. Wire monorepoBuild and monorepoTest to depend on the affected subprojects.
    //    For subprojects with existing infrastructure, depend on `build`
    //    (which zb.typescript-service wires to npmBuild + dockerBuild). For
    //    fallback subprojects, depend on each fallback phase task.
    val affected = service.changeResult.affected
    monorepoBuild.configure {
        for (pkgName in affected) {
            val gradlePath = service.packageNameToGradlePath[pkgName] ?: continue
            val subproject = rootProject.findProject(gradlePath) ?: continue
            if (hasExistingBuildInfra(subproject)) {
                // zb.typescript-service exposes `build` as the aggregator
                subproject.tasks.findByName("build")?.let { dependsOn(it) }
            } else {
                for (phase in phases) {
                    subproject.tasks.findByName(phase)?.let { dependsOn(it) }
                }
            }
        }
    }
    monorepoTest.configure {
        for (pkgName in affected) {
            val gradlePath = service.packageNameToGradlePath[pkgName] ?: continue
            val subproject = rootProject.findProject(gradlePath) ?: continue
            // Test runs the npm `test` script (zb.typescript-service doesn't
            // provide a test task, so we always use the Exec we register
            // OR fall through if the subproject defines one some other way).
            for (testPhase in testPhases) {
                subproject.tasks.findByName(testPhase)?.let { dependsOn(it) }
            }
        }
    }
}

/**
 * Map a generic phase name to its zb.typescript-service equivalent.
 *   "lint"      → "npmLint"
 *   "generate"  → "npmGenerate"
 *   "transpile" → "npmTranspile"
 *   anything else → unchanged
 */
fun phaseToExistingName(phase: String): String = when (phase) {
    "lint" -> "npmLint"
    "generate" -> "npmGenerate"
    "transpile" -> "npmTranspile"
    else -> phase
}
