package com.zerobias.buildtools.monorepo

import com.fasterxml.jackson.databind.ObjectMapper
import com.fasterxml.jackson.module.kotlin.readValue
import com.fasterxml.jackson.module.kotlin.registerKotlinModule
import org.gradle.api.file.DirectoryProperty
import org.gradle.api.services.BuildService
import org.gradle.api.services.BuildServiceParameters
import org.yaml.snakeyaml.Yaml
import java.io.File
import java.nio.file.Files
import java.nio.file.StandardCopyOption

/**
 * Detects when a zbb slot is loaded with a healthy local Verdaccio registry
 * stack and locally-published packages, then handles all the state required
 * to make `npm install` resolve them from Verdaccio instead of the public
 * registry.
 *
 * Fixes 3 bugs that exist in `lib/stack/Stack.ts injectRegistryNpmrc`:
 *
 * 1. **Lockfile move (not copy).** Stack.ts uses `copyFile` which leaves the
 *    original lockfile in place — `npm install` then honors the original
 *    `resolved:` URLs (public registry) and bypasses Verdaccio. We use
 *    `Files.move` (rename) so npm has no lockfile and resolves fresh.
 *
 * 2. **Real npm registry override.** Stack.ts is named `injectRegistryNpmrc`
 *    but never actually writes an npmrc. We set `npm_config_@<scope>:registry`
 *    env vars on the Exec spec for the workspaceInstall task — npm reads these
 *    and routes scoped packages to Verdaccio.
 *
 * 3. **Unconditional taint.** Stack.ts only deletes node_modules entries that
 *    already exist (`if (existsSync(modDir))`) — cold-cache runs silently
 *    skip. We taint unconditionally and log when an expected dir is absent
 *    (the next npm install reinstalls it).
 *
 * Trigger condition (matches Stack.ts):
 *   - `ZB_SLOT` env var set
 *   - `~/.zbb/slots/<slot>/stacks/registry/state.yaml` has `status: healthy`
 *   - `~/.zbb/slots/<slot>/stacks/registry/.env` has `REGISTRY_URL=...`
 *   - `~/.zbb/slots/<slot>/stacks/registry/publishes.json` is non-empty
 *
 * State preserved across the build via `BuildService` so the restore task
 * can find what to undo even if the inject task crashed midway.
 */
abstract class RegistryInjectionService : BuildService<RegistryInjectionService.Params> {
    interface Params : BuildServiceParameters {
        val repoRoot: DirectoryProperty
    }

    private val mapper = ObjectMapper().registerKotlinModule()

    /**
     * Per-build mutable state — what we backed up so the restore task can
     * undo it. Volatile because acquire/release happens from different
     * task threads.
     */
    @Volatile
    private var state: InjectionState? = null

    /**
     * Detected trigger info (registry URL + published packages).
     * Lazy: only computed once per build, the first time anyone asks.
     */
    val trigger: TriggerInfo? by lazy { detectTrigger() }

    /** True if registry injection should fire for this build. */
    val isActive: Boolean get() = trigger != null

    // ── Trigger detection ────────────────────────────────────────────

    data class TriggerInfo(
        val slotName: String,
        val registryUrl: String,
        val publishes: List<PublishedPackage>,
    )

    data class PublishedPackage(val name: String, val version: String)

    private data class InjectionState(
        val lockfileBackup: File?,
        val taintedPackages: List<String>,
        val tarballsDir: File?,
        val invalidatedStamps: List<File>,
    )

    @Suppress("UNCHECKED_CAST")
    private fun detectTrigger(): TriggerInfo? {
        val slot = System.getenv("ZB_SLOT") ?: return null
        val home = System.getenv("HOME") ?: return null
        val stacksDir = File(home, ".zbb/slots/$slot/stacks/registry")

        val stateFile = File(stacksDir, "state.yaml")
        val envFile = File(stacksDir, ".env")
        val publishesFile = File(stacksDir, "publishes.json")
        if (!stateFile.exists() || !envFile.exists() || !publishesFile.exists()) {
            return null
        }

        // Verify the registry stack is healthy
        val state = try {
            Yaml().load<Map<String, Any?>>(stateFile.readText())
        } catch (_: Exception) { return null }
        if (state["status"] != "healthy") return null

        // Read REGISTRY_URL from .env
        val registryUrl = envFile.readLines()
            .firstNotNullOfOrNull { line ->
                Regex("^REGISTRY_URL=(.+)$").find(line)?.groupValues?.get(1)
            } ?: return null

        // Read publishes.json
        val publishes = try {
            val raw: List<Map<String, Any?>> = mapper.readValue(publishesFile)
            raw.mapNotNull { entry ->
                val name = entry["name"] as? String ?: return@mapNotNull null
                val version = entry["version"] as? String ?: return@mapNotNull null
                PublishedPackage(name, version)
            }
        } catch (_: Exception) { return null }

        if (publishes.isEmpty()) return null
        return TriggerInfo(slotName = slot, registryUrl = registryUrl, publishes = publishes)
    }

    // ── npm scope→registry env vars (bug fix #2) ─────────────────────

    /** npm registry env var overrides for scoped packages. Use on Exec specs. */
    fun npmEnvOverrides(): Map<String, String> {
        val info = trigger ?: return emptyMap()
        val scopes = listOf(
            "zerobias-com",
            "zerobias-org",
            "auditlogic",
            "auditmation",
            "devsupply",
        )
        return scopes.associate { scope ->
            "npm_config_@$scope:registry" to info.registryUrl
        }
    }

    // ── Apply (called from inject task) ──────────────────────────────

