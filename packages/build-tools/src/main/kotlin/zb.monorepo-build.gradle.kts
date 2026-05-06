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
import com.zerobias.buildtools.util.PathConstants.ZBB_GRADLE_DIR
import org.gradle.api.tasks.Exec

@Suppress("UNCHECKED_CAST")
val graphService = (project.extensions.extraProperties["monorepoGraphService"]
    as org.gradle.api.provider.Provider<MonorepoGraphService>)

// ── DockerSemaphore — caps concurrent docker builds across subprojects ──
//
// Default is 1 (serialize) for two reasons:
//
//   1. Two parallel `docker build` invocations against the same daemon
//      contend on metadata locks, making the "transferring dockerfile"
//      / "load build context" / WORKDIR / COPY metadata steps take 30-
//      100x longer than they should. Serialization eliminates the
//      contention entirely.
//
//   2. When Verdaccio routing is active, parallel builds cause a
//      thundering herd against Verdaccio's upstream uplinks. Both
//      containers request the same package at the same instant;
//      Verdaccio doesn't deduplicate inflight requests, so BOTH go to
//      the public registry and report `cache miss`. Serializing makes
//      the second build's fetches all `cache hit`.
//
// Override via `DOCKER_BUILD_CONCURRENCY=N` or `-Pdocker.concurrency=N`
// when you have a beefy machine and don't care about the cache thrash.
val dockerConcurrency = (System.getenv("DOCKER_BUILD_CONCURRENCY")
    ?: project.findProperty("docker.concurrency") as? String
    ?: "1").toIntOrNull() ?: 1

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

// ── RegistryInjectionService — look up the existing shared registration ──
//
// The service is registered at the base level (zb.base / zb.monorepo-base
// inherit through zb.base on subprojects). `registerIfAbsent` here is
// idempotent — if the base plugin already registered it, this returns the
// existing provider. Same name + class guarantees we get the same instance.

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

    // Registry injection invalidation signal: when a slot is loaded with
    // Verdaccio + locally-published packages, publishes.json lists them.
    // Declaring it as an input makes Gradle invalidate this task when a new
    // package is published to Verdaccio — but stay UP-TO-DATE when nothing
    // has changed since the last install. Previously this branch short-
    // circuited `upToDateWhen { false }`, forcing every build to re-taint +
    // reinstall, which cascaded through every downstream task consuming
    // node_modules (buildDist → buildRaw → buildFoo).
    val slotName: String? = System.getenv("ZB_SLOT")
    val publishesFile: java.io.File? = slotName?.let {
        java.io.File(System.getProperty("user.home"), ".zbb/slots/$it/stacks/registry/publishes.json")
    }
    if (publishesFile?.exists() == true) {
        inputs.file(publishesFile).withPropertyName("registryPublishes")
    }

    outputs.dir(rootProject.file("node_modules"))
        .withPropertyName("nodeModules")

    usesService(registryInjection)

    doFirst {
        val service = registryInjection.get()

        // Stale-localhost cleanup — runs regardless of isActive.
        // After `zbb registry clear`, the lockfile may still carry localhost
        // entries for packages no longer in the registry. Detect and clean
        // them so the next `npm install` re-resolves from the public registry.
        val stale = service.findStaleLocalhostEntries(rootProject.rootDir) { msg -> logger.lifecycle(msg) }
        if (stale.isNotEmpty()) {
            service.cleanupStale(rootProject.rootDir, stale) { msg -> logger.lifecycle(msg) }
        }

        if (service.isActive && service.needsApply(rootProject.rootDir) { msg -> logger.lifecycle(msg) }) {
            val overrides = service.apply { msg -> logger.lifecycle(msg) }
            // Set scoped registry env vars on this Exec spec so npm sees them.
            // doFirst runs BEFORE the actual exec, and Exec.environment is read
            // at exec time — so this works.
            for ((k, v) in overrides) {
                environment[k] = v
            }
        }
    }

    outputs.upToDateWhen { rootProject.file("node_modules").exists() }
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

