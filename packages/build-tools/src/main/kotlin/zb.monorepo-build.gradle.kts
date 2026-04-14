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
import com.zerobias.buildtools.monorepo.PrepublishLockService
import com.zerobias.buildtools.monorepo.RegistryInjectionService
import com.zerobias.buildtools.monorepo.SubstackDockerConfig
import com.zerobias.buildtools.util.ExecUtils
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

// ── PrepublishLockService — serializes prepublish-standalone across pkgs ──
//
// `prepublish-standalone.sh` mutates package.json in place. Two npmPack tasks
// running concurrently in different subprojects would race on each other's
// reads/writes, so npmPack acquires this max-1 lock for the brief
// "backup → prepublish → npm pack → restore" window. Other parts of the
// dockerBuild pipeline (context prep, docker build) run concurrently.

val prepublishLock = gradle.sharedServices.registerIfAbsent(
    "prepublishLock",
    PrepublishLockService::class.java
) {}

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

// monorepoDockerBuild is intentionally separate from monorepoBuild — `zbb build`
// stays fast and doesn't fork docker. `zbb dockerBuild` runs this directly,
// and `monorepoGate` adds it to the gate chain so CI gets a clean image stamp.
val monorepoDockerBuild = tasks.register("monorepoDockerBuild") {
    group = "monorepo"
    description = "Build Docker images for all affected dockerized workspace packages"
    dependsOn(monorepoBuild)
}

tasks.register("monorepoClean") {
    group = "monorepo"
    description = "Clean all workspace packages — delegates to `npm run clean` per package when defined; otherwise falls back to deleting dist/, generated/, build/, tsconfig.tsbuildinfo."
    doLast {
        val service = graphService.get()
        var npmCleaned = 0
        var hardCleaned = 0
        var failed = 0

        for ((pkgName, pkg) in service.graph.packages) {
            val cleanScript = pkg.scripts["clean"]

            if (!cleanScript.isNullOrBlank()) {
                // Delegate to the package's own clean script. This is the
                // source of truth — it's what the package author intends,
                // and it covers package-specific artifacts the hardcoded
                // fallback below would miss (api.yml, .docs/, tmp/, etc).
                try {
                    ExecUtils.exec(
                        command = listOf("npm", "run", "clean"),
                        workingDir = pkg.dir,
                        throwOnError = true,
                    )
                    npmCleaned += 1
                } catch (e: Exception) {
                    logger.warn("monorepoClean: $pkgName `npm run clean` failed: ${e.message}")
                    failed += 1
                }
                continue
            }

            // Fallback for packages with no clean script: best-effort
            // removal of the standard build output directories.
            var any = false
            for (sub in listOf("dist", "generated", "build")) {
                val target = pkg.dir.resolve(sub)
                if (target.exists()) {
                    target.deleteRecursively()
                    any = true
                }
            }
            val tsBuildInfo = pkg.dir.resolve("tsconfig.tsbuildinfo")
            if (tsBuildInfo.exists()) {
                tsBuildInfo.delete()
                any = true
            }
            if (any) hardCleaned += 1
        }

        val total = service.graph.packages.size
        logger.lifecycle(
            "monorepoClean: $npmCleaned via npm script, $hardCleaned via fallback, $failed failed (total $total packages)"
        )
    }
}

// ── Per-subproject task wiring ──────────────────────────────────────
//
// All TypeScript packages are handled by the auto-registered fallback Exec
// tasks below — there's no longer a separate per-package convention plugin.
// The Docker pipeline (npmPack/prepareDockerContext/injectLocalDeps/
// dockerBuild) is registered for any package whose substack declares a
// `docker:` block in zbb.yaml.
//
// Subprojects that already apply a JVM language plugin (java/kotlin/groovy)
// are skipped — their existing `test`/`compileJava`/etc. tasks would collide
// with our `register<Exec>("test")` fallback. This is the codegen path.

/**
 * Returns true if this subproject already exposes its own build tasks
 * that would collide with the npm-script Exec tasks we'd otherwise
 * register. Currently this means a JVM language plugin is applied:
 * the `test` task from java/kotlin/groovy plugins would clash with our
 * `register<Exec>("test")`. Marker: presence of `compileJava` or
 * `compileKotlin` (proves the plugin was applied; we can't just
 * check for `test` because the rootProject `id("base")` plugin
 * gives every subproject a `build`/`assemble`/`check`/`clean`
 * task but NOT a `test` task — only language plugins do).
 *
 * NOTE: do NOT broaden this check to include base-plugin task names
 * like `build`, `clean`, `assemble`, or `check`. They are present on
 * every subproject when the root applies `id("base")` and would cause
 * us to incorrectly skip ALL subprojects.
 */
