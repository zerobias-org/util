package com.zerobias.buildtools.monorepo

import com.fasterxml.jackson.databind.ObjectMapper
import com.fasterxml.jackson.module.kotlin.KotlinModule
import java.io.File

/**
 * Scans `package-lock.json` (and `node_modules/.package-lock.json`) for
 * dependency entries whose `resolved` URL points at `localhost`. Used by
 * the `verifyNoLocalRegistry` gate task — local-dev artifacts that
 * mustn't be committed.
 */
object LocalRegistryScanner {

    data class Offender(
        /** Source file the offender came from (e.g. `package-lock.json`). */
        val source: String,
        /** Lockfile entry key (e.g. `node_modules/@scope/foo`). */
        val key: String,
        /** Raw `resolved` URL that contains `localhost`. */
        val resolved: String,
    )

    private val mapper: ObjectMapper = ObjectMapper()
        .registerModule(KotlinModule.Builder().build())

    /**
     * Scan one or more lockfiles. Returns every entry whose `resolved` URL
     * contains the substring `localhost`. Missing or unparseable files are
     * skipped silently — they're not the gate's concern here.
     */
    fun scan(repoRoot: File): List<Offender> {
        val offenders = mutableListOf<Offender>()
        for (rel in listOf("package-lock.json", "node_modules/.package-lock.json")) {
            val file = File(repoRoot, rel)
            if (!file.exists()) continue
            val json: Map<String, Any?> = try {
                @Suppress("UNCHECKED_CAST")
                mapper.readValue(file, Map::class.java) as Map<String, Any?>
            } catch (_: Exception) { continue }
            @Suppress("UNCHECKED_CAST")
            val pkgs = json["packages"] as? Map<String, Any?> ?: continue
            for ((key, value) in pkgs) {
                @Suppress("UNCHECKED_CAST")
                val entry = value as? Map<String, Any?> ?: continue
                val resolved = entry["resolved"] as? String ?: continue
                if (resolved.contains("localhost")) {
                    offenders.add(Offender(file.name, key, resolved))
                }
            }
        }
        return offenders
    }

    /**
     * Build the GradleException message used when localhost URLs are
     * found and `-Pcleanlocalregistry` is NOT set. Two-block layout:
     * (a) why this is blocked, (b) two ways to fix.
     */
    fun buildFailureMessage(offenders: List<Offender>): String {
        val sample = offenders.take(10)
            .joinToString("\n") { "  - ${it.key} (${it.source}) -> ${it.resolved}" }
        val more = if (offenders.size > 10) "\n  ...and ${offenders.size - 10} more" else ""
        return buildString {
            appendLine("verifyNoLocalRegistry: package-lock.json contains localhost-resolved URLs.")
            appendLine()
            appendLine("Why this is blocked:")
            appendLine("  Lockfile entries pointing at http://localhost:* are zbb local-dev")
            appendLine("  artifacts (Verdaccio cache). They cannot be resolved on CI or by other")
            appendLine("  developers, so committing them breaks every downstream consumer of")
            appendLine("  this lockfile. Gate refuses to proceed.")
            appendLine()
            appendLine("Offenders (${offenders.take(10).size}/${offenders.size}):")
            appendLine(sample)
            if (more.isNotBlank()) appendLine(more.trimStart())
            appendLine()
            appendLine("Two ways to fix:")
            appendLine("  1. Auto-fix: `zbb gate --clean`. The build will wipe the offending")
            appendLine("     node_modules entries and reinstall against the public registry,")
            appendLine("     rewriting the lockfile.")
            appendLine("  2. Manual: `rm package-lock.json node_modules -rf && npm install` with")
            appendLine("     no zbb slot loaded (or `unset ZB_SLOT`), then commit the refreshed")
            appendLine("     lockfile.")
        }
    }

    /**
     * Wipe each offender's directory under `<repoRoot>/<key>` (when key
     * starts with `node_modules/`). Returns the keys actually deleted
     * (existing entries only).
     */
    fun cleanOffendingNodeModules(repoRoot: File, offenders: List<Offender>): List<String> {
        val cleaned = mutableSetOf<String>()
        for (o in offenders) {
            if (!o.key.startsWith("node_modules/")) continue
            val target = File(repoRoot, o.key)
            if (target.exists()) {
                target.deleteRecursively()
                cleaned.add(o.key)
            }
        }
        return cleaned.sorted()
    }

    /**
     * Remove offending entries from the lockfile's `packages` block entirely.
     * The pinned `version` is a local-only publish that doesn't exist on the
     * public registry, so clearing just `resolved`/`integrity` isn't enough —
     * npm would try to fetch the exact local version and fail with ETARGET.
     * Removing the whole entry lets `npm install` re-resolve from package.json's
     * version range.
     *
     * Processes both `package-lock.json` and `node_modules/.package-lock.json`.
     */
    @Suppress("UNCHECKED_CAST")
    fun cleanOffendingLockfileEntries(repoRoot: File, offenders: List<Offender>): Int {
        // Group offender keys by source file
        val bySource = offenders.groupBy { it.source }
        var totalRemoved = 0

        for ((source, entries) in bySource) {
            val lockfile = File(repoRoot, if (source == ".package-lock.json") "node_modules/.package-lock.json" else source)
            if (!lockfile.exists()) continue

            val lockJson: MutableMap<String, Any?> = try {
                mapper.readValue(lockfile, Map::class.java) as MutableMap<String, Any?>
            } catch (_: Exception) { continue }

            val packages = lockJson["packages"] as? MutableMap<String, Any?> ?: continue
            var mutated = false
            for (entry in entries) {
                if (packages.remove(entry.key) != null) {
                    mutated = true
                    totalRemoved++
                }
            }
            if (mutated) {
                lockfile.writeText(
                    mapper.writerWithDefaultPrettyPrinter().writeValueAsString(lockJson)
                )
            }
        }
        return totalRemoved
    }
}
