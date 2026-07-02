package com.zerobias.buildtools.appliance

import com.netflix.gradle.plugins.deb.Deb
import org.gradle.api.GradleException
import org.gradle.api.Project
import org.gradle.api.provider.Property
import org.gradle.kotlin.dsl.findByType
import org.gradle.kotlin.dsl.named
import org.gradle.kotlin.dsl.register
import java.io.File

// ────────────────────────────────────────────────────────────────────────
// BuildDeb — per-module appliance binary deb packaging.
//
// Used by `com/node/{cli,node,manager,ui}` (Phase 9.5). Each appliance
// binary module gets a `:<module>:buildDeb` task that produces:
//
//   <moduleDir>/build/distributions/<packageName>_${version}_all.deb
//
// containing:
//   /opt/node/<modName>/dist/...        (tsc/bun output — the JS payload)
//   /opt/node/<modName>/package.json    (npm metadata for runtime use)
//   /opt/node/bin/<binName>             (shell wrapper exec'ing /opt/node/bun)
//
// Architecture: all (TS-compiled JS, no native code in the wrapper layer).
// Depends: zerobias-node-modules (>= ${BUNDLE_VERSION}) — runtime npm deps
// ship via the shared deb (`com/node/shared`), not in the per-module deb.
//
// Postinst:
//   - systemctl daemon-reload
//   - systemctl try-restart <systemdUnit>     (optional, only if set)
//   - /usr/local/bin/zerobias-write-update-status <component> configure <ver>
//     (the os deb provides this script — guarded with `command -v` so the
//     postinst is harmless even if zerobias-node-os isn't installed yet)
//
// ────────────────────────────────────────────────────────────────────────
// Lib does NOT get its own deb. Its `dist/` ships INSIDE
// `zerobias-node-modules` because the bundle's `npm install` pulls in
// `@zerobias-com/hub-node-lib` from Verdaccio — see `com/node/shared/`.
// Only modules that set `applianceDeb { binPath = ... }` get a `buildDeb`
// task; lib never sets it.
//
// Convention: npm package `@zerobias-com/hub-FOO` → deb `zerobias-node-FOO`.
// Special case: `@zerobias-com/hub-node` → `zerobias-node` (no double suffix).
// Modules can override by setting `applianceDeb { packageName.set(...) }`
// explicitly.
// ────────────────────────────────────────────────────────────────────────

/**
 * Per-module configuration for the appliance binary deb packaging.
 *
 * Registered on every project applying `zb.typescript-base` (and the
 * pre-composed `-lib` / `-bundle` plugins that derive from it). Modules
 * that ship a binary set `binPath`, `binName`, and (usually) `packageName`.
 * The presence of `binPath` is what triggers the `buildDeb` task — modules
 * that leave it unset (libraries) don't get a deb task.
 */
abstract class ApplianceDebExtension {
    /**
     * Path within `dist/` to the JS entrypoint that the bin wrapper exec's.
     *
     * Example: `"src/bin/hub-node.js"` → wrapper exec's
     * `/opt/node/cli/dist/src/bin/hub-node.js`.
     *
     * Required to enable deb packaging. Unset = no `buildDeb` task.
     */
    abstract val binPath: Property<String>

    /**
     * Symlink name under `/opt/node/bin/` that operators invoke.
     *
     * Example: `"hub-cli"` → `/opt/node/bin/hub-cli`. Bun executes the
     * configured `binPath` JS underneath.
     */
    abstract val binName: Property<String>

    /**
     * Apt deb package name. Optional — defaults to a derivation from the
     * npm package name in package.json:
     *
     *   `@zerobias-com/hub-cli`  → `zerobias-node-cli`
     *   `@zerobias-com/hub-node` → `zerobias-node` (special-cased)
     *   `@zerobias-com/hub-FOO`  → `zerobias-node-FOO`
     *
     * Override when the npm name doesn't follow the pattern.
     */
    abstract val packageName: Property<String>

    /**
     * Optional systemd unit that the postinst should `try-restart` after a
     * successful configure. Leave unset for components without a systemd
     * unit (cli is per-command, node is started by manager, ui by getty).
     *
     * Example: `"node-manager.service"` → `systemctl try-restart node-manager.service`.
     */
    abstract val systemdUnit: Property<String>