    /**
     * Apply registry injection: move the lockfile, taint packages, download
     * tarballs, write the manifest. Idempotent — if already applied, no-op.
     *
     * Returns the env var overrides to set on the npm install Exec spec.
     */
    fun apply(logger: ((String) -> Unit)? = null): Map<String, String> {
        if (state != null) return npmEnvOverrides()
        val info = trigger ?: return emptyMap()
        val repoRoot = parameters.repoRoot.get().asFile

        logger?.invoke("[registry] applying injection for slot '${info.slotName}' → ${info.registryUrl}")
        logger?.invoke("[registry] ${info.publishes.size} locally-published packages")

        // ── Bug fix #1: MOVE lockfile (not copy) ──
        val lockfile = File(repoRoot, "package-lock.json")
        var lockfileBackup: File? = null
        if (lockfile.exists()) {
            val backup = File(repoRoot, "package-lock.json.zbb-registry-backup")
            Files.move(lockfile.toPath(), backup.toPath(), StandardCopyOption.REPLACE_EXISTING)
            lockfileBackup = backup
            logger?.invoke("[registry] moved package-lock.json → ${backup.name}")
        }

        // Download tarballs to .zbb-local-deps/ (matches TS contract)
        val tarballsDir = File(repoRoot, ".zbb-local-deps")
        tarballsDir.mkdirs()
        val downloaded = mutableListOf<Map<String, String>>()
        for (pkg in info.publishes) {
            val shortName = pkg.name.substringAfterLast('/')
            val tarballName = "$shortName-${pkg.version}.tgz"
            val tarballPath = File(tarballsDir, tarballName)
            val url = "${info.registryUrl}/${pkg.name}/-/$shortName-${pkg.version}.tgz"
            try {
                val curl = ProcessBuilder("curl", "-sf", url, "-o", tarballPath.absolutePath)
                    .redirectErrorStream(true)
                    .start()
                val ok = curl.waitFor() == 0
                if (ok && tarballPath.exists()) {
                    downloaded.add(mapOf(
                        "name" to pkg.name,
                        "version" to pkg.version,
                        "tarball" to tarballPath.absolutePath,
                    ))
                    logger?.invoke("[registry] downloaded ${pkg.name}@${pkg.version}")
                } else {
                    logger?.invoke("[registry] WARNING: could not download ${pkg.name}@${pkg.version}")
                }
            } catch (e: Exception) {
                logger?.invoke("[registry] download failed for ${pkg.name}: ${e.message}")
            }
        }

        // Write the manifest.json that the per-package injectLocalDeps task reads
        if (downloaded.isNotEmpty()) {
            val manifestFile = File(tarballsDir, "manifest.json")
            manifestFile.writeText(mapper.writerWithDefaultPrettyPrinter().writeValueAsString(downloaded))
            logger?.invoke("[registry] wrote ${manifestFile.name} with ${downloaded.size} entries")
        }

        // ── Bug fix #3: UNCONDITIONAL taint ──
        // Force-remove the published packages from node_modules so npm install
        // refetches them from Verdaccio. Log when missing instead of silent skip.
        val taintedPackages = mutableListOf<String>()
        for (pkg in info.publishes) {
            val modDir = File(repoRoot, "node_modules/${pkg.name}")
            if (modDir.exists()) {
                modDir.deleteRecursively()
                taintedPackages.add(pkg.name)
                logger?.invoke("[registry] tainted ${pkg.name} (deleted from node_modules)")
            } else {
                logger?.invoke("[registry] note: ${pkg.name} not in node_modules — npm install will fetch from Verdaccio")
            }
        }

        // ── Bug fix #6: invalidate Gradle stamps so build re-runs ──
        // Invalidate npm-pack.stamp and docker-image.stamp in any subproject
        // that has them (so the dockerBuild + npmPack re-run with the new
        // local_deps).
        val invalidatedStamps = mutableListOf<File>()
        repoRoot.listFiles()?.filter { it.isDirectory }?.forEach { dir ->
            val buildDir = File(dir, "build")
            if (!buildDir.exists()) return@forEach
            for (stampName in listOf("npm-pack.stamp", "docker-image.stamp")) {
                val stamp = File(buildDir, stampName)
                if (stamp.exists()) {
                    stamp.delete()
                    invalidatedStamps.add(stamp)
                    logger?.invoke("[registry] invalidated ${dir.name}/build/$stampName")
                }
            }
        }

        state = InjectionState(
            lockfileBackup = lockfileBackup,
            taintedPackages = taintedPackages,
            tarballsDir = if (downloaded.isNotEmpty()) tarballsDir else null,
            invalidatedStamps = invalidatedStamps,
        )

        return npmEnvOverrides()
    }

    // ── Restore (called from restore task, idempotent) ───────────────

    /**
     * Undo whatever apply() did. Idempotent — safe to call without an apply,
     * or twice in a row.
     */
    fun restore(logger: ((String) -> Unit)? = null) {
        val s = state ?: return
        val repoRoot = parameters.repoRoot.get().asFile

        // Restore lockfile (also a move, not copy)
        val backup = s.lockfileBackup
        if (backup != null && backup.exists()) {
            val lockfile = File(repoRoot, "package-lock.json")
            try {
                Files.move(backup.toPath(), lockfile.toPath(), StandardCopyOption.REPLACE_EXISTING)
                logger?.invoke("[registry] restored package-lock.json")
            } catch (e: Exception) {
                logger?.invoke("[registry] WARNING: could not restore lockfile: ${e.message}")
            }
        }

        // Cleanup downloaded tarballs
        val tarballsDir = s.tarballsDir
        if (tarballsDir != null && tarballsDir.exists()) {
            try {
                tarballsDir.deleteRecursively()
                logger?.invoke("[registry] removed ${tarballsDir.name}")
            } catch (e: Exception) {
                logger?.invoke("[registry] WARNING: could not clean tarballs: ${e.message}")
            }
        }

        state = null
    }
}
