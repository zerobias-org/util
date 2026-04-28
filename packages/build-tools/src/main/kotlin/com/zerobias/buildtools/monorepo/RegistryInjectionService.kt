package com.zerobias.buildtools.monorepo

import com.fasterxml.jackson.databind.ObjectMapper
import com.fasterxml.jackson.module.kotlin.readValue
import com.fasterxml.jackson.module.kotlin.registerKotlinModule
import org.gradle.api.file.DirectoryProperty
import org.gradle.api.services.BuildService
import org.gradle.api.services.BuildServiceParameters
import org.semver4j.Semver
import org.yaml.snakeyaml.Yaml
import java.io.File

/**
 * Detects when a zbb slot is loaded with a healthy local Verdaccio registry
 * stack and locally-published packages, then handles the state required to
 * make `npm install` resolve them from Verdaccio instead of the public
 * registry.
 *
 * Behavior:
 *
 * 1. **Scoped registry env vars.** Sets `npm_config_@<scope>:registry`
 *    env vars on the Exec spec for the install task — npm reads these
 *    and routes scoped packages to Verdaccio.
 *
 * 2. **Unconditional node_modules taint.** When apply fires, force-delete
 *    the published packages from `node_modules` so npm refetches them
 *    from Verdaccio. Logged when an expected dir is absent (the next
 *    npm install reinstalls it).
 *
 * 3. **Stamp invalidation.** `npm-pack.stamp` and `docker-image.stamp` in
 *    every subproject are deleted so dockerBuild + npmPack re-run with
 *    the freshly fetched local_deps.
 *
 * Trigger condition:
 *   - `ZB_SLOT` env var set
 *   - `~/.zbb/slots/<slot>/stacks/registry/state.yaml` has `status: healthy`
 *   - `~/.zbb/slots/<slot>/stacks/registry/.env` has `REGISTRY_URL=...`
 *   - `~/.zbb/slots/<slot>/stacks/registry/publishes.json` is non-empty
 *
 * Short-circuit: [needsApply] checks whether each `PublishedPackage` is
 * already correctly installed (right version on disk + lockfile entry
 * resolved to a localhost URL). When everything is already in order,
 * apply is a no-op and the lifecycle skips registry injection.
 *
 * Force-public override: gate tasks set [forcePublic] = true to suppress
 * injection entirely so the public registry is always used during gate
 * verification.
 *
 * Note: the lockfile is no longer moved/restored — local dev's
 * `package-lock.json` legitimately carries localhost URLs as working
 * state, and rewriting it during gate is handled by `verifyNoLocalRegistry`
 * + `-Pcleanlocalregistry`.
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

    /**
     * Lighter-weight check: is the slot's registry stack healthy?
     *
     * Distinct from [isActive] / [trigger] which ALSO require
     * `publishes.json` to be non-empty. This check is for routing-only
     * use cases (proxying upstream `npm install` through Verdaccio's
     * cache) where we don't care whether anything has been locally
     * published — we just want to know that the registry container is
     * reachable on the slot's compose network so a Docker build can
     * attach to it via `--network ${ZB_SLOT}_default`.
     */
    val isHealthy: Boolean by lazy { detectHealthy() }

    /**
     * Container-side URL for reaching Verdaccio from inside another
     * container on the same slot's compose network. Returns null when
     * the slot isn't loaded or the registry stack isn't healthy.
     *
     * Format: `http://${ZB_SLOT}-registry:4873`
     *
     * Distinct from the host-side `REGISTRY_URL` (which is something like
     * `http://localhost:15016`) — that one only works from the host shell,
     * not from inside a `docker build` container.
     */
    val internalRegistryUrl: String? by lazy { detectInternalRegistryUrl() }

    /**
     * `host.docker.internal`-flavored URL for reaching Verdaccio from
     * inside a `docker build` container that goes through the host
     * networking stack (rather than attaching to the slot's compose
     * network).
     *
     * Why we need this: BuildKit (the default Docker build engine since
     * Docker 23+) refuses arbitrary `--network <name>` modes for security
     * isolation. It only allows networks that were registered at builder
     * creation time. Attaching `--network local_default` to a buildx
     * build fails with "network mode … not supported by buildkit".
     *
     * The escape hatch: Verdaccio is already published on a host port
     * (`REGISTRY_PORT` in the registry stack's .env), so the build
     * container can reach it through the host's network stack via
     * `host.docker.internal`. The caller passes
     * `--add-host=host.docker.internal:host-gateway` so the name resolves
     * even on bare Linux (it works automatically on Docker Desktop).
     *
     * Returns null when the slot isn't loaded or the registry stack
     * isn't healthy.
     */
    val hostBridgeRegistryUrl: String? by lazy { detectHostBridgeRegistryUrl() }

    /** Slot name (`ZB_SLOT`) when set. Null otherwise. */
    val slotName: String? get() = System.getenv("ZB_SLOT")

    /** Compose project / network name for the active slot. Null when no slot. */
    val composeNetworkName: String? get() = slotName?.let { "${it}_default" }

    private fun detectHealthy(): Boolean {
        val slot = System.getenv("ZB_SLOT") ?: return false
        val home = System.getenv("HOME") ?: return false
        val stateFile = File(home, ".zbb/slots/$slot/stacks/registry/state.yaml")
        if (!stateFile.exists()) return false
        val state = try {
            Yaml().load<Map<String, Any?>>(stateFile.readText())
        } catch (_: Exception) { return false }
        return state["status"] == "healthy"
    }

    private fun detectInternalRegistryUrl(): String? {
        if (!isHealthy) return null
        val slot = System.getenv("ZB_SLOT") ?: return null
        // Try the stack's .env first — it's the source of truth and would
        // pick up any custom REGISTRY_INTERNAL_URL the user might have
        // overridden. Fall back to the canonical `${slot}-registry:4873`
        // format if the .env doesn't carry the var.
        val home = System.getenv("HOME") ?: return null
        val envFile = File(home, ".zbb/slots/$slot/stacks/registry/.env")
        if (envFile.exists()) {
            val fromEnv = envFile.readLines()
                .firstNotNullOfOrNull { line ->
                    Regex("^REGISTRY_INTERNAL_URL=(.+)$").find(line)?.groupValues?.get(1)
                }
            if (fromEnv != null) return fromEnv
        }
        return "http://$slot-registry:4873"
    }

    private fun detectHostBridgeRegistryUrl(): String? {
        if (!isHealthy) return null
        val slot = System.getenv("ZB_SLOT") ?: return null
        // Read REGISTRY_URL from the stack's .env — it's a host-side URL
        // like `http://localhost:15016` produced by the registry stack
        // when allocating its host port. Rewrite `localhost`/`127.0.0.1`
        // to `host.docker.internal` so the URL is reachable from inside
        // a docker build container that has --add-host configured.
        val home = System.getenv("HOME") ?: return null
        val envFile = File(home, ".zbb/slots/$slot/stacks/registry/.env")
        if (!envFile.exists()) return null
        val hostUrl = envFile.readLines()
            .firstNotNullOfOrNull { line ->
                Regex("^REGISTRY_URL=(.+)$").find(line)?.groupValues?.get(1)
            } ?: return null
        return hostUrl
            .replace("://localhost:", "://host.docker.internal:")
            .replace("://127.0.0.1:", "://host.docker.internal:")
    }

    // ── Trigger detection ────────────────────────────────────────────

    data class TriggerInfo(
        val slotName: String,
        val registryUrl: String,
        val publishes: List<PublishedPackage>,
    )

    data class PublishedPackage(val name: String, val version: String)

    private data class InjectionState(
        val taintedPackages: List<String>,
        val tarballsDir: File?,
        val invalidatedStamps: List<File>,
    )

    /**
     * When set, [apply] returns an empty map immediately — no node_modules
     * taint, no tarball download, no scope env vars. Gate tasks flip this
     * on so the gate run always exercises the public registry path.
     */
    @Volatile
    var forcePublic: Boolean = false

    /**
     * Trigger detection. Protected/open so test doubles can override
     * it without depending on env-var lookup. Production behavior is
     * unchanged.
     */
    @Suppress("UNCHECKED_CAST")
    protected open fun detectTrigger(): TriggerInfo? {
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
     * Apply registry injection: taint published packages, download tarballs,
     * write the manifest, invalidate stamps. Idempotent — if already applied,
     * no-op.
     *
     * Returns the env var overrides to set on the npm install Exec spec.
     *
     * When [forcePublic] is set (e.g. during gate), returns an empty map
     * immediately without touching anything.
     */
    fun apply(logger: ((String) -> Unit)? = null): Map<String, String> {
        if (forcePublic) return emptyMap()
        if (state != null) return npmEnvOverrides()
        val info = trigger ?: return emptyMap()
        val repoRoot = parameters.repoRoot.get().asFile

        // Filter out publishes whose version doesn't satisfy this workspace's
        // package.json constraint(s). Acting on those would force npm to
        // re-resolve via the env-var registry (Verdaccio's uplink), produce a
        // localhost-resolved lockfile entry that's actually a proxied public
        // version, and pollute working state. Skip cleanly with a logged note.
        val applicable = applicablePublishes(repoRoot, logger)
        if (applicable.isEmpty()) {
            logger?.invoke("[registry] no applicable publishes for this workspace — no-op")
            return emptyMap()
        }

        logger?.invoke("[registry] checking state for slot '${info.slotName}' → ${info.registryUrl}")
        logger?.invoke("[registry] ${applicable.size} applicable / ${info.publishes.size} ledgered locally-published packages")

        // Tracks whether any operation actually mutated state. Used to gate
        // stamp invalidation at the end — if nothing changed, don't bust the
        // build cache.
        var anyChange = false

        // ── Tarball cache (idempotent) ──
        // Download to .zbb-local-deps/ only when the file isn't already
        // there. The manifest.json the injectLocalDeps task reads still
        // needs an entry for every applicable package, regardless of
        // whether the tarball was cached or just downloaded.
        val tarballsDir = File(repoRoot, ".zbb-local-deps")
        tarballsDir.mkdirs()
        val downloaded = mutableListOf<Map<String, String>>()
        for (pkg in applicable) {
            val shortName = pkg.name.substringAfterLast('/')
            val tarballName = "$shortName-${pkg.version}.tgz"
            val tarballPath = File(tarballsDir, tarballName)
            if (tarballPath.exists() && tarballPath.length() > 0) {
                downloaded.add(mapOf(
                    "name" to pkg.name,
                    "version" to pkg.version,
                    "tarball" to tarballPath.absolutePath,
                ))
                continue
            }
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
                    anyChange = true
                } else {
                    logger?.invoke("[registry] WARNING: could not download ${pkg.name}@${pkg.version}")
                }
            } catch (e: Exception) {
                logger?.invoke("[registry] download failed for ${pkg.name}: ${e.message}")
            }
        }

        // ── Manifest (idempotent) ──
        // The injectLocalDeps task reads .zbb-local-deps/manifest.json to
        // decide which packages to inject into Docker contexts. Only rewrite
        // when the serialized content actually differs.
        if (downloaded.isNotEmpty()) {
            val manifestFile = File(tarballsDir, "manifest.json")
            val newManifest = mapper.writerWithDefaultPrettyPrinter().writeValueAsString(downloaded)
            val existing = if (manifestFile.exists()) manifestFile.readText() else null
            if (existing != newManifest) {
                manifestFile.writeText(newManifest)
                logger?.invoke("[registry] wrote ${manifestFile.name} with ${downloaded.size} entries")
                anyChange = true
            }
        }

        // ── Mutate package-lock.json (idempotent) ──
        // For each applicable package, rewrite every matching lockfile entry's
        // `version` + `resolved` to point at Verdaccio and drop `integrity`.
        // Without this, npm with a lockfile bypasses registry config entirely
        // and refetches from whatever URL the lockfile pinned (e.g. the public
        // mirror). Touching all keys ending in `/node_modules/<name>` covers
        // both the flattened top-level entry and any nested duplicates.
        //
        // Runs BEFORE the node_modules taint so we know which packages had
        // their lockfile entries rewritten — those packages MUST also be
        // tainted in node_modules even if their installed version still
        // matches, because the bytes on disk came from the old (now-rewritten)
        // source URL and need to be re-fetched from the new one.
        val lockfile = File(repoRoot, "package-lock.json")
        val mutatedLockEntries = mutableListOf<String>()
        val mutatedPackageNames = mutableSetOf<String>()
        if (lockfile.exists()) {
            try {
                @Suppress("UNCHECKED_CAST")
                val lockJson = mapper.readValue(lockfile, Map::class.java) as MutableMap<String, Any?>
                @Suppress("UNCHECKED_CAST")
                val packages = lockJson["packages"] as? MutableMap<String, Any?>
                if (packages == null) {
                    logger?.invoke("[registry] WARNING: package-lock.json has no 'packages' block (lockfileVersion 1?) — skipping mutation")
                } else {
                    for (pkg in applicable) {
                        val shortName = pkg.name.substringAfterLast('/')
                        val newResolved = "${info.registryUrl}/${pkg.name}/-/$shortName-${pkg.version}.tgz"
                        val matchingKeys = packages.keys.filter {
                            it == "node_modules/${pkg.name}" || it.endsWith("/node_modules/${pkg.name}")
                        }
                        if (matchingKeys.isEmpty()) {
                            logger?.invoke("[registry] note: ${pkg.name} not in lockfile — skipping mutation")
                            continue
                        }
                        for (key in matchingKeys) {
                            @Suppress("UNCHECKED_CAST")
                            val entry = packages[key] as? MutableMap<String, Any?> ?: continue
                            // Idempotent — skip when the entry is already
                            // (a) at the right version AND (b) pointing at the
                            // local registry AND (c) at the exact tarball URL
                            // we'd write.
                            val currentVersion = entry["version"] as? String
                            val currentResolved = entry["resolved"] as? String
                            val alreadyOnLocal = currentResolved != null && currentResolved.contains("localhost")
                            if (currentVersion == pkg.version && alreadyOnLocal && currentResolved == newResolved) {
                                continue
                            }
                            entry["version"] = pkg.version
                            entry["resolved"] = newResolved
                            entry.remove("integrity")
                            mutatedLockEntries.add(key)
                            mutatedPackageNames.add(pkg.name)
                            logger?.invoke("[registry] mutated lockfile entry $key → ${pkg.version} ($newResolved)")
                        }
                    }
                    if (mutatedLockEntries.isNotEmpty()) {
                        lockfile.writeText(mapper.writerWithDefaultPrettyPrinter().writeValueAsString(lockJson))
                        anyChange = true
                    }
                }
            } catch (e: Exception) {
                logger?.invoke("[registry] WARNING: could not mutate package-lock.json: ${e.message}")
            }
        } else {
            logger?.invoke("[registry] note: no package-lock.json — npm install will resolve via env-var registry")
        }

        // ── node_modules taint (idempotent) ──
        // Force-remove the package from node_modules if EITHER:
        //   (a) its installed version doesn't match the published one, OR
        //   (b) we just rewrote its lockfile entry's `resolved` URL — even
        //       if the version matches, the bytes on disk came from the old
        //       source and must be re-fetched from the new (localhost) one.
        //       Without this taint, npm install sees version match + lockfile
        //       entry intact and skips refetching, leaving stale bytes.
        val taintedPackages = mutableListOf<String>()
        for (pkg in applicable) {
            val modDir = File(repoRoot, "node_modules/${pkg.name}")
            if (!modDir.exists()) {
                logger?.invoke("[registry] note: ${pkg.name} absent from node_modules")
                continue
            }
            val installedPj = File(modDir, "package.json")
            val installedVersion: String? = if (installedPj.exists()) {
                try {
                    val pj: Map<String, Any?> = mapper.readValue(installedPj)
                    pj["version"] as? String
                } catch (_: Exception) { null }
            } else null
            val versionMismatch = installedVersion != pkg.version
            val lockfileMutated = pkg.name in mutatedPackageNames
            if (!versionMismatch && !lockfileMutated) {
                continue
            }
            modDir.deleteRecursively()
            taintedPackages.add(pkg.name)
            val reason = when {
                versionMismatch && lockfileMutated -> "was ${installedVersion ?: "unknown"}, expected ${pkg.version}; lockfile rewritten"
                versionMismatch -> "was ${installedVersion ?: "unknown"}, expected ${pkg.version}"
                else -> "lockfile rewritten — bytes on disk came from old source"
            }
            logger?.invoke("[registry] tainted ${pkg.name} ($reason)")
            anyChange = true
        }

        // ── Stamp invalidation (gated on anyChange) ──
        // Invalidate npm-pack.stamp and docker-image.stamp in subprojects
        // ONLY when something above actually mutated state. If everything
        // was already in order, busting these stamps would force needless
        // npm-pack + docker-image re-runs.
        val invalidatedStamps = mutableListOf<File>()
        if (anyChange) {
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
        } else {
            logger?.invoke("[registry] state already consistent — no changes needed")
        }

        state = InjectionState(
            taintedPackages = taintedPackages,
            tarballsDir = if (downloaded.isNotEmpty()) tarballsDir else null,
            invalidatedStamps = invalidatedStamps,
        )

        return npmEnvOverrides()
    }

    // ── Stale-localhost cleanup (independent of isActive) ────────────
    //
    // After `zbb registry clear`, this workspace's package-lock.json may
    // still carry localhost-resolved entries for packages that are no
    // longer in the registry. The bytes in node_modules are also from
    // those (now-gone) local builds. Without intervention, the workspace
    // would happily re-use the stale state forever.
    //
    // findStaleLocalhostEntries walks the lockfile looking for that case;
    // cleanupStale wipes node_modules + clears the lockfile entry's
    // `resolved`/`integrity` so the next `npm install` re-resolves through
    // the project .npmrc (i.e. the public registry, since no env-var
    // override is set when there's nothing applicable in publishes).
    //
    // Both methods work even when `isActive` is false (registry stack is
    // healthy but publishes.json is empty/missing) — that's the whole
    // point: stale state survives a clear.

    data class StaleLockfileEntry(
        val pkgName: String,
        val lockKey: String,
        val resolved: String,
    )

    /**
     * Find lockfile entries whose `resolved` URL contains "localhost" but
     * whose package name is NOT in the current publishes.json ledger.
     * These are leftovers from a prior local publish that's since been
     * cleared (or otherwise dropped).
     */
    @Suppress("UNCHECKED_CAST")
    fun findStaleLocalhostEntries(
        repoRoot: File,
        logger: ((String) -> Unit)? = null,
    ): List<StaleLockfileEntry> {
        val lockfile = File(repoRoot, "package-lock.json")
        if (!lockfile.exists()) return emptyList()
        val lockJson = try {
            mapper.readValue(lockfile, Map::class.java) as Map<String, Any?>
        } catch (_: Exception) { return emptyList() }
        val packages = lockJson["packages"] as? Map<String, Any?> ?: return emptyList()

        // Read publishes.json directly (not via TriggerInfo) so this works
        // even when isActive is false. Fall back to empty set if missing.
        val publishedNames: Set<String> = run {
            val slot = System.getenv("ZB_SLOT") ?: return@run emptySet()
            val home = System.getenv("HOME") ?: return@run emptySet()
            val publishesFile = File(home, ".zbb/slots/$slot/stacks/registry/publishes.json")
            if (!publishesFile.exists()) return@run emptySet()
            try {
                val raw: List<Map<String, Any?>> = mapper.readValue(publishesFile)
                raw.mapNotNull { it["name"] as? String }.toSet()
            } catch (_: Exception) { emptySet() }
        }

        val stale = mutableListOf<StaleLockfileEntry>()
        for ((key, value) in packages) {
            val entry = value as? Map<String, Any?> ?: continue
            val resolved = entry["resolved"] as? String ?: continue
            if (!resolved.contains("localhost")) continue
            // Extract package name from "node_modules/<scope>/<name>" or "node_modules/<name>"
            val name = key.substringAfter("node_modules/").takeIf { it != key } ?: continue
            if (name in publishedNames) continue   // covered by applicable/apply path
            stale.add(StaleLockfileEntry(pkgName = name, lockKey = key, resolved = resolved))
            logger?.invoke("[registry] stale: lockfile entry $key → $resolved (package not in publishes.json)")
        }
        return stale
    }

    /**
     * Wipe stale node_modules entries and clear the `resolved`/`integrity`
     * fields from their lockfile entries (keep `version`). The next
     * `npm install` resolves them fresh through the project .npmrc — which
     * routes to the public registry, since no env-var override is set for
     * stale-only scopes.
     */
    @Suppress("UNCHECKED_CAST")
    fun cleanupStale(
        repoRoot: File,
        stale: List<StaleLockfileEntry>,
        logger: ((String) -> Unit)? = null,
    ): Boolean {
        if (stale.isEmpty()) return false

        // 1. Taint node_modules for each stale package (dedup by name).
        for (pkgName in stale.map { it.pkgName }.distinct()) {
            val modDir = File(repoRoot, "node_modules/$pkgName")
            if (modDir.exists()) {
                modDir.deleteRecursively()
                logger?.invoke("[registry] tainted $pkgName (stale localhost reference, no longer in registry)")
            }
        }

        // 2. Clear lockfile entries.
        val lockfile = File(repoRoot, "package-lock.json")
        if (!lockfile.exists()) return true
        val lockJson = try {
            mapper.readValue(lockfile, Map::class.java) as MutableMap<String, Any?>
        } catch (e: Exception) {
            logger?.invoke("[registry] WARNING: could not read package-lock.json for stale cleanup: ${e.message}")
            return true
        }
        val packages = lockJson["packages"] as? MutableMap<String, Any?>
        if (packages == null) {
            logger?.invoke("[registry] WARNING: package-lock.json has no 'packages' block — skipping stale cleanup")
            return true
        }
        var mutated = false
        for (entry in stale) {
            // Remove the entire entry — not just resolved/integrity — because
            // the pinned `version` (e.g. "3.0.9") is a local-only publish that
            // doesn't exist on the public registry. Removing the entry lets npm
            // re-resolve from scratch using the range in package.json.
            if (packages.remove(entry.lockKey) != null) {
                mutated = true
                logger?.invoke("[registry] removed stale lockfile entry ${entry.lockKey}")
            }
        }
        if (mutated) {
            lockfile.writeText(mapper.writerWithDefaultPrettyPrinter().writeValueAsString(lockJson))
        }
        return true
    }

    // ── Restore (called from restore task, idempotent) ───────────────

    /**
     * Undo whatever apply() did. Idempotent — safe to call without an apply,
     * or twice in a row.
     *
     * Cleans the .zbb-local-deps/ tarball cache. Does NOT touch the
     * package-lock.json — local dev's lockfile legitimately carries
     * localhost URLs as working state.
     */
    fun restore(logger: ((String) -> Unit)? = null) {
        val s = state ?: return

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

    // ── applicablePublishes: filter publishes by package.json constraint ──

    /**
     * Filter `publishes.json` to only the entries whose published version
     * actually satisfies a constraint declared somewhere in this workspace's
     * package.json files (root + npm `workspaces` globs). Checked across
     * `dependencies`, `devDependencies`, `peerDependencies`, and
     * `optionalDependencies`.
     *
     * Why: publishing 3.0.8 to the local registry is irrelevant to a
     * workspace whose package.json pins `"3.0.6"` exactly — npm would
     * reject 3.0.8 and re-resolve through Verdaccio's uplink for 3.0.6,
     * which then taints the lockfile with a localhost-resolved URL that
     * isn't actually a local build. Better to skip such publishes
     * altogether.
     *
     * Skipped entries are logged with the reason ("not declared" or
     * "constraint X.Y.Z does not allow this version").
     */
    fun applicablePublishes(repoRoot: File, logger: ((String) -> Unit)? = null): List<PublishedPackage> {
        val info = trigger ?: return emptyList()
        val pjFiles = findAllPackageJsons(repoRoot)
        val applicable = mutableListOf<PublishedPackage>()
        for (pkg in info.publishes) {
            val constraints = collectConstraints(pjFiles, pkg.name)
            if (constraints.isEmpty()) {
                logger?.invoke("[registry] skip ${pkg.name}@${pkg.version}: not declared in package.json")
                continue
            }
            val matched = constraints.any { satisfies(pkg.version, it) }
            if (matched) {
                applicable.add(pkg)
            } else {
                logger?.invoke(
                    "[registry] skip ${pkg.name}@${pkg.version}: package.json constraint(s) ${constraints.joinToString()} do not allow this version",
                )
            }
        }
        return applicable
    }

    /** Read root package.json + each `workspaces:` glob target's package.json. */
    private fun findAllPackageJsons(repoRoot: File): List<File> {
        val out = mutableListOf<File>()
        val root = File(repoRoot, "package.json")
        if (!root.exists()) return out
        out.add(root)
        val rootJson: Map<String, Any?> = try {
            mapper.readValue(root)
        } catch (_: Exception) { return out }
        val workspaces = when (val ws = rootJson["workspaces"]) {
            is List<*> -> ws.filterIsInstance<String>()
            is Map<*, *> -> (ws["packages"] as? List<*>)?.filterIsInstance<String>() ?: emptyList()
            else -> emptyList()
        }
        for (glob in workspaces) {
            // Trivial glob support: "packages/*" → enumerate immediate dirs.
            // Anything fancier (recursive globs, brace expansion) we don't
            // need yet — npm conventions are mostly "<dir>/*" or literal path.
            if (glob.endsWith("/*")) {
                val parent = File(repoRoot, glob.dropLast(2))
                parent.listFiles { f -> f.isDirectory }?.forEach { wsDir ->
                    val pj = File(wsDir, "package.json")
                    if (pj.exists()) out.add(pj)
                }
            } else {
                val pj = File(repoRoot, "$glob/package.json")
                if (pj.exists()) out.add(pj)
            }
        }
        return out
    }

    /** Collect every dep constraint for `name` across the given package.json files. */
    private fun collectConstraints(pjFiles: List<File>, name: String): List<String> {
        val depKeys = listOf("dependencies", "devDependencies", "peerDependencies", "optionalDependencies")
        val constraints = mutableListOf<String>()
        for (pj in pjFiles) {
            val data: Map<String, Any?> = try {
                mapper.readValue(pj)
            } catch (_: Exception) { continue }
            for (key in depKeys) {
                @Suppress("UNCHECKED_CAST")
                val deps = data[key] as? Map<String, Any?> ?: continue
                val v = deps[name] as? String ?: continue
                constraints.add(v)
            }
        }
        return constraints
    }

    /** True if `version` satisfies the npm-style `range`. False on parse errors. */
    private fun satisfies(version: String, range: String): Boolean = try {
        Semver.coerce(version)?.satisfies(range) ?: false
    } catch (_: Exception) { false }

    // ── needsApply: short-circuit when state is already correct ──────

    /**
     * Returns true when injection should fire (something is stale or
     * resolved to the public registry). Returns false when every
     * applicable `PublishedPackage` (see [applicablePublishes]) already
     * passes ALL five checks:
     *
     *   1. `node_modules/<name>/package.json` exists
     *   2. its `version` field matches the expected published version
     *   3. project `package-lock.json` has an entry for `<name>`
     *   4. that lockfile entry's version matches the expected version
     *   5. the lockfile entry's `resolved` URL contains "localhost"
     *
     * Packages not present in the lockfile at all are skipped (they
     * aren't deps of this workspace). Anything else short-circuits the
     * caller's apply() with a no-op.
     */
    fun needsApply(repoRoot: File, logger: ((String) -> Unit)? = null): Boolean {
        val applicable = applicablePublishes(repoRoot, logger)
        if (applicable.isEmpty()) {
            logger?.invoke("[registry] no applicable publishes for this workspace — skipping injection")
            return false
        }
        val lockfile = File(repoRoot, "package-lock.json")
        if (!lockfile.exists()) return true

        val lockJson: Map<String, Any?> = try {
            mapper.readValue(lockfile)
        } catch (_: Exception) { return true }

        @Suppress("UNCHECKED_CAST")
        val packagesNode = lockJson["packages"] as? Map<String, Any?> ?: return true

        for (pkg in applicable) {
            val lockKey = "node_modules/${pkg.name}"
            @Suppress("UNCHECKED_CAST")
            val entry = packagesNode[lockKey] as? Map<String, Any?>
                // Not in lockfile — npm install will fetch fresh through the
                // env-var registry, which is the right thing.
                ?: continue

            // Check 4: lockfile version
            if (entry["version"] != pkg.version) return true

            // Check 5: lockfile resolved → localhost
            val resolved = entry["resolved"] as? String ?: return true
            if (!resolved.contains("localhost")) return true

            // Checks 1+2: node_modules/<name>/package.json + version
            val installed = File(repoRoot, "$lockKey/package.json")
            if (!installed.exists()) return true
            val installedJson: Map<String, Any?> = try {
                mapper.readValue(installed)
            } catch (_: Exception) { return true }
            if (installedJson["version"] != pkg.version) return true
        }

        return false
    }
}
