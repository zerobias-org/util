package com.zerobias.buildtools.monorepo

import com.fasterxml.jackson.databind.ObjectMapper
import com.fasterxml.jackson.module.kotlin.KotlinModule
import java.io.File

/**
 * Scans workspace packages for artifacts left behind by an interrupted
 * `prepublishPackage` run. Used by the `verifyNoPrepublishLeftover` gate task.
 *
 * `Prepublish.resolve()` mutates a package's package.json with hoisted root deps
 * + overrides as a temporary step before `npm publish`. The mutation is supposed
 * to be undone by `restorePackage` (finalizedBy). If a publish run is
 * interrupted (Ctrl-C, network failure, skipped task), the mutated state can
 * end up committed — the dataloader package.json drift is the canonical case.
 *
 * Two signals indicate a leftover prepublish state:
 *   1. A `package.json.prepublish-backup` file exists alongside a workspace
 *      package.json — this is the backup `Prepublish.createBackup()` writes.
 *      Its presence means restore never ran.
 *   2. A non-root workspace `package.json` declares an `overrides` block —
 *      `overrides` is npm-root-only metadata; `Prepublish.resolve()` copies it
 *      into per-package files as part of its mutation. A workspace package with
 *      its own overrides is almost always a leftover prepublish artifact.
 */
object PrepublishLeftoverScanner {

    data class Offender(
        /** Workspace package directory (relative to repo root). */
        val packageDir: String,
        /** Reason this entry is flagged. */
        val reason: Reason,
        /** Extra context for the failure message (e.g. number of overrides). */
        val detail: String,
    )

    enum class Reason {
        /** A .prepublish-backup file exists — `restorePackage` never ran. */
        BACKUP_FILE_PRESENT,
        /** Non-root package.json has an `overrides` block. */
        OVERRIDES_IN_PACKAGE,
    }

    private val mapper: ObjectMapper = ObjectMapper()
        .registerModule(KotlinModule.Builder().build())

    /**
     * Scan every workspace package under [repoRoot] for prepublish leftovers.
     * Workspaces are read from the root package.json's `workspaces` array.
     * The root itself is intentionally excluded — it's the canonical home for
     * `overrides` and isn't subject to the prepublish mutation flow.
     */
    fun scan(repoRoot: File): List<Offender> {
        val offenders = mutableListOf<Offender>()
        val rootPkgFile = File(repoRoot, "package.json")
        if (!rootPkgFile.exists()) return offenders

        val rootPkg: Map<String, Any?> = try {
            @Suppress("UNCHECKED_CAST")
            mapper.readValue(rootPkgFile, Map::class.java) as Map<String, Any?>
        } catch (_: Exception) { return offenders }

        @Suppress("UNCHECKED_CAST")
        val workspaceGlobs = (rootPkg["workspaces"] as? List<String>) ?: emptyList()

        for (glob in workspaceGlobs) {
            for (pkgDir in expandWorkspaceGlob(repoRoot, glob)) {
                val pkgFile = File(pkgDir, "package.json")
                if (!pkgFile.exists()) continue

                val backupFile = File(pkgDir, "package.json.prepublish-backup")
                if (backupFile.exists()) {
                    offenders.add(Offender(
                        packageDir = pkgDir.relativeTo(repoRoot).path,
                        reason = Reason.BACKUP_FILE_PRESENT,
                        detail = "package.json.prepublish-backup exists",
                    ))
                }

                val pkg: Map<String, Any?> = try {
                    @Suppress("UNCHECKED_CAST")
                    mapper.readValue(pkgFile, Map::class.java) as Map<String, Any?>
                } catch (_: Exception) { continue }

                @Suppress("UNCHECKED_CAST")
                val overrides = pkg["overrides"] as? Map<String, Any?>
                if (overrides != null && overrides.isNotEmpty()) {
                    val noun = if (overrides.size == 1) "entry" else "entries"
                    offenders.add(Offender(
                        packageDir = pkgDir.relativeTo(repoRoot).path,
                        reason = Reason.OVERRIDES_IN_PACKAGE,
                        detail = "${overrides.size} override $noun",
                    ))
                }
            }
        }
        return offenders
    }

    // Expand a workspace glob to concrete directories. Supports literal names
    // (e.g. `core`) and single-level wildcards (e.g. `packages/<wildcard>`).
    // Anything else is best-effort.
    private fun expandWorkspaceGlob(repoRoot: File, glob: String): List<File> {
        if (!glob.contains("*")) {
            val dir = File(repoRoot, glob)
            return if (dir.isDirectory) listOf(dir) else emptyList()
        }
        // Single-level wildcard at the end
        if (glob.endsWith("/*")) {
            val parent = File(repoRoot, glob.dropLast(2))
            if (!parent.isDirectory) return emptyList()
            return parent.listFiles { f -> f.isDirectory }?.toList() ?: emptyList()
        }
        return emptyList()
    }

    /**
     * Build the GradleException message used when leftovers are found. Two
     * blocks: (a) why this is blocked, (b) how to fix.
     */
    fun buildFailureMessage(offenders: List<Offender>): String {
        val sb = StringBuilder()
        sb.appendLine()
        sb.appendLine("✗ prepublish leftovers detected — package.json mutations from an interrupted publish")
        sb.appendLine("  must not be committed. They drift root deps + overrides into per-package files,")
        sb.appendLine("  which breaks downstream consumers and workspace hoisting.")
        sb.appendLine()

        val byPackage = offenders.groupBy { it.packageDir }
        for ((pkgDir, list) in byPackage.entries.sortedBy { it.key }) {
            sb.appendLine("  $pkgDir/package.json:")
            for (off in list) {
                val tag = when (off.reason) {
                    Reason.BACKUP_FILE_PRESENT -> "leftover backup"
                    Reason.OVERRIDES_IN_PACKAGE -> "overrides block"
                }
                sb.appendLine("    - $tag: ${off.detail}")
            }
        }
        sb.appendLine()
        sb.appendLine("  To fix:")
        sb.appendLine("    1. Restore each affected package.json to its committed state:")
        sb.appendLine("         git checkout -- <package>/package.json")
        sb.appendLine("    2. Remove any leftover backup files:")
        sb.appendLine("         find . -name 'package.json.prepublish-backup' -not -path './node_modules/*' -delete")
        sb.appendLine("    3. Re-run the gate.")
        sb.appendLine()
        return sb.toString()
    }
}