    /**
     * Optional flag-file path. When set AND that file exists at configure time,
     * the postinst SKIPS the [systemdUnit] `try-restart` and logs that it
     * deferred instead. Generic mechanism for "some longer-running package
     * operation owns the restart/reboot boundary right now, so don't self-
     * restart mid-transaction." The path and the policy are the CONSUMER's —
     * build-tools only implements the `[ -e <path> ]` guard; it does not define
     * or write the flag. Unset = always restart (the default).
     *
     * Example: com/node sets `"/run/zerobias-lockstep-update"`, which its
     * whole-release update primitive writes for the life of an `apt-get upgrade`
     * that reboots at the end.
     */
    abstract val deferRestartWhilePresent: Property<String>
}

/**
 * Register the `buildDeb` task on a module.
 *
 * Reads the `applianceDeb` extension; aborts (no task registered) when
 * `binPath` is absent. Wired by `zb.typescript-lib` / `zb.typescript-bundle`
 * inside an `afterEvaluate` block so module configs can populate the
 * extension before this runs.
 */
fun Project.registerBuildDeb() {
    val ext = extensions.findByType<ApplianceDebExtension>()
        ?: error("registerBuildDeb: applianceDeb extension not registered. " +
            "Apply zb.typescript-base (or one of -lib/-bundle) first.")

    if (!ext.binPath.isPresent) return

    // Apply nebula.ospackage lazily — only for modules that actually package
    // a deb. zb.typescript-base intentionally does NOT apply it so libraries
    // (lib) don't surface a stub `buildDeb` task they'd never use.
    plugins.apply("com.netflix.nebula.ospackage")

    val moduleDir: File = projectDir
    val pkgJsonFile = moduleDir.resolve("package.json")
    if (!pkgJsonFile.exists()) {
        throw GradleException(
            "registerBuildDeb: ${pkgJsonFile.absolutePath} not found. " +
                "Appliance binary modules must have a package.json next to build.gradle.kts."
        )
    }

    // Module name = directory name (matches Gradle's project name auto-discovery
    // in com/node/settings.gradle.kts). Used as the on-disk install path
    // segment: /opt/node/<modName>/dist/...
    val modName: String = project.name

    // Read module npm version + name from package.json. Same minimal regex
    // parse as shared/build.gradle.kts (no JSON dep needed for two fields).
    val pkgJsonText: String = pkgJsonFile.readText()
    val npmVersion: String = Regex("\"version\"\\s*:\\s*\"([^\"]+)\"")
        .find(pkgJsonText)?.groupValues?.get(1)
        ?: throw GradleException("${pkgJsonFile.absolutePath} missing \"version\" field")
    val npmName: String = Regex("\"name\"\\s*:\\s*\"([^\"]+)\"")
        .find(pkgJsonText)?.groupValues?.get(1)
        ?: throw GradleException("${pkgJsonFile.absolutePath} missing \"name\" field")

    // Translate npm pre-release suffixes to dpkg's tilde syntax so apt
    // sorts pre-releases BELOW their stable upstream (1.0.1~rc1 < 1.0.1).
    // Same translation as shared/ + os/ build.gradle.kts.
    val debVer: String = npmVersion.replace(Regex("-(rc|beta|alpha|pre)"), "~\$1")

    // Default packageName: @zerobias-com/hub-FOO → zerobias-node-FOO.
    // Special-cased @zerobias-com/hub-node → zerobias-node (no -node-node).
    val defaultPkgName: String = run {
        val short = npmName.substringAfter('/')                // hub-cli
        val withoutHub = short.removePrefix("hub-")            // cli
        when {
            withoutHub == "node" -> "zerobias-node"            // hub-node → zerobias-node
            withoutHub.isNotEmpty() -> "zerobias-node-$withoutHub"
            else -> throw GradleException(
                "registerBuildDeb: cannot derive packageName from npm name '$npmName'. " +
                    "Set applianceDeb { packageName.set(\"...\") } explicitly."
            )
        }
    }
    val pkgName: String = ext.packageName.getOrElse(defaultPkgName)

    // BUNDLE_VERSION_AT_BUILD — read from shared/package.json (the
    // zerobias-node-modules deb's version source). Per the LTS appliance
    // model: per-binary debs declare `Depends: zerobias-node-modules
    // (>= ${BUNDLE_VERSION_AT_BUILD})` so apt orders the install correctly.
    //
    // Locate shared/ as a sibling of this module under the same Gradle root.
    // No fallback — if shared/package.json is missing, fail fast.
    val bundleVersion: String = run {
        val sharedPkg = rootProject.subprojects.firstOrNull { it.name == "shared" }
            ?.projectDir
            ?.resolve("package.json")
            ?: throw GradleException(
                "registerBuildDeb: cannot find :shared subproject. " +
                    "Per-module debs depend on zerobias-node-modules (built from shared/) " +
                    "and must read its version from shared/package.json."
            )
        if (!sharedPkg.exists()) {
            throw GradleException(
                "registerBuildDeb: ${sharedPkg.absolutePath} not found. " +
                    "Build zerobias-node-modules first (`:shared:buildDeb`) or check the layout."
            )
        }
        val sharedNpm = Regex("\"version\"\\s*:\\s*\"([^\"]+)\"")
            .find(sharedPkg.readText())?.groupValues?.get(1)
            ?: throw GradleException("${sharedPkg.absolutePath} missing \"version\" field")
        sharedNpm.replace(Regex("-(rc|beta|alpha|pre)"), "~\$1")
    }

    // Bin shim — tiny shell wrapper. Same convention as the hub-side
    // packaging: bun runs the JS under /opt/node/<mod>/dist/<binPath>.
    // The bun binary itself ships in zerobias-node-modules (or the os
    // foundation) — we don't have to provide it here.
    val binPathRel: String = ext.binPath.get()
    val binNameValue: String = ext.binName.get()
    val shimContents: String = """
        |#!/bin/sh
        |exec /opt/node/bun /opt/node/$modName/dist/$binPathRel "$@"
        |""".trimMargin()

    // Stage the shim into a build/-relative location. The actual write
    // happens in a generator task below — writing at configuration time
    // would race with `:clean`, which executes AFTER configuration and
    // wipes build/ along with the staged shim before the Deb task can
    // read it.
    val shimStageFile: File = layout.buildDirectory.dir("buildDeb/bin").get().asFile
        .resolve(binNameValue)

    // Postinst — written inline, matches os/ + hub-side pattern. Logs every
    // step via `logger -t postinst-<pkgName>` so failures surface in
    // `journalctl -t postinst-<pkgName>`. Optional systemd try-restart;
    // optional zerobias-write-update-status (provided by zerobias-node-os).
    val unit: String? = ext.systemdUnit.orNull
    val deferFlag: String? = ext.deferRestartWhilePresent.orNull
    val tryRestartBlock: String = if (unit != null) {
        // Optional consumer-owned guard: when a flag file is present, some
        // longer-running package operation owns the restart boundary, so skip
        // the self-restart. build-tools only implements the `[ -e ]` check; the
        // path/policy comes from the module's applianceDeb { deferRestartWhilePresent }.
        val restartStanza: String = if (deferFlag != null) {
            """
            |      if [ -e "$deferFlag" ]; then
            |        log "restart deferred while $deferFlag present"
            |      else
            |        log "systemctl try-restart $unit"
            |        systemctl try-restart $unit 2>/dev/null || true
            |      fi
            """.trimMargin()
        } else {
            """
            |      log "systemctl try-restart $unit"
            |      systemctl try-restart $unit 2>/dev/null || true
            """.trimMargin()
        }
        """
        |    if command -v systemctl >/dev/null 2>&1; then
        |      log "systemctl daemon-reload"
        |      systemctl daemon-reload || true
        |$restartStanza
        |    fi
        """.trimMargin()
    } else {
        """
        |    if command -v systemctl >/dev/null 2>&1; then
        |      log "systemctl daemon-reload"
        |      systemctl daemon-reload || true
        |    fi
        """.trimMargin()
    }

    // Component name passed to write-update-status — strips zerobias-node-
    // (or zerobias-) prefix so the log records 'cli', 'node', 'manager',
    // 'ui' — not the deb name. Special-case: zerobias-node → 'node'.
    val componentName: String = when {
        pkgName == "zerobias-node" -> "node"
        pkgName.startsWith("zerobias-node-") -> pkgName.removePrefix("zerobias-node-")
        else -> pkgName.removePrefix("zerobias-")
    }

    val postInstBody: String = """
        |#!/bin/sh
        |# Auto-generated postinst for $pkgName by build-tools' registerBuildDeb.
        |# Mirrors the os/ deb postinst pattern: logger-tagged, idempotent,
        |# tolerant of zerobias-node-os not yet being installed.
        |set -e
        |
        |LOG_TAG="postinst-$pkgName"
        |log() { logger -t "${'$'}LOG_TAG" -- "${'$'}*" || true; }
        |
        |case "${'$'}1" in
        |  configure)
        |    log "configure phase begin (version=${'$'}{DPKG_MAINTSCRIPT_PACKAGE_VERSION:-unknown})"
        |
        |$tryRestartBlock
        |
        |    if [ -x /usr/local/bin/zerobias-write-update-status ]; then
        |      UPDATE_CALLER="${'$'}LOG_TAG" UPDATE_STATUS="success" UPDATE_EXIT_CODE="0" \
        |        /usr/local/bin/zerobias-write-update-status \
        |          $componentName configure "${'$'}{DPKG_MAINTSCRIPT_PACKAGE_VERSION:-unknown}" || true
        |    fi
        |
        |    log "configure phase done"
        |    ;;
        |esac
        |
        |exit 0
        |""".trimMargin()

    // Postinst goes under build/buildDeb/. Same reason as shimStageFile
    // above: write happens in the generator task below, NOT at config
    // time. Otherwise `:clean` (which runs AFTER configuration) wipes
    // build/ before the Deb task gets a chance to read it.
    val postInstFile: File = layout.buildDirectory.dir("buildDeb").get().asFile
        .resolve("postinst.sh")

    // Generator task — writes both the bin shim and the postinst at
    // execution time. Inputs are the computed string contents; outputs
    // are the two files. Gradle UP-TO-DATEs correctly when nothing
    // changed, and the files are produced AFTER any clean dependency.
    val genStageName = "stageDebFiles${modName.replaceFirstChar { it.uppercase() }}"
    val genStage = tasks.register(genStageName) {
        group = "distribution"
        description = "Stage postinst.sh + bin shim for $pkgName under build/buildDeb/"
        inputs.property("shimContents", shimContents)
        inputs.property("postInstBody", postInstBody)
        outputs.file(shimStageFile)
        outputs.file(postInstFile)
        doLast {
            shimStageFile.parentFile.mkdirs()
            shimStageFile.writeText(shimContents)
            postInstFile.parentFile.mkdirs()
            postInstFile.writeText(postInstBody)
        }
    }

    // Output dir — NOT module/dist (that's tsc/bun output). Use Gradle's
    // canonical distributions dir under build/.
    val outDir = layout.buildDirectory.dir("distributions")

    // Dist + package.json sources.
    val distSourceDir: File = moduleDir.resolve("dist")
    val pkgJsonSource: File = pkgJsonFile

    // nebula.ospackage's plugin auto-registers a `buildDeb` lifecycle task
    // (rule-based aggregator). Using `buildDeb` as the name when registering
    // a concrete `Deb` instance collides with the rule. Same workaround as
    // com/node/shared/build.gradle.kts: register the real Deb task under a
    // module-suffixed name and wire the lifecycle `buildDeb` to depend on it.
    // Suffix derives from the module dir name (matches Gradle project name).
    val concreteDebName = "buildDeb${modName.replaceFirstChar { it.uppercase() }}"

    val concreteDeb = tasks.register<Deb>(concreteDebName) {
        group = "distribution"
        description =
            "Build $pkgName .deb (all-arch, version $debVer from $npmName@$npmVersion)"

        // Reproducible-build settings on AbstractArchiveTask. Explicit
        // setter form because Kotlin maps boolean is/set accessors to
        // "is*" property names, and `preserveFileTimestamps = false`
        // fails to resolve through the groovy-compiled Deb class chain.
        setPreserveFileTimestamps(false)
        setReproducibleFileOrder(true)

        // Wire to the upstream compile lifecycle so :buildDeb implies
        // tsc/bun has run and dist/ is current.
        dependsOn("compile")
        // The shim + postinst are generated under build/buildDeb/ — they
        // must exist before this task reads them via from(shimStageFile)
        // / postInstall(postInstFile).
        dependsOn(genStage)

        packageName = pkgName
        version = debVer
        archStr = "all"
        maintainer = "ZeroBias Platform <ops@zerobias.com>"
        packageDescription = "ZeroBias Hub Node — $pkgName ($npmName).\n" +
            "Installs to /opt/node/$modName/ + bin shim at /opt/node/bin/$binNameValue."

        // Per-binary debs depend on the bundled runtime node_modules tree.
        requires("zerobias-node-modules", ">= $bundleVersion")

        postInstall(postInstFile)

        // dist/ → /opt/node/<modName>/dist/. Skip tsc build-cache files.
        into("/opt/node/$modName/dist") {
            from(distSourceDir) {
                exclude("tsconfig.tsbuildinfo", "**/tsconfig.tsbuildinfo")
            }
        }

        // package.json → /opt/node/<modName>/package.json (runtime uses it
        // for version reporting, dependency resolution if Bun needs it).
        into("/opt/node/$modName") {
            from(pkgJsonSource)
        }

        // Bin shim → /opt/node/bin/<binName> at mode 0755.
        //
        // `CopySpec.fileMode` (Int) was deprecated in Gradle 8.3 and removed
        // in Gradle 9.0. build-tools' own wrapper is 8.10.2 (still has it) but
        // it's also pulled in as a composite build by packages on Gradle 9.x
        // (codegen, lite-filter) — there `fileMode` is an unresolved reference
        // and :build-tools:compileKotlin fails, taking those builds down with
        // it. `filePermissions { unix(...) }` exists since 8.3, so it compiles
        // on both.
        into("/opt/node/bin") {
            from(shimStageFile)
            filePermissions { unix("0755") }
        }

        destinationDirectory.set(outDir)

        // Reproducibility post-build — see repackDebDeterministic for why.
        doLast {
            project.repackDebDeterministic(archiveFile.get().asFile)
        }
    }

    // Wire nebula.ospackage's `buildDeb` lifecycle task to depend on our
    // concrete Deb task. Matches the convention used by shared/ + os/
    // build.gradle.kts. Running `:<module>:buildDeb` triggers
    // `:<module>:buildDeb<Module>` → produces the deb in build/distributions/.
    tasks.named("buildDeb") {
        group = "distribution"
        description =
            "Build $pkgName .deb (aggregator → $concreteDebName)"
        dependsOn(concreteDeb)
    }

    // Do NOT wire buildDeb into `build` — per the Phase 9.5 brief, buildDeb
    // is an explicit task, not a side effect of `:build`. The docker phase's
    // image-build aggregator depends on it directly.
}

/**
 * Post-process a built .deb so its bytes are a pure function of source
 * content (no filesystem mtimes, no traversal-order surprises).
 *
 * Why: nebula.ospackage / jdeb pass file mtimes through to data.tar
 * verbatim; the AbstractArchiveTask `setPreserveFileTimestamps(false)`
 * flag is silently ignored by nebula's DebCopyAction. Without this
 * post-process, two consecutive builds of identical sources produce
 * different data.tar bytes, breaking the tag-time → publish-time
 * payload-sha contract that :publishRelease enforces.
 *
 * Pure-JVM impl in DebRepack.kt — no shell-out, no GNU tar dep, runs
 * identically on Mac/Linux/Windows. Replaced the historical
 * scripts/repack-deb-deterministic.sh shell script that required gtar.
 *
 * Idempotent — running on an already-normalized deb produces identical
 * bytes.
 */
fun Project.repackDebDeterministic(deb: File) {
    if (!deb.exists()) {
        throw GradleException("repackDebDeterministic: $deb doesn't exist")
    }
    repackDebDeterministicJvm(deb)
}
