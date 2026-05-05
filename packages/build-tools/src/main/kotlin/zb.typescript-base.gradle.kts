// ────────────────────────────────────────────────────────────────────────
// zb.typescript-base — thin convention plugin for appliance TypeScript modules
//
// Used by `com/node/{lib,cli,node,manager,ui}` (the @zerobias-com/node-stack).
// NOT used by Hub modules under auditlogic/module-gradle — those use the
// fuller-featured `zb.typescript` (OpenAPI codegen, hub-generator, Docker).
//
// What this plugin does:
//   1. Applies Gradle's built-in `base` plugin (clean, build, check, assemble).
//   2. Applies the gradle-node-plugin and resolves the nvm-managed Node binary
//      from `.nvmrc` at the rootProject level — same pattern as `zb.typescript`.
//   3. Registers `npmInstallModule` (`npm install --include=dev`) with
//      `verifyNoLocalRegistry` ordering and `RegistryInjectionService` hooks
//      so Verdaccio-backed slots resolve `@zerobias-com/*` packages from the
//      local registry stack.
//   4. Registers a `lint` lifecycle stub that à la carte register* extensions
//      hang off (`registerEslintLint` adds the actual eslint task).
//   5. Registers `compile` and overrides `build` to depend on `lint, compile`.
//   6. Registers a `test` lifecycle stub.
//   7. Registers an `ApplianceExtension` (`appliance { chmodBin = "..." }`).
//   8. Wires `clean` to remove `dist/` and `tsconfig.tsbuildinfo`.
//   9. Registers `publish` → `zbb registry publish` (Verdaccio).
//
// What this plugin does NOT do:
//   - Code generation (no Redocly, no hub-generator). Appliance modules ship
//     hand-written TypeScript without OpenAPI specs.
//   - tsc/eslint/mocha/bun task registration — those come from à la carte
//     extension functions in `com.zerobias.buildtools.appliance` so each
//     module composes the lifecycle it needs.
//   - Vendor/product semantics. Appliance modules are not vendor-product
//     shaped and do not get an `npm version` bump per build.
// ────────────────────────────────────────────────────────────────────────

import com.github.gradle.node.npm.task.NpmTask
import com.github.gradle.node.npm.task.NpxTask
import com.zerobias.buildtools.appliance.ApplianceDebExtension
import com.zerobias.buildtools.appliance.ApplianceExtension
import com.zerobias.buildtools.monorepo.RegistryInjectionService

plugins {
    id("base")
    id("com.github.node-gradle.node")
}

// Extend the stock `base` plugin's `clean` task to also remove `dist/`
// (tsc/bun output) and `node_modules/` (npm-installed deps). Without
// this, `zbb clean` only removes build/ — leaving stale type defs and
// half-relinked dependencies that can poison the next build's tsc
// output. node_modules is included because Verdaccio-published
// workspace packages get linked in transitively, and stale links
// can produce wrong type defs across reinstalls.
tasks.named<Delete>("clean") {
    delete("dist", "node_modules")
}

// nebula.ospackage is NOT applied here. It auto-registers a `buildDeb`
// task-rule that would surface on every module (including libraries that
// don't ship a deb). registerBuildDeb() applies the plugin lazily, so only
// modules that declare `applianceDeb { binPath = ... }` get the plugin
// and the resulting buildDeb task. See BuildDeb.kt.

// ────────────────────────────────────────────────────────────
// nvm-managed Node — resolve from .nvmrc, inject into PATH so
// every NpxTask/NpmTask uses the right binary.
// ────────────────────────────────────────────────────────────
val nvmDir = System.getenv("NVM_DIR")?.let { java.io.File(it) }
    ?: java.io.File(System.getProperty("user.home"), ".nvm")
val nvmrcFile = rootProject.file(".nvmrc")
val nvmNodeVersion = if (nvmrcFile.exists()) nvmrcFile.readText().trim().removePrefix("v") else null
val nvmNodeBinDir: String? = if (nvmNodeVersion != null) {
    val binDir = nvmDir.resolve("versions/node/v${nvmNodeVersion}/bin")
    if (binDir.exists()) binDir.absolutePath else null
} else null

node {
    // Use the nvm-managed Node, never download into the project tree.
    download.set(false)
}

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

// ────────────────────────────────────────────────────────────
// ApplianceExtension — `appliance { chmodBin = "src/bin/foo.js" }`
// ────────────────────────────────────────────────────────────
extensions.create("appliance", ApplianceExtension::class.java)

// ────────────────────────────────────────────────────────────
// ApplianceDebExtension — `applianceDeb { binPath, binName, ... }`
//
// Distinct from `appliance` (chmodBin). Modules that ship a binary deb
// (cli, node, manager, ui in com/node) populate this; libraries leave it
// unset and don't get a `:buildDeb` task. See BuildDeb.kt for semantics.
// ────────────────────────────────────────────────────────────
extensions.create("applianceDeb", ApplianceDebExtension::class.java)

// ────────────────────────────────────────────────────────────
// RegistryInjectionService — Verdaccio-aware npm install handling.
//
// Same pattern as zb.typescript: when a slot's local Verdaccio registry
// is healthy and has locally-published packages we depend on, the
// service rewrites `package-lock.json` to pull from `http://localhost:...`,
// runs the install, and restores the lockfile on completion.
// ────────────────────────────────────────────────────────────
val registryInjection = gradle.sharedServices.registerIfAbsent(
    "registryInjection",
    RegistryInjectionService::class.java,
) {
    parameters.repoRoot.set(rootProject.layout.projectDirectory)
}