fun hasExistingBuildInfra(subproject: org.gradle.api.Project): Boolean {
    if (subproject.tasks.findByName("compileJava") != null) return true
    if (subproject.tasks.findByName("compileKotlin") != null) return true
    if (subproject.tasks.findByName("compileGroovy") != null) return true
    return false
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
            // Empty/echo script: register a no-op task instead of skipping
            // registration entirely. Same reasoning as the testPhase loop
            // below — keeps the display showing "passed" for these phases
            // rather than making them invisible.
            val isNoOp =
                scriptBody.isNullOrBlank() ||
                scriptBody.trimStart().startsWith("echo ")
            val stampFile = pkg.dir.resolve("build/${phase}.stamp")
            if (isNoOp) {
                subproject.tasks.register(phase) {
                    group = "monorepo"
                    description = "No-op `$phase` for $pkgName (script empty)"
                    dependsOn(workspaceInstall)
                    inputs.files(fileTreeOf(srcDir)).withPropertyName("srcFiles")
                    if (packageJson.exists()) inputs.file(packageJson).withPropertyName("packageJson")
                    outputs.file(stampFile).withPropertyName("phaseStamp")
                    doLast {
                        stampFile.parentFile.mkdirs()
                        stampFile.writeText("$phase no-op (script empty) at ${java.time.Instant.now()}\n")
                    }
                }
                continue
            }
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
            // Empty / echo / missing script: still register a no-op task that
            // shows up as "passed" in the display. Skipping registration
            // entirely (the old behavior) hid these from the TUI and made it
            // look like the package wasn't being tested at all. The no-op
            // task satisfies gradle's task graph, runs in milliseconds, and
            // the OperationCompletionListener emits a normal task_done
            // event so the display row gets a check mark.
            val isNoOp =
                scriptBody.isNullOrBlank() ||
                scriptBody.trimStart().startsWith("echo ")
            val stampFile = pkg.dir.resolve("build/${testPhase}.stamp")
            val testDir = pkg.dir.resolve("test")
            if (isNoOp) {
                subproject.tasks.register(testPhase) {
                    group = "monorepo"
                    description = "No-op `$testPhase` for $pkgName (script empty)"
                    dependsOn(workspaceInstall)
                    inputs.files(fileTreeOf(srcDir)).withPropertyName("srcFiles")
                    inputs.files(fileTreeOf(testDir)).withPropertyName("testFiles")
                    if (packageJson.exists()) inputs.file(packageJson).withPropertyName("packageJson")
                    outputs.file(stampFile).withPropertyName("phaseStamp")
                    doLast {
                        stampFile.parentFile.mkdirs()
                        stampFile.writeText("$testPhase no-op (script empty) at ${java.time.Instant.now()}\n")
                    }
                }
                continue
            }
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
    //
    //    For JVM-style deps (hasExistingBuildInfra == true, e.g. `codegen`),
    //    the dep project has no phase tasks — it has a `build` task. Wire
    //    the consumer's phase task against that `build` task so consumers
    //    transitively trigger the full JVM build (including any Copy tasks
    //    like stageBinJars that stage runtime artifacts into bin/).
    val crossProjectPhases = phases.filter { it != "lint" } + testPhases
    for ((_, pkg) in packages) {
        val gradlePath = ":" + pkg.relDir.replace("/", ":")
        val subproject = rootProject.findProject(gradlePath) ?: continue

        for (phase in crossProjectPhases) {
            val task = subproject.tasks.findByName(phase) ?: continue
            for (depName in pkg.internalDeps) {
                val depPath = service.packageNameToGradlePath[depName] ?: continue
                val depProject = rootProject.findProject(depPath) ?: continue
                val depTask = if (hasExistingBuildInfra(depProject)) {
                    depProject.tasks.findByName("build")
                } else {
                    depProject.tasks.findByName(phase)
                } ?: continue
                task.dependsOn(depTask)
            }
        }
    }

    // 3. Cross-phase ordering within a subproject (fallback Exec only).
    //
    // Honors the `monorepo.buildPhases` order from zbb.yaml — each phase
    // depends on the previous one in the configured list. Then every
    // testPhase depends on the LAST build phase. Fail-fast via `dependsOn`:
    // a failure in an earlier phase kills downstream phases immediately.
    //
    // This used to hardcode the chain as `lint → generate → transpile → test`,
    // which silently dropped any phase name not in that exact set (e.g. a
    // package that uses `compile` instead of `transpile`). Symptom: the
    // unlisted phase had no upstream dep, ran first, failed because its
    // inputs hadn't been generated yet. Honor the config instead.
    for ((_, pkg) in packages) {
        val gradlePath = ":" + pkg.relDir.replace("/", ":")
        val subproject = rootProject.findProject(gradlePath) ?: continue
        if (hasExistingBuildInfra(subproject)) continue

        // Walk phases in declared order, wiring each to the previous.
        var prevTask: org.gradle.api.Task? = null
        for (phaseName in phases) {
            val task = subproject.tasks.findByName(phaseName) ?: continue
            if (prevTask != null) {
                task.dependsOn(prevTask)
            }
            prevTask = task
        }

        // Test phases depend on the last build phase that exists for this
        // package. Without this a `:pkg:test` could run before `:pkg:transpile`
        // (or whatever the last build phase is).
        for (testPhaseName in testPhases) {
            val testTask = subproject.tasks.findByName(testPhaseName) ?: continue
            if (prevTask != null) {
                testTask.dependsOn(prevTask)
            }
        }
    }

    // 4. Register Docker build tasks for subprojects whose short-name appears
    //    in the dockerized map (from zbb.yaml `substacks.<name>.docker:`).
    //    Per-subproject tasks: npmPack → prepareDockerContext → injectLocalDeps → dockerBuild.
    //
    //    Each chain is gated by:
    //      - prepublishLock (max 1 across the build) for the npmPack window
    //      - dockerSemaphore (max DOCKER_BUILD_CONCURRENCY) for the docker build window
    //
    //    Inputs/outputs declare stamps so Gradle can skip up-to-date docker
    //    builds when nothing changed.
    val dockerized = service.dockerizedPackages
    for ((_, pkg) in packages) {
        val gradlePath = ":" + pkg.relDir.replace("/", ":")
        val subproject = rootProject.findProject(gradlePath) ?: continue
        if (hasExistingBuildInfra(subproject)) continue

        // Lookup by package short-name (last segment of relDir). Hydra:
        //   pkg.relDir = "app" → shortName = "app"
        // matched against substacks.<name>.docker.package = "app".
        val shortName = pkg.relDir.substringAfterLast("/")
        val dockerCfg: SubstackDockerConfig = dockerized[shortName] ?: continue

        registerDockerTasksForPackage(
            subproject = subproject,
            pkg = pkg,
            packages = packages,
            dockerCfg = dockerCfg,
            repoRoot = rootProject.projectDir,
            workspaceInstall = workspaceInstall,
            prepublishLock = prepublishLock,
            dockerSemaphore = dockerSemaphore,
        )
    }

    // 5. Wire monorepoBuild and monorepoTest to depend on the affected subprojects.
    //    Subprojects with a JVM language plugin (codegen) expose `build` as
    //    the aggregator; pure-npm subprojects use the per-phase fallback tasks
    //    we registered above.
    val affected = service.changeResult.affected
    monorepoBuild.configure {
        for (pkgName in affected) {
            val gradlePath = service.packageNameToGradlePath[pkgName] ?: continue
            val subproject = rootProject.findProject(gradlePath) ?: continue
            if (hasExistingBuildInfra(subproject)) {
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
            for (testPhase in testPhases) {
                subproject.tasks.findByName(testPhase)?.let { dependsOn(it) }
            }
        }
    }

    // monorepoDockerBuild depends only on dockerBuild tasks for affected
    // subprojects whose short-name is in the dockerized map. Non-dockerized
    // packages contribute nothing — the aggregator is a no-op for them.
    monorepoDockerBuild.configure {
        for (pkgName in affected) {
            val gradlePath = service.packageNameToGradlePath[pkgName] ?: continue
            val subproject = rootProject.findProject(gradlePath) ?: continue
            subproject.tasks.findByName("dockerBuild")?.let { dependsOn(it) }
        }
    }
}

/**
 * Register the per-package Docker pipeline (npmPack → prepareDockerContext →
 * injectLocalDeps → dockerBuild) for a workspace package whose substack
 * declares a `docker:` block in zbb.yaml.
 *
 * Ports the previously zb.typescript-service-only Docker logic into Path A
 * so packages no longer need a per-subproject build.gradle.kts to ship a
 * Docker image — the substack manifest is the source of truth.
 *
 * Layout assumptions (matching legacy behavior):
 *   - npm pack runs in the package dir (`pkg.dir`).
 *   - prepublish-standalone.sh lives at `repoRoot/node_modules/@zerobias-org/devops-tools/scripts/prepublish-standalone.sh`.
 *   - The docker context dir is `repoRoot/<dockerCfg.context>`.
 *   - Internal workspace deps are auto-bundled from the workspace graph
 *     (no per-package config needed) — replaces the legacy
 *     `extension.workspaceDeps` map.
 *
 * Each task declares a stamp file output so Gradle's up-to-date check works.
 */
fun registerDockerTasksForPackage(
    subproject: org.gradle.api.Project,
    pkg: com.zerobias.buildtools.monorepo.WorkspacePackage,
    packages: Map<String, com.zerobias.buildtools.monorepo.WorkspacePackage>,
    dockerCfg: SubstackDockerConfig,
    repoRoot: java.io.File,
    workspaceInstall: org.gradle.api.tasks.TaskProvider<Exec>,
    prepublishLock: org.gradle.api.provider.Provider<PrepublishLockService>,
    dockerSemaphore: org.gradle.api.provider.Provider<DockerSemaphore>,
) {
    val pkgDir = pkg.dir
    val dockerContextDir = repoRoot.resolve(dockerCfg.context)
    val packageDir = dockerContextDir.resolve("package")
    val imageTag = "${dockerCfg.image}:dev"

    // Internal deps that need to be bundled into the Docker image as
    // file:local_deps/*.tgz references. Resolved automatically from the
    // workspace dep graph rather than a hand-maintained map.
    val internalDepDirs: List<java.io.File> = pkg.internalDeps
        .mapNotNull { depName -> packages[depName]?.dir }

    // ── npmPack ────────────────────────────────────────────────────────
    val npmPack = subproject.tasks.register("npmPack") {
        group = "docker"
        description = "Run prepublish-standalone and npm pack for ${pkg.name}"
        dependsOn(workspaceInstall)
        // Ensure transpile has run so dist/ is fresh inside the tarball.
        subproject.tasks.findByName("transpile")?.let { dependsOn(it) }
        usesService(prepublishLock)

        inputs.files(subproject.fileTree(pkgDir.resolve("src")).matching { include("**/*") })
            .withPropertyName("srcFiles")
        inputs.files(subproject.fileTree(pkgDir.resolve("generated")).matching { include("**/*") })
            .withPropertyName("generatedFiles")
        inputs.files(subproject.fileTree(pkgDir.resolve("dist")).matching { include("**/*") })
            .withPropertyName("distFiles")
        if (pkgDir.resolve("package.json").exists()) {
            inputs.file(pkgDir.resolve("package.json")).withPropertyName("packageJson")
        }

        val packStamp = subproject.layout.buildDirectory.file("npm-pack.stamp")
        outputs.file(packStamp)

        doFirst {
            // Clean any leftover tarballs in the docker context dir
            dockerContextDir.listFiles { f -> f.name.endsWith(".tgz") }?.forEach { it.delete() }

            val packageJson = pkgDir.resolve("package.json")
            val packageJsonBackup = pkgDir.resolve("package.json.gradle-bak")
            val prepublishScript = repoRoot.resolve("node_modules/@zerobias-org/devops-tools/scripts/prepublish-standalone.sh")

            try {
                if (prepublishScript.exists()) {
                    // Back up package.json preserving timestamps so Gradle caching
                    // isn't invalidated by the prepublish in-place mutation.
                    ExecUtils.exec(
                        command = listOf("cp", "-a", packageJson.absolutePath, packageJsonBackup.absolutePath),
                        workingDir = pkgDir
                    )
                    println("Running prepublish-standalone for ${pkg.name}...")
                    ExecUtils.exec(
                        command = listOf("bash", prepublishScript.absolutePath),
                        workingDir = pkgDir
                    )
                } else {
                    println("WARNING: prepublish-standalone.sh not found at ${prepublishScript.absolutePath} — Docker image may be missing dependencies")
                }

                println("Running npm pack for ${pkg.name}...")
                dockerContextDir.mkdirs()
                ExecUtils.exec(
                    command = listOf("npm", "pack", "--pack-destination", dockerContextDir.absolutePath),
                    workingDir = pkgDir
                )
            } finally {
                // Always restore the original package.json with preserved timestamps
                if (packageJsonBackup.exists()) {
                    ExecUtils.exec(
                        command = listOf("mv", packageJsonBackup.absolutePath, packageJson.absolutePath),
                        workingDir = pkgDir
                    )
                }
                // The bash prepublish-standalone.sh script also creates its
                // own internal `package.json.prepublish-backup`. Once we've
                // restored from our `.gradle-bak`, the package.json is
                // guaranteed to be in its original state, so the bash
                // script's backup is stale and safe to remove.
                val prepublishBackup = pkgDir.resolve("package.json.prepublish-backup")
                if (prepublishBackup.exists()) {
                    prepublishBackup.delete()
                }
            }

            packStamp.get().asFile.apply {
                parentFile.mkdirs()
                writeText("packed at ${java.time.Instant.now()}")
            }
        }
    }

    // ── prepareDockerContext ───────────────────────────────────────────
    val prepareDockerContext = subproject.tasks.register("prepareDockerContext") {
        group = "docker"
        description = "Extract npm pack tarball into Docker build context for ${pkg.name}"
        dependsOn(npmPack)

        inputs.file(subproject.layout.buildDirectory.file("npm-pack.stamp"))
        outputs.dir(packageDir)

        doFirst {
            // Clean previous context and stale lockfile
            packageDir.deleteRecursively()
            dockerContextDir.resolve("package-lock.json").delete()

            val tarball = dockerContextDir.listFiles { f -> f.name.endsWith(".tgz") }?.firstOrNull()
                ?: throw GradleException("No tarball found in ${dockerContextDir.absolutePath} — npmPack may have failed")

            println("Extracting ${tarball.name}...")
            ExecUtils.exec(
                command = listOf("tar", "-xzf", tarball.name),
                workingDir = dockerContextDir
            )
            tarball.delete()

            // Bundle internal workspace deps into the docker context as
            // file:local_deps/*.tgz references. Auto-detected from the
            // workspace graph (replaces the legacy hand-maintained
            // typescript-service `workspaceDeps` map).
            if (internalDepDirs.isNotEmpty()) {
                val localDepsDir = packageDir.resolve("local_deps")
                localDepsDir.mkdirs()

                val packageJsonFile = packageDir.resolve("package.json")
                var packageJsonText = packageJsonFile.readText()

                for (wsProjectDir in internalDepDirs) {
                    val wsPackageJson = wsProjectDir.resolve("package.json")
                    if (!wsPackageJson.exists()) continue

                    val wsPackageJsonObj = groovy.json.JsonSlurper().parseText(wsPackageJson.readText()) as Map<*, *>
                    val wsName = wsPackageJsonObj["name"] as? String ?: continue
                    val wsVersion = wsPackageJsonObj["version"] as? String ?: continue

                    // Only bundle if this is actually a dependency in the packed package.json
                    if (!packageJsonText.contains("\"$wsName\"")) continue

                    val wsPrepublishScript = repoRoot.resolve("node_modules/@zerobias-org/devops-tools/scripts/prepublish-standalone.sh")
                    val wsPackageJsonBackup = wsProjectDir.resolve("package.json.gradle-bak")

                    if (wsPrepublishScript.exists()) {
                        ExecUtils.exec(
                            command = listOf("cp", "-a", wsPackageJson.absolutePath, wsPackageJsonBackup.absolutePath),
                            workingDir = wsProjectDir
                        )
                        try {
                            ExecUtils.exec(
                                command = listOf("bash", wsPrepublishScript.absolutePath, repoRoot.absolutePath, "--library"),
                                workingDir = wsProjectDir
                            )
                        } catch (e: Exception) {
                            if (wsPackageJsonBackup.exists()) {
                                ExecUtils.exec(
                                    command = listOf("mv", wsPackageJsonBackup.absolutePath, wsPackageJson.absolutePath),
                                    workingDir = wsProjectDir
                                )
                            }
                            println("  ⚠ prepublish-standalone failed for $wsName, using as-is")
                        }
                    }

                    println("Packing local workspace dep: $wsName")
                    try {
                        ExecUtils.exec(
                            command = listOf("npm", "pack", "--pack-destination", localDepsDir.absolutePath),
                            workingDir = wsProjectDir
                        )
                    } finally {
                        if (wsPackageJsonBackup.exists()) {
                            ExecUtils.exec(
                                command = listOf("mv", wsPackageJsonBackup.absolutePath, wsPackageJson.absolutePath),
                                workingDir = wsProjectDir
                            )
                        }
                        // Clean up the bash script's own .prepublish-backup
                        // (see npmPack finally above for full reasoning).
                        val wsPrepublishBackup = wsProjectDir.resolve("package.json.prepublish-backup")
                        if (wsPrepublishBackup.exists()) {
                            wsPrepublishBackup.delete()
                        }
                    }

                    val wsTarball = localDepsDir.listFiles { f ->
                        f.name.endsWith(".tgz") && !f.name.startsWith(".")
                    }?.sortedByDescending { it.lastModified() }?.firstOrNull()

                    if (wsTarball != null) {
                        packageJsonText = packageJsonText.replace(
                            "\"$wsName\": \"$wsVersion\"",
                            "\"$wsName\": \"file:./local_deps/${wsTarball.name}\""
                        )
                        println("  ✓ Bundled $wsName → local_deps/${wsTarball.name}")
                    }
                }

                packageJsonFile.writeText(packageJsonText)
            }

            println("✓ Docker context prepared at: $packageDir")
        }
    }

    // ── injectLocalDeps ────────────────────────────────────────────────
    val injectLocalDeps = subproject.tasks.register("injectLocalDeps") {
        group = "docker"
        description = "Inject locally-published zbb registry packages into Docker context for ${pkg.name}"
        dependsOn(prepareDockerContext)

        doFirst {
            // Read from file written by zbb (env vars don't reach the Gradle daemon)
            val localDepsFile = repoRoot.resolve(".zbb-local-deps/manifest.json")
            if (!localDepsFile.exists()) return@doFirst
            val localDepsJson = localDepsFile.readText()
            if (localDepsJson.isBlank()) return@doFirst

            @Suppress("UNCHECKED_CAST")
            val deps = (groovy.json.JsonSlurper().parseText(localDepsJson) as? List<Map<String, String>>) ?: return@doFirst
            if (deps.isEmpty()) return@doFirst

            val localDepsDir = packageDir.resolve("local_deps")
            localDepsDir.mkdirs()

            val packageJsonFile = packageDir.resolve("package.json")
            @Suppress("UNCHECKED_CAST")
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

    // ── dockerBuild ────────────────────────────────────────────────────
    subproject.tasks.register("dockerBuild") {
        group = "docker"
        description = "Build Docker image $imageTag for ${pkg.name}"
        dependsOn(injectLocalDeps)
        usesService(dockerSemaphore)

        // Inputs: the prepared context (output of prepareDockerContext) +
        // the Dockerfile / start.sh / .npmrc next to it.
        inputs.dir(packageDir)
        inputs.files(subproject.fileTree(dockerContextDir) {
            include("Dockerfile", "GradleDockerfile", "start.sh", ".npmrc")
        })

        val imageStamp = subproject.layout.buildDirectory.file("docker-image.stamp")
        outputs.file(imageStamp)

        doFirst {
            println("Building Docker image: $imageTag")
            println("Context: $dockerContextDir")

            val npmToken = System.getenv("NPM_TOKEN") ?: ""
            val zbToken = System.getenv("ZB_TOKEN") ?: ""
            if (npmToken.isEmpty() || zbToken.isEmpty()) {
                println("WARNING: NPM_TOKEN or ZB_TOKEN not set - Docker build may fail")
            }

            val gradleDockerfile = dockerContextDir.resolve("GradleDockerfile")
            val dockerfileArgs = if (gradleDockerfile.exists()) {
                println("Using GradleDockerfile")
                listOf("-f", "GradleDockerfile")
            } else {
                println("Using default Dockerfile")
                emptyList()
            }

            val fullCommand = listOf(
                "docker", "build",
                "--progress=plain",
                "-t", imageTag,
                "--build-arg", "npm_token=${npmToken}",
                "--build-arg", "zb_token=${zbToken}"
            ) + dockerfileArgs + listOf(".")

            val dockerProcess = ProcessBuilder(fullCommand)
                .directory(dockerContextDir)
                .inheritIO()
                .start()
            val dockerExit = dockerProcess.waitFor()
            if (dockerExit != 0) {
                throw GradleException("Docker build failed (exit $dockerExit)")
            }

            imageStamp.get().asFile.apply {
                parentFile.mkdirs()
                writeText("$imageTag built at ${java.time.Instant.now()}")
            }

            println("✓ Docker image built: $imageTag")
        }
    }
}