// monorepoTestIntegration — separate from monorepoTest. Integration tests
// usually need real backend creds (aws/vault/etc.) and are too expensive to
// run on every `zbb test`, so they have their own aggregator with their own
// gates declared on `lifecycle.testIntegration`. Fans out to ALL packages
// (not affected-only): integration runs are usually broad-confidence checks,
// not change-scoped feedback.
//
// Deliberately does NOT depend on monorepoBuild. Most IT setups run via tsx
// or against pre-built artifacts; pulling in a full lint+generate+transpile
// across every affected package adds minutes of unrelated work. Packages
// that genuinely need a rebuild before IT can wire it into their own
// zbb.yaml lifecycle command (e.g. `npm run transpile && mocha …`).
val monorepoTestIntegration = tasks.register("monorepoTestIntegration") {
    group = "monorepo"
    description = "Run integration tests for all workspace packages (zbb.yaml lifecycle preferred, npm script fallback)"
    dependsOn(workspaceInstall)
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
    description = "Clean all workspace packages — runs `npm run clean` per package (catches package-specific artifacts) AND always sweeps the standard build outputs (dist/, generated/, build/, *.tsbuildinfo)."
    doLast {
        val service = graphService.get()
        var npmCleaned = 0
        var standardCleaned = 0
        var failed = 0

        for ((pkgName, pkg) in service.graph.packages) {
            // ── Step 1: package's own clean script ─────────────────
            //
            // Run first so any package-specific artifacts get cleared
            // (api.yml, .docs/, tmp/, test-intetest-dump, *.yml bundles,
            // etc). The package author knows what's specific to their
            // module and the standard sweep below can't enumerate it.
            //
            // Failures here are NON-FATAL — we log and continue to the
            // standard sweep, because a broken or missing script
            // shouldn't leave stale dist/ + tsbuildinfo behind. Most of
            // the time it just means the package didn't define a clean
            // script at all.
            val cleanScript = pkg.scripts["clean"]
            if (!cleanScript.isNullOrBlank()) {
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
            }

            // ── Step 2: standard build-output sweep ────────────────
            //
            // ALWAYS run, regardless of whether the npm script ran or
            // succeeded. This is the safety net that closes the silent-
            // tsc-skip footgun: when dist/ gets wiped (by anything) but
            // *.tsbuildinfo doesn't, the next `tsc -b` reads the cache,
            // decides "already built", and emits nothing. By guaranteeing
            // both go away together, we make sure any subsequent build
            // produces real output.
            //
            // The list covers everything zbb's typescript pipeline
            // produces. Package-specific artifacts (yml bundles, etc.)
            // are NOT in this list — they belong to step 1.
            var sweptAny = false
            for (sub in listOf("dist", "generated", "build")) {
                val target = pkg.dir.resolve(sub)
                if (target.exists()) {
                    target.deleteRecursively()
                    sweptAny = true
                }
            }
            // tsc incremental build cache files. Cover the canonical
            // names AND any other tsconfig.*.tsbuildinfo variants the
            // package might use (test, esm, cjs, etc).
            val tsBuildInfoFiles = pkg.dir.listFiles { _, name ->
                name == "tsconfig.tsbuildinfo" ||
                (name.startsWith("tsconfig.") && name.endsWith(".tsbuildinfo"))
            }
            if (tsBuildInfoFiles != null) {
                for (f in tsBuildInfoFiles) {
                    if (f.delete()) sweptAny = true
                }
            }
            if (sweptAny) standardCleaned += 1
        }

        val total = service.graph.packages.size
        logger.lifecycle(
            "monorepoClean: $npmCleaned via npm script, $standardCleaned via standard sweep, $failed npm script failures (total $total packages)"
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

// ── Phase command resolution ─────────────────────────────────────────
//
// Per-package phase tasks pick what to run in this priority order:
//
//   1. Subproject zbb.yaml has `lifecycle.<phase>` → spawn `zbb <phase>`.
//      The zbb dispatcher handles tools/env gates declared on that
//      lifecycle entry and spawns the entry's command. Recursion-safe:
//      `zbb <phase>` from the package dir resolves the closest zbb.yaml
//      with that lifecycle entry (the package's own), never reaches the
//      root entry that calls back into gradle.
//
//   2. package.json `scripts.<phase>` is a real command (not blank, not
//      `echo …`) → spawn `npm run <phase>`. Falls back to the colon-
//      snake form (`testIntegration` → `test:integration`, `copyDeps`
//      → `copy:deps`) for back-compat with existing scripts.
//
//   3. Otherwise → register a no-op task. The display still shows the
//      package row with a "skipped: <reason>" log line so it's clear
//      no work was done (vs hiding the package entirely).
//
// zbb.yaml is the source of truth: when a package has its own zbb.yaml
// lifecycle entry, that wins over the npm script.

sealed class PhaseAction {
    data class Zbb(val phase: String) : PhaseAction()
    data class Npm(val script: String) : PhaseAction()
    data class NoOp(val reason: String) : PhaseAction()
}

fun camelToColonSnake(s: String): String =
    s.replace(Regex("([a-z])([A-Z])"), "$1:$2").lowercase()

fun hasLifecycleEntry(zbbYaml: java.io.File, command: String): Boolean {
    if (!zbbYaml.exists()) return false
    return try {
        @Suppress("UNCHECKED_CAST")
        val parsed = org.yaml.snakeyaml.Yaml().load<Map<String, Any?>>(zbbYaml.readText())
        val lifecycle = parsed?.get("lifecycle") as? Map<*, *> ?: return false
        val raw = lifecycle[command] ?: return false
        // Recursion guard: if the entry's command just calls `./gradlew`,
        // delegating to zbb would spawn ANOTHER gradle invocation — and
        // the outer gradle (which is already running this exact task) is
        // holding the daemon, so the inner blocks forever. Sub-zbb.yaml
        // files copied from a top-level template (the "shipped" manifest
        // pattern, where consumers run `./gradlew test` from their
        // extracted artifact) hit this every time. Skip — the outer
        // gradle's task graph is already correct; falling through to npm
        // script or no-op is right.
        val cmdString = when (raw) {
            is String -> raw
            is Map<*, *> -> raw["command"] as? String
            else -> null
        }
        if (cmdString?.trim()?.startsWith("./gradlew") == true) return false
        true
    } catch (_: Exception) {
        false
    }
}

fun isRealScript(body: String?): Boolean =
    !body.isNullOrBlank() && !body.trimStart().startsWith("echo ")

// ── Output tee helpers ───────────────────────────────────────────────
//
// All monorepo Exec tasks tee their stdout/stderr to:
//   1. The live console (so users see progress as it happens)
//   2. A per-task log file (for failure replay + zbb TUI display)
//   3. A central .zbb-gradle/gradle.log (truncated ONCE per gradle
//      invocation by the taskGraph.whenReady hook below, then appended
//      to by every task that runs)
//
// The central log is the user-facing artifact: a single file you can scroll
// through after a run to review everything that happened across all
// subprojects. Per-task logs stay around for the displayLog hook the TUI
// uses for inline failure dumps.

// Truncate gradle.log once per build, BEFORE any tasks run.
//
// Skip truncation when zbb (Node) is the driver. Detection: the
// ZBB_MONOREPO_EVENT_FILE env var is set by zbb's runWithDisplay /
// marker-delegation paths before spawning gradle. zbb already opens
// gradle.log in 'w' mode (truncate) via createWriteStream; if we also
// truncate here, the user sees long runs of NULL bytes in the log:
//
//   1. Node opens gradle.log in 'w' mode → fd_node position 0, file empty.
//   2. Node pipes gradle's configuration-phase output → file grows to N bytes,
//      fd_node position N.
//   3. taskGraph.whenReady fires → THIS truncation → file is 0 bytes.
//      Node's fd_node position is still N (kernel doesn't reset Node's
//      position when another fd truncates).
//   4. Java's per-task tee opens FOS in append mode → writes banner at
//      EOF (currently 0). File grows to M bytes.
//   5. Node's pipe gets more output → write at fd_node position N → kernel
//      fills the 0..N gap with zero bytes (sparse file). Result: N null bytes
//      followed by the banner content Java already wrote, followed by Node's
//      data → file looks corrupt.
//
// When zbb isn't involved (direct `./gradlew` run), Java owns the file
// and the truncation runs as before.
gradle.taskGraph.whenReady {
    if (System.getenv("ZBB_MONOREPO_EVENT_FILE") != null) return@whenReady
    val centralLog = rootProject.file("$ZBB_GRADLE_DIR/gradle.log")
    centralLog.parentFile.mkdirs()
    centralLog.writeText("")
}

fun openTee(
    perTaskLog: java.io.File,
    centralLog: java.io.File,
    consoleStream: java.io.OutputStream,
    banner: String,
): java.io.OutputStream {
    perTaskLog.parentFile.mkdirs()
    centralLog.parentFile.mkdirs()
    // SynchronizedOutputStream wrap: gradle reads stdout and stderr on
    // separate threads, both writing to these BufferedOutputStreams.
    // Unsynchronized count++ races produce zero-filled gaps in the log.
    val perTask = com.zerobias.buildtools.util.SynchronizedOutputStream(
        java.io.BufferedOutputStream(java.io.FileOutputStream(perTaskLog))
    )
    val central = com.zerobias.buildtools.util.SynchronizedOutputStream(
        java.io.BufferedOutputStream(java.io.FileOutputStream(centralLog, /* append = */ true))
    )
    central.write(banner.toByteArray())
    central.flush()
    // Compose: (perTask + central) + console. Three-way tee.
    val files = org.apache.tools.ant.util.TeeOutputStream(perTask, central)
    return org.apache.tools.ant.util.TeeOutputStream(files, consoleStream)
}

fun resolvePhaseAction(
    pkgDir: java.io.File,
    phase: String,
    scripts: Map<String, String>,
): PhaseAction {
    if (hasLifecycleEntry(pkgDir.resolve("zbb.yaml"), phase)) {
        return PhaseAction.Zbb(phase)
    }
    if (isRealScript(scripts[phase])) {
        return PhaseAction.Npm(phase)
    }
    val colonForm = camelToColonSnake(phase)
    if (colonForm != phase && isRealScript(scripts[colonForm])) {
        return PhaseAction.Npm(colonForm)
    }
    val reason = when {
        scripts[phase] == null && (colonForm == phase || scripts[colonForm] == null) ->
            "no zbb.yaml lifecycle.$phase, no npm script"
        scripts[phase]?.isBlank() == true -> "npm script is empty"
        else -> "npm script is an echo placeholder"
    }
    return PhaseAction.NoOp(reason)
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
        //
        // Source dirs come from the monorepo config's sourceDirs list
        // (default ["src"], configurable in zbb.yaml's monorepo block).
        // This MUST match whatever the package's tsconfig/build script
        // actually reads from — e.g. zbb reads from lib/, not src/. If
        // only `src/` is tracked but the code lives in `lib/`, gradle's
        // up-to-date check sees no input change and reports `cached`
        // even when lib/ files were edited.
        val srcDirs = service.config.sourceDirs.map { pkg.dir.resolve(it) }
        val packageJson = pkg.dir.resolve("package.json")
        val tsconfigJson = pkg.dir.resolve("tsconfig.json")
        val apiYml = pkg.dir.resolve("api.yml")
        val generatedDir = pkg.dir.resolve("generated")

        // FileTree wrappers handle missing-dir cases (empty tree). For
        // single FILES, Gradle's input validation requires them to exist
        // even with .optional(), so we only declare them if they're present.
        fun fileTreeOf(dir: java.io.File) = subproject.fileTree(dir).matching { include("**/*") }

        for (phase in phases) {
            val action = resolvePhaseAction(pkg.dir, phase, pkg.scripts)
            val stampFile = pkg.dir.resolve("build/${phase}.stamp")
            if (action is PhaseAction.NoOp) {
                val reason = action.reason
                subproject.tasks.register(phase) {
                    group = "monorepo"
                    description = "No-op `$phase` for $pkgName ($reason)"
                    dependsOn(workspaceInstall)
                    inputs.files(srcDirs.map { fileTreeOf(it) }).withPropertyName("srcFiles")
                    if (packageJson.exists()) inputs.file(packageJson).withPropertyName("packageJson")
                    outputs.file(stampFile).withPropertyName("phaseStamp")
                    doLast {
                        stampFile.parentFile.mkdirs()
                        stampFile.writeText("$phase no-op ($reason) at ${java.time.Instant.now()}\n")
                    }
                }
                continue
            }
            val (cmd, label) = when (action) {
                is PhaseAction.Zbb -> listOf("zbb", action.phase) to "zbb ${action.phase}"
                is PhaseAction.Npm -> listOf("npm", "run", action.script) to "npm run ${action.script}"
                is PhaseAction.NoOp -> error("unreachable — handled above")
            }
            subproject.tasks.register<Exec>(phase) {
                group = "monorepo"
                description = "Run `$label` for $pkgName"
                workingDir = pkg.dir
                commandLine = cmd
                dependsOn(workspaceInstall)

                // Capture stdout+stderr to log files so failure output is
                // ALWAYS surfaced, independent of Gradle console mode or
                // CI log-streaming quirks. Without this, parallel Exec
                // task buffering can swallow tsc/eslint output on failure
                // and the CI log shows only `FAILED — exit 1` with no clue.
                // isIgnoreExitValue=true lets us handle the exit code in
                // doLast so the captured log gets dumped BEFORE we throw.
                isIgnoreExitValue = true
                val stdoutLog = pkg.dir.resolve("build/${phase}.stdout.log")
                val stderrLog = pkg.dir.resolve("build/${phase}.stderr.log")
                // Display log: .zbb-gradle/logs/<safeName>-<phase>.log
                // Must match the path Display.ts computes from the gradle
                // project path so the TTY failure block can read it.
                val safeName = gradlePath.removePrefix(":").replace(":", "-")
                val displayLog = rootProject.file("$ZBB_GRADLE_DIR/logs/${safeName}-${phase}.log")
                val centralLog = rootProject.file("$ZBB_GRADLE_DIR/gradle.log")
                doFirst {
                    displayLog.parentFile.mkdirs()
                    val banner = "\n===== ${gradlePath.removePrefix(":")}:$phase ($label) =====\n"
                    standardOutput = openTee(stdoutLog, centralLog, System.out, banner)
                    errorOutput = openTee(stderrLog, centralLog, System.err, "")
                }

                // Directory inputs (always declared — empty FileTree if missing)
                inputs.files(srcDirs.map { fileTreeOf(it) }).withPropertyName("srcFiles")
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
                    // Ensure streams are flushed before reading logs back.
                    (standardOutput as? java.io.Closeable)?.close()
                    (errorOutput as? java.io.Closeable)?.close()

                    // Write combined stdout+stderr to .zbb-gradle/logs/ so the
                    // zbb TTY display can read it for inline failure output.
                    val combined = buildString {
                        if (stdoutLog.exists() && stdoutLog.length() > 0) append(stdoutLog.readText())
                        if (stderrLog.exists() && stderrLog.length() > 0) {
                            append("----- stderr -----\n")
                            append(stderrLog.readText())
                        }
                    }
                    displayLog.writeText(combined)

                    val exitValue = executionResult.get().exitValue
                    if (exitValue != 0) {
                        logger.lifecycle("")
                        logger.lifecycle("===== $label FAILED for $pkgName (exit $exitValue) =====")
                        logger.lifecycle(combined)
                        logger.lifecycle("===== end $pkgName:$phase output =====")
                        logger.lifecycle("")
                        throw GradleException(
                            "$label failed for $pkgName (exit $exitValue) — " +
                            "full output above; also at ${stdoutLog.relativeTo(rootProject.projectDir)}"
                        )
                    }
                    stampFile.parentFile.mkdirs()
                    stampFile.writeText("$phase completed at ${java.time.Instant.now()}\n")
                }
            }
        }

        for (testPhase in testPhases) {
            val action = resolvePhaseAction(pkg.dir, testPhase, pkg.scripts)
            val stampFile = pkg.dir.resolve("build/${testPhase}.stamp")
            val testDir = pkg.dir.resolve("test")
            if (action is PhaseAction.NoOp) {
                val reason = action.reason
                subproject.tasks.register(testPhase) {
                    group = "monorepo"
                    description = "No-op `$testPhase` for $pkgName ($reason)"
                    dependsOn(workspaceInstall)
                    inputs.files(srcDirs.map { fileTreeOf(it) }).withPropertyName("srcFiles")
                    inputs.files(fileTreeOf(testDir)).withPropertyName("testFiles")
                    if (packageJson.exists()) inputs.file(packageJson).withPropertyName("packageJson")
                    outputs.file(stampFile).withPropertyName("phaseStamp")
                    doLast {
                        stampFile.parentFile.mkdirs()
                        stampFile.writeText("$testPhase no-op ($reason) at ${java.time.Instant.now()}\n")
                    }
                }
                continue
            }
            val (cmd, label) = when (action) {
                is PhaseAction.Zbb -> listOf("zbb", action.phase) to "zbb ${action.phase}"
                is PhaseAction.Npm -> listOf("npm", "run", action.script) to "npm run ${action.script}"
                is PhaseAction.NoOp -> error("unreachable — handled above")
            }
            subproject.tasks.register<Exec>(testPhase) {
                group = "monorepo"
                description = "Run `$label` for $pkgName"
                workingDir = pkg.dir
                commandLine = cmd
                dependsOn(workspaceInstall)

                // Capture stdout+stderr — tee to per-task file, central
                // .zbb-gradle/gradle.log, and live console.
                isIgnoreExitValue = true
                val stdoutLog = pkg.dir.resolve("build/${testPhase}.stdout.log")
                val stderrLog = pkg.dir.resolve("build/${testPhase}.stderr.log")
                val safeName = gradlePath.removePrefix(":").replace(":", "-")
                val displayLog = rootProject.file("$ZBB_GRADLE_DIR/logs/${safeName}-${testPhase}.log")
                val centralLog = rootProject.file("$ZBB_GRADLE_DIR/gradle.log")
                doFirst {
                    displayLog.parentFile.mkdirs()
                    val banner = "\n===== ${gradlePath.removePrefix(":")}:$testPhase ($label) =====\n"
                    standardOutput = openTee(stdoutLog, centralLog, System.out, banner)
                    errorOutput = openTee(stderrLog, centralLog, System.err, "")
                }

                inputs.files(srcDirs.map { fileTreeOf(it) }).withPropertyName("srcFiles")
                inputs.files(fileTreeOf(testDir)).withPropertyName("testFiles")
                inputs.files(fileTreeOf(generatedDir)).withPropertyName("generatedFiles")
                if (packageJson.exists()) inputs.file(packageJson).withPropertyName("packageJson")
                if (tsconfigJson.exists()) inputs.file(tsconfigJson).withPropertyName("tsconfigJson")

                outputs.file(stampFile).withPropertyName("phaseStamp")

                doLast {
                    (standardOutput as? java.io.Closeable)?.close()
                    (errorOutput as? java.io.Closeable)?.close()

                    // Write combined stdout+stderr to .zbb-gradle/logs/ so the
                    // zbb TTY display can read it for inline failure output.
                    val combined = buildString {
                        if (stdoutLog.exists() && stdoutLog.length() > 0) append(stdoutLog.readText())
                        if (stderrLog.exists() && stderrLog.length() > 0) {
                            append("----- stderr -----\n")
                            append(stderrLog.readText())
                        }
                    }
                    displayLog.writeText(combined)

                    val exitValue = executionResult.get().exitValue
                    if (exitValue != 0) {
                        logger.lifecycle("")
                        logger.lifecycle("===== $label FAILED for $pkgName (exit $exitValue) =====")
                        logger.lifecycle(combined)
                        logger.lifecycle("===== end $pkgName:$testPhase output =====")
                        logger.lifecycle("")
                        throw GradleException(
                            "$label failed for $pkgName (exit $exitValue) — " +
                            "full output above; also at ${stdoutLog.relativeTo(rootProject.projectDir)}"
                        )
                    }
                    stampFile.parentFile.mkdirs()
                    stampFile.writeText("$testPhase completed at ${java.time.Instant.now()}\n")
                }
            }
        }

        // testIntegration phase — registered separately from testPhases so it's
        // not coupled to monorepoTest. Same resolver logic (zbb.yaml lifecycle
        // → npm script → no-op). All packages get a task; the monorepoTestIntegration
        // aggregator below fans out across them all (not affected-only).
        run {
            val phase = "testIntegration"
            val action = resolvePhaseAction(pkg.dir, phase, pkg.scripts)
            val stampFile = pkg.dir.resolve("build/${phase}.stamp")
            val testDir = pkg.dir.resolve("test")
            if (action is PhaseAction.NoOp) {
                val reason = action.reason
                subproject.tasks.register(phase) {
                    group = "monorepo"
                    description = "No-op `$phase` for $pkgName ($reason)"
                    dependsOn(workspaceInstall)
                    inputs.files(srcDirs.map { fileTreeOf(it) }).withPropertyName("srcFiles")
                    inputs.files(fileTreeOf(testDir)).withPropertyName("testFiles")
                    if (packageJson.exists()) inputs.file(packageJson).withPropertyName("packageJson")
                    outputs.file(stampFile).withPropertyName("phaseStamp")
                    doLast {
                        stampFile.parentFile.mkdirs()
                        stampFile.writeText("$phase no-op ($reason) at ${java.time.Instant.now()}\n")
                        logger.lifecycle("$pkgName: skipping $phase ($reason)")
                    }
                }
            } else {
                val (cmd, label) = when (action) {
                    is PhaseAction.Zbb -> listOf("zbb", action.phase) to "zbb ${action.phase}"
                    is PhaseAction.Npm -> listOf("npm", "run", action.script) to "npm run ${action.script}"
                    is PhaseAction.NoOp -> error("unreachable — handled above")
                }
                subproject.tasks.register<Exec>(phase) {
                    group = "monorepo"
                    description = "Run `$label` for $pkgName"
                    workingDir = pkg.dir
                    commandLine = cmd
                    dependsOn(workspaceInstall)

                    // Integration tests exercise EXTERNAL state (vault tokens,
                    // aws creds, remote API). Source files / package.json
                    // haven't changed but the world has — always run.
                    outputs.upToDateWhen { false }

                    isIgnoreExitValue = true
                    val stdoutLog = pkg.dir.resolve("build/${phase}.stdout.log")
                    val stderrLog = pkg.dir.resolve("build/${phase}.stderr.log")
                    val safeName = gradlePath.removePrefix(":").replace(":", "-")
                    val displayLog = rootProject.file("$ZBB_GRADLE_DIR/logs/${safeName}-${phase}.log")
                    val centralLog = rootProject.file("$ZBB_GRADLE_DIR/gradle.log")
                    doFirst {
                        displayLog.parentFile.mkdirs()
                        val banner = "\n===== ${gradlePath.removePrefix(":")}:$phase ($label) =====\n"
                        // Tee: per-task file + central gradle.log + live console.
                        // Test output ("27 passing") streams to terminal AND
                        // gets archived in .zbb-gradle/gradle.log for review.
                        standardOutput = openTee(stdoutLog, centralLog, System.out, banner)
                        errorOutput = openTee(stderrLog, centralLog, System.err, "")
                    }

                    inputs.files(srcDirs.map { fileTreeOf(it) }).withPropertyName("srcFiles")
                    inputs.files(fileTreeOf(testDir)).withPropertyName("testFiles")
                    inputs.files(fileTreeOf(generatedDir)).withPropertyName("generatedFiles")
                    if (packageJson.exists()) inputs.file(packageJson).withPropertyName("packageJson")
                    if (tsconfigJson.exists()) inputs.file(tsconfigJson).withPropertyName("tsconfigJson")

                    doLast {
                        (standardOutput as? java.io.Closeable)?.close()
                        (errorOutput as? java.io.Closeable)?.close()
                        val exitValue = executionResult.get().exitValue
                        // Minimal stamp for the TUI's displayLog hook —
                        // full output is in the central gradle.log and
                        // per-task stdout/stderr files.
                        displayLog.writeText("$phase completed (exit $exitValue) at ${java.time.Instant.now()}\n")
                        if (exitValue != 0) {
                            throw GradleException(
                                "$label failed for $pkgName (exit $exitValue) — " +
                                "see test output above; full log at ${centralLog.relativeTo(rootProject.projectDir)}"
                            )
                        }
                    }
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

    // testIntegration's deps need the LAST build phase of each internal
    // workspace dep, NOT each dep's own testIntegration. Package.json
    // `main` for those deps points at dist/, so without their transpile
    // running first, runtime resolution fails with ERR_MODULE_NOT_FOUND.
    // (testIntegration of the consumer can run via tsx — no need to depend
    // on its OWN transpile — but consumed packages must be built.)
    //
    // For JVM deps (codegen et al.), don't use the standard `build` task:
    // it's a lifecycle alias for `assemble + check`, and `check` pulls in
    // `test` — which for a workspace where codegen.package.json has npm
    // dependencies (e.g. util-connector) cascades through the section-2
    // cross-project test wiring into every npm package's :test, dragging
    // unit tests into a testIntegration run. Prefer artifact-staging
    // tasks: `stageBinJars` (zb.java-module convention), then `assemble`
    // (gradle base plugin), then `jar` (java plugin). All produce the
    // bin-staged JARs that runtime consumers need without firing tests.
    val lastBuildPhase = phases.lastOrNull()
    if (lastBuildPhase != null) {
        for ((_, pkg) in packages) {
            val gradlePath = ":" + pkg.relDir.replace("/", ":")
            val subproject = rootProject.findProject(gradlePath) ?: continue
            val itTask = subproject.tasks.findByName("testIntegration") ?: continue
            for (depName in pkg.internalDeps) {
                val depPath = service.packageNameToGradlePath[depName] ?: continue
                val depProject = rootProject.findProject(depPath) ?: continue
                val depTask = if (hasExistingBuildInfra(depProject)) {
                    depProject.tasks.findByName("stageBinJars")
                        ?: depProject.tasks.findByName("assemble")
                        ?: depProject.tasks.findByName("jar")
                } else {
                    depProject.tasks.findByName(lastBuildPhase)
                } ?: continue
                itTask.dependsOn(depTask)
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

    // monorepoTestIntegration fans out across ALL packages (not affected-only)
    // — integration runs are broad-confidence checks rather than change-scoped
    // feedback. Each subproject's testIntegration task was registered above
    // with the resolver: zbb.yaml lifecycle → npm script → no-op skip.
    monorepoTestIntegration.configure {
        for ((_, pkg) in packages) {
            val gradlePath = ":" + pkg.relDir.replace("/", ":")
            val subproject = rootProject.findProject(gradlePath) ?: continue
            subproject.tasks.findByName("testIntegration")?.let { dependsOn(it) }
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
        usesService(registryInjection)

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

            // ── Verdaccio routing ────────────────────────────────────
            //
            // When the slot has a healthy registry stack, point the
            // in-container `npm install` at Verdaccio's host-bridge URL
            // (host.docker.internal:<REGISTRY_PORT>) instead of pulling
            // from npm.pkg.github.com / pkg.zerobias.org over the public
            // internet. Verdaccio proxies both upstreams server-side and
            // grants anonymous reads, so the build container needs no
            // auth tokens for the swap path.
            //
            // Why the host bridge instead of the compose network:
            //   BuildKit (the default Docker build engine since 23+)
            //   refuses arbitrary `--network <name>` modes for security
            //   isolation. Attaching `--network local_default` fails
            //   with "network mode not supported by buildkit". The host
            //   bridge sidesteps the restriction — Verdaccio is already
            //   published on a host port, so we just point the build at
            //   `host.docker.internal:<port>` and pass
            //   `--add-host=host.docker.internal:host-gateway` so the
            //   name resolves on bare Linux too (Docker Desktop already
            //   has it).
            //
            // Mechanism:
            //   1. If `dockerContextDir/.npmrc.zbb-bak` exists from a
            //      crashed prior run, restore it first (recovery).
            //   2. Back up the source `.npmrc` to `.npmrc.zbb-bak`.
            //   3. Write a fresh Verdaccio-flavored `.npmrc` over it.
            //   4. Pass `--add-host=host.docker.internal:host-gateway`
            //      to docker build so the in-container resolver can
            //      find Verdaccio.
            //   5. Restore the source `.npmrc` in `finally`, regardless
            //      of build success / failure.
            //
            // Falls back to the original upstream-targeting flow when
            // the registry stack isn't running.
            val regSvc = registryInjection.get()
            val sourceNpmrc = dockerContextDir.resolve(".npmrc")
            val backupNpmrc = dockerContextDir.resolve(".npmrc.zbb-bak")
            val useVerdaccio = regSvc.isHealthy && regSvc.hostBridgeRegistryUrl != null

            // Recovery: restore stale backup from a crashed prior run.
            if (backupNpmrc.exists() && !useVerdaccio) {
                println("[verdaccio] recovering stale .npmrc.zbb-bak from prior run")
                java.nio.file.Files.move(
                    backupNpmrc.toPath(),
                    sourceNpmrc.toPath(),
                    java.nio.file.StandardCopyOption.REPLACE_EXISTING,
                )
            }

            var swappedNpmrc = false
            if (useVerdaccio) {
                val bridgeUrl = regSvc.hostBridgeRegistryUrl!!
                println("[verdaccio] routing in-container npm install through $bridgeUrl")
                if (sourceNpmrc.exists()) {
                    // Recovery first — if a stray backup exists, drop
                    // the current .npmrc (which is from a previous
                    // crashed swap) and use the backup as the truth.
                    if (backupNpmrc.exists()) {
                        sourceNpmrc.delete()
                        java.nio.file.Files.move(
                            backupNpmrc.toPath(),
                            sourceNpmrc.toPath(),
                        )
                    }
                    java.nio.file.Files.copy(
                        sourceNpmrc.toPath(),
                        backupNpmrc.toPath(),
                        java.nio.file.StandardCopyOption.REPLACE_EXISTING,
                    )
                    swappedNpmrc = true
                }
                sourceNpmrc.writeText(buildVerdaccioNpmrc(bridgeUrl))
            } else if (npmToken.isEmpty() || zbToken.isEmpty()) {
                println("WARNING: NPM_TOKEN or ZB_TOKEN not set - Docker build may fail")
            }

            try {
                val gradleDockerfile = dockerContextDir.resolve("GradleDockerfile")
                val dockerfileArgs = if (gradleDockerfile.exists()) {
                    println("Using GradleDockerfile")
                    listOf("-f", "GradleDockerfile")
                } else {
                    println("Using default Dockerfile")
                    emptyList()
                }

                // --add-host: only when verdaccio is in play.
                //
                // BuildKit refuses arbitrary `--network <name>` modes,
                // so we route through the host bridge instead. The
                // `host-gateway` magic value resolves to the host's
                // gateway IP from the build container's perspective —
                // built into Docker since 20.10, works on Linux + Docker
                // Desktop without per-machine configuration.
                val networkArgs = if (useVerdaccio) {
                    listOf("--add-host", "host.docker.internal:host-gateway")
                } else {
                    emptyList()
                }

                val fullCommand = listOf(
                    "docker", "build",
                    "--progress=plain",
                    "-t", imageTag,
                    "--build-arg", "npm_token=${npmToken}",
                    "--build-arg", "zb_token=${zbToken}",
                ) + networkArgs + dockerfileArgs + listOf(".")

                // Capture docker's stdout/stderr to BOTH the per-task
                // log file (for post-mortem inspection + the display's
                // "log: …" reference) AND gradle's own stdout (so the
                // user can see live build progress in their terminal —
                // without this, dockerBuild looks like a 5-minute black
                // box with no idea what step is running).
                //
                // ProcessBuilder doesn't have a built-in tee, so we
                // read the process's combined stdout+stderr line-by-line
                // and write each line to both sinks.
                val safeName = pkg.relDir.replace("/", "-")
                val logFile = repoRoot.resolve("$ZBB_GRADLE_DIR/logs/$safeName-dockerBuild.log")
                logFile.parentFile.mkdirs()

                val dockerProcess = ProcessBuilder(fullCommand)
                    .directory(dockerContextDir)
                    .redirectErrorStream(true)
                    .start()

                logFile.bufferedWriter().use { writer ->
                    dockerProcess.inputStream.bufferedReader().forEachLine { line ->
                        writer.write(line)
                        writer.newLine()
                        writer.flush()
                        println(line)
                    }
                }
                val dockerExit = dockerProcess.waitFor()
                if (dockerExit != 0) {
                    throw GradleException("Docker build failed (exit $dockerExit) — see $logFile")
                }

                imageStamp.get().asFile.apply {
                    parentFile.mkdirs()
                    writeText("$imageTag built at ${java.time.Instant.now()}")
                }

                println("✓ Docker image built: $imageTag")
            } finally {
                // Restore the source .npmrc whether the build passed,
                // failed, or threw. This is the only thing that keeps the
                // working tree clean.
                if (swappedNpmrc && backupNpmrc.exists()) {
                    java.nio.file.Files.move(
                        backupNpmrc.toPath(),
                        sourceNpmrc.toPath(),
                        java.nio.file.StandardCopyOption.REPLACE_EXISTING,
                    )
                }
            }
        }
    }
}

/**
 * Render the in-container `.npmrc` that points all zbb-tracked scopes at
 * the local Verdaccio container. Verdaccio's default config grants
 * anonymous reads (`access: $all`) so no `_authToken` lines are needed —
 * the build container can pull tarballs without any credentials.
 */
private fun buildVerdaccioNpmrc(internalUrl: String): String {
    val u = if (internalUrl.endsWith("/")) internalUrl else "$internalUrl/"
    return """
        # Generated by zbb dockerBuild — points at the slot's local
        # Verdaccio cache. Restored to the source .npmrc after the build.
        registry=$u
        @zerobias-com:registry=$u
        @zerobias-org:registry=$u
        @auditlogic:registry=$u
        @auditmation:registry=$u
        @devsupply:registry=$u
    """.trimIndent() + "\n"
}