// ────────────────────────────────────────────────────────────
// verifyNoLocalRegistry — gate-side guard. Same idea as zb.base's
// version: refuse to publish a lockfile that still carries
// `http://localhost:NNNN/...` URLs from a dev session. The slim
// implementation here just logs and passes — appliance modules aren't
// CI-gated against a localhost taint today, but downstream phases
// (deb publishing) need the task to exist for ordering.
// ────────────────────────────────────────────────────────────
val verifyNoLocalRegistry = tasks.register("verifyNoLocalRegistry") {
    group = "lifecycle"
    description = "Sanity-check package-lock.json for stray localhost registry URLs"
    usesService(registryInjection)
    doLast {
        val offenders = com.zerobias.buildtools.monorepo.LocalRegistryScanner.scan(rootProject.rootDir)
        if (offenders.isNotEmpty()) {
            logger.lifecycle("verifyNoLocalRegistry: ${offenders.size} package-lock.json entries still reference localhost (informational)")
        }
    }
}

// ────────────────────────────────────────────────────────────
// npmInstallModule — `npm install --include=dev`.
//
// `--include=dev` is essential: slot env may set `NODE_ENV=production`
// which would otherwise tell npm to skip devDependencies (tsc, eslint,
// mocha — the entire build chain).
// ────────────────────────────────────────────────────────────
val moduleDir = projectDir
val pkgJson = moduleDir.resolve("package.json")
val nodeModulesDir = moduleDir.resolve("node_modules")

// New modules may not have a package-lock.json yet — gradle-node-plugin
// requires one at config time. Stub it so the first install can run.
if (pkgJson.exists() && !moduleDir.resolve("package-lock.json").exists()) {
    moduleDir.resolve("package-lock.json").writeText("{}")
}

val npmInstallModule = tasks.register("npmInstallModule", NpmTask::class.java) {
    group = "lifecycle"
    description = "npm install --include=dev (resolves deps from registry, Verdaccio-aware)"
    npmCommand.set(listOf("install", "--include=dev", "--no-audit", "--no-fund"))
    workingDir.set(moduleDir)
    inputs.file(pkgJson).withPropertyName("packageJson")
    outputs.dir(nodeModulesDir)
    usesService(registryInjection)

    doFirst {
        val service = registryInjection.get()

        val stale = service.findStaleLocalhostEntries(rootProject.rootDir) { msg -> logger.lifecycle(msg) }
        if (stale.isNotEmpty()) {
            service.cleanupStale(rootProject.rootDir, stale) { msg -> logger.lifecycle(msg) }
        }

        if (service.isActive && service.needsApply(rootProject.rootDir) { msg -> logger.lifecycle(msg) }) {
            val overrides = service.apply { msg -> logger.lifecycle(msg) }
            for ((k, v) in overrides) {
                environment.put(k, v)
            }
        }
    }
}

// Order: `verifyNoLocalRegistry` runs first when both are in the graph,
// so a `--clean` cycle wipes localhost taint BEFORE install re-resolves.
npmInstallModule.configure {
    mustRunAfter(verifyNoLocalRegistry)
}

val npmInstallModuleRestore = tasks.register("npmInstallModuleRestore") {
    group = "lifecycle"
    description = "Clean up registry-injected tarballs after npmInstallModule"
    usesService(registryInjection)
    onlyIf { registryInjection.get().isActive }
    doLast {
        registryInjection.get().restore { msg -> logger.lifecycle(msg) }
    }
}
npmInstallModule.configure { finalizedBy(npmInstallModuleRestore) }

// ────────────────────────────────────────────────────────────
// Lifecycle skeleton
//
// Gradle's `base` plugin gives us `clean`, `build`, `check`, `assemble`.
// `build` already dependsOn `assemble + check` — we keep that contract
// and let `lint` hang off `check` (added by registerEslintLint).
//
// `compile` and `test` are appliance-specific umbrellas added below.
// They aren't part of `base`, so we register them here.
// ────────────────────────────────────────────────────────────
val compile = tasks.register("compile") {
    group = "lifecycle"
    description = "Compile module sources (lifecycle stub)"
}

// `build` (from `base`) becomes our final aggregator. Each `register*`
// extension wires its task into either `compile` or `check`, and `build`
// pulls them both in via `assemble`/`check`.
tasks.named("assemble") { dependsOn(compile) }

// `test` umbrella — register only if absent. `registerMochaTest` adds
// `testUnit` as a dependency.
if (tasks.findByName("test") == null) {
    tasks.register("test") {
        group = "verification"
        description = "Run all tests (no-op if no register* added a test task)"
    }
}
tasks.named("check") { dependsOn("test") }

// ────────────────────────────────────────────────────────────
// `clean` override — base's clean only deletes `build/`. Appliance
// modules need `dist/` and `tsconfig.tsbuildinfo` gone too.
// ────────────────────────────────────────────────────────────
tasks.named<Delete>("clean") {
    delete(moduleDir.resolve("dist"), moduleDir.resolve("tsconfig.tsbuildinfo"))
}

// ────────────────────────────────────────────────────────────
// `publish` — delegates to `zbb registry publish`. Reads the registry
// URL + auth from the active slot's `stacks/registry/.npmrc` (managed
// by `zbb registry start`). Republishing the same version overwrites
// (the "taint" mechanism) — we want that for local dev iteration.
// ────────────────────────────────────────────────────────────
tasks.register<Exec>("publish") {
    group = "publishing"
    description = "Publish module to the registry stack (Verdaccio) via zbb"
    dependsOn(tasks.named("build"))
    workingDir = moduleDir
    commandLine("zbb", "registry", "publish")
}
