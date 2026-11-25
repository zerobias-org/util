/**
 * Workspace-level plugin for the module-gradle root project.
 *
 * Registers slot management tasks (listSlots, showSlot) at the workspace level
 * so they are available from the root project without needing to target a specific module.
 *
 * Also registers `versionStandardPackages` — the single-writer release-version
 * task that runs once per CI workflow before the publish matrix fans out. See
 * the task block below for context on why this exists.
 *
 * Usage (root build.gradle.kts only):
 *   plugins {
 *       id("zb.workspace")
 *   }
 *
 * Then run:
 *   ./gradlew listSlots
 *   ./gradlew showSlot -Pslot=local
 *   ./gradlew versionStandardPackages -PmodulesToVersion=foo/bar,baz/qux
 */

import com.zerobias.buildtools.module.ZbExtension
import com.zerobias.buildtools.tasks.ListSlotsTask
import com.zerobias.buildtools.tasks.ShowSlotTask
import com.zerobias.buildtools.util.ChangelogWriter
import com.zerobias.buildtools.util.ExecUtils
import com.zerobias.buildtools.util.VersionBumper

tasks.register("listSlots", ListSlotsTask::class.java, project)
tasks.register("showSlot", ShowSlotTask::class.java, project)

/**
 * Writes the release notes for one module of [versionStandardPackages] and stages them.
 *
 * The module's own Gradle project supplies its release tag prefix (`zb.vendor`/`zb.product`) and
 * its gate-stamp hasher (zb.base's `computeSourceHash`). CHANGELOG.md counts toward the stamp's
 * source hash when the package lists it in `files`, so a stamp that was current before the write
 * gets the new hash and is staged too. Notes must never turn a stamp the publish matrix would
 * accept into one it refuses: when the stamp isn't current as hashed here, or the directory has
 * no such project, CHANGELOG.md is left untouched and the module is released without notes.
 *
 * Never fails the version job: if anything here throws, CHANGELOG.md goes back to what it was
 * and the module is released without notes.
 *
 * @return the paths to stage, relative to the root (empty when nothing was written)
 */
fun writeReleaseNotes(
    dir: java.io.File,
    rel: String,
    previousVersion: String,
    newVersion: String,
    options: ChangelogWriter.Options,
): List<String> {
    if (!options.enabled) return emptyList()
    val changelogFile = dir.resolve(ChangelogWriter.FILE_NAME)
    val previousNotes = runCatching { if (changelogFile.exists()) changelogFile.readText() else null }.getOrNull()
    var written = false
    return try {
        val module = project.subprojects.firstOrNull { it.projectDir.canonicalFile == dir.canonicalFile }
        val extras = module?.extensions?.extraProperties
        @Suppress("UNCHECKED_CAST")
        val sourceHash = extras?.takeIf { it.has("computeSourceHash") }?.get("computeSourceHash") as? () -> String
        if (module == null || sourceHash == null) {
            logger.warn("[changelog] $rel: no zb.base project for this directory, so no notes for $newVersion")
            return emptyList()
        }
        val zb = module.extensions.findByType(ZbExtension::class.java)
        val tagPrefix = if (zb != null) "${zb.vendor.get()}-${zb.product.get()}-v" else "${dir.parentFile.name}-${dir.name}-v"
        val hashBefore = sourceHash()
        val changelog = ChangelogWriter.release(
            repoRoot = project.rootDir,
            packageDir = dir,
            tagPrefix = tagPrefix,
            previousVersion = previousVersion,
            newVersion = newVersion,
            options = options,
            info = { logger.lifecycle(it) },
            warn = { logger.warn(it) },
        ) ?: return emptyList()
        written = true
        val paths = mutableListOf(changelog.relativeTo(project.rootDir).path)

        val stampFile = dir.resolve("gate-stamp.json")
        val hashAfter = sourceHash()
        if (stampFile.exists() && hashAfter != hashBefore) {
            val stamp = stampFile.readText()
            val stampSourceHash = Regex(""""sourceHash"\s*:\s*"([^"]+)"""")
            if (stampSourceHash.find(stamp)?.groupValues?.get(1) != hashBefore) {
                ChangelogWriter.restore(project.rootDir, changelogFile, previousNotes)
                written = false
                logger.warn("[changelog] $rel: its gate stamp isn't current and covers CHANGELOG.md, so no notes for $newVersion")
                return emptyList()
            }
            stampFile.writeText(stamp.replace(stampSourceHash, """"sourceHash": "$hashAfter""""))
            paths += "$rel/gate-stamp.json"
            logger.lifecycle("[changelog] $rel: gate stamp's sourceHash updated for CHANGELOG.md")
        }
        paths
    } catch (e: Exception) {
        if (written) ChangelogWriter.restore(project.rootDir, changelogFile, previousNotes)
        logger.warn("[changelog] $rel: no notes for $newVersion: ${e.message}")
        emptyList()
    }
}

// ────────────────────────────────────────────────────────────
// versionStandardPackages — pre-matrix version bump for the standard path
// ────────────────────────────────────────────────────────────
//
// Every per-package publish (zb.base.gradle.kts) used to do its own
// bumpVersion → commitVersion → pushVersion, which raced against sibling
// matrix jobs all pushing to main. Even with retry-rebase, the failure
// mode was painful.
//
// This task collapses N per-package commits into one. It runs once on a
// single runner BEFORE the publish matrix fans out. The matrix then sees
// versions already committed and runs `zbb publish -PversionAlreadyCommitted=true`
// which skips its own commit/push.
//
// Input: -PmodulesToVersion=mod1/path,mod2/path (comma-separated relative
// paths under package/, matching the workflow's `detect` step output).
// Empty/missing → falls back to all subprojects with a package.json.
val versionStandardPackages by tasks.registering {
    group = "publish"
    description = "Bump versions for selected packages, commit + push as a single commit (pre-matrix release step)"

    doLast {
        val rootDir = project.rootDir
        val modulesArg = (project.findProperty("modulesToVersion") as? String)?.trim().orEmpty()
        val pushArg = (project.findProperty("push") as? String)?.toBoolean() ?: true

        // Resolve target package directories.
        //
        // - When -PmodulesToVersion is provided: each entry is a path relative
        //   to package/ (e.g. "github/github" → package/github/github). This
        //   matches the JSON shape the GitHub workflow's detect step emits.
        // - When empty: walk subprojects and pick anything with a package.json
        //   that's been changed since its last release tag — but that signal
        //   is already wired into bumpVersion's `changedSinceTag` per-module,
        //   so the caller is expected to provide the list explicitly. An
        //   empty caller-list is treated as "nothing to do" rather than "everything".
        val targets: List<java.io.File> = if (modulesArg.isEmpty()) {
            logger.lifecycle("[version] -PmodulesToVersion not set — nothing to do")
            return@doLast
        } else {
            modulesArg.split(",").mapNotNull { rel ->
                val cleaned = rel.trim().trim('/', ' ')
                if (cleaned.isEmpty()) return@mapNotNull null
                val dir = rootDir.resolve("package").resolve(cleaned)
                if (!dir.resolve("package.json").exists()) {
                    logger.warn("[version] no package.json at $dir — skipping")
                    null
                } else dir
            }
        }
        if (targets.isEmpty()) {
            logger.lifecycle("[version] no valid targets — exiting")
            return@doLast
        }

        // Compute bump decisions and apply each in turn. Decisions are stable:
        // re-running with the same registry state produces the same bumps, so
        // an interrupted run can be safely retried.
        data class Applied(val name: String, val rel: String, val from: String, val to: String, val bumped: Boolean, val notes: Boolean)
        val applied = mutableListOf<Applied>()
        val staged = mutableListOf<String>()
        val changelogOptions = ChangelogWriter.Options.from { project.findProperty(it) }
        for (dir in targets) {
            val rel = dir.relativeTo(rootDir).path
            val decision = VersionBumper.decide(dir)
            if (decision == null) {
                logger.warn("[version] $rel: cannot read name/version — skipping")
                continue
            }
            val notes = writeReleaseNotes(dir, rel, decision.currentVersion, decision.newVersion, changelogOptions)
            staged.addAll(notes)
            if (decision.bumped) {
                VersionBumper.writeVersion(dir, decision.newVersion)
                staged.add("$rel/package.json")

                // Refresh gate-stamp.json so the committed stamp matches the
                // version about to ship. Pure regex pass — same as zb.base
                // commitVersion does locally — keeps the file's structure intact.
                val stampFile = dir.resolve("gate-stamp.json")
                if (stampFile.exists()) {
                    val stampContent = stampFile.readText()
                    val updatedStamp = stampContent
                        .replace(Regex("""\s*"timestamp"\s*:\s*"[^"]+",?\n"""), "\n")
                        .replace(Regex(""""version"\s*:\s*"[^"]+""""), """"version": "${decision.newVersion}"""")
                    if (updatedStamp != stampContent) {
                        stampFile.writeText(updatedStamp)
                        staged.add("$rel/gate-stamp.json")
                    }
                }
                applied.add(Applied(decision.name, rel, decision.currentVersion, decision.newVersion, true, notes.isNotEmpty()))
                logger.lifecycle("[version] $rel: ${decision.currentVersion} → ${decision.newVersion}")
            } else {
                applied.add(Applied(decision.name, rel, decision.currentVersion, decision.currentVersion, false, notes.isNotEmpty()))
                logger.lifecycle("[version] $rel: ${decision.currentVersion} (not yet published — keeping as-is)")
            }
        }

        if (staged.isEmpty()) {
            logger.lifecycle("[version] no version changes needed — exiting (no commit, no push)")
            return@doLast
        }

        // Single commit covering every bumped package. Message lists what was
        // bumped so the commit is self-describing in `git log`.
        ExecUtils.exec(
            command = listOf("git", "add") + staged,
            workingDir = rootDir,
            throwOnError = true,
        )
        val stagedCheck = ExecUtils.execCapture(
            command = listOf("git", "diff", "--cached", "--name-only"),
            workingDir = rootDir,
            throwOnError = false,
        ).trim()
        if (stagedCheck.isEmpty()) {
            logger.lifecycle("[version] nothing actually staged after writes — exiting")
            return@doLast
        }
        // A module is in the release commit when it was bumped or got release notes.
        val released = applied.filter { it.bumped || it.notes }
        val commitSubject = if (released.size == 1) {
            val one = released.first()
            "chore(release): ${one.name} v${one.to}"
        } else {
            "chore(release): " + released.joinToString(", ") { "${it.name}@${it.to}" }
        }
        ExecUtils.exec(
            command = listOf("git", "commit", "-m", commitSubject),
            workingDir = rootDir,
            throwOnError = true,
        )
        logger.lifecycle("[version] committed: $commitSubject")

        if (!pushArg) {
            logger.lifecycle("[version] -Ppush=false — skipping push (commit stays local)")
            return@doLast
        }

        // Single push, with the same retry-rebase used to live in pushVersion.
        // The race surface is now exactly one writer per workflow run, so this
        // loop only fires when ANOTHER workflow (e.g. a sibling branch) lands
        // on main between fetch and push. Failing loudly on exhaustion is
        // correct — silent half-state would leave npm and git out of sync.
        val maxAttempts = 5
        var lastError: Exception? = null
        for (attempt in 1..maxAttempts) {
            try {
                ExecUtils.exec(
                    command = listOf("git", "push"),
                    workingDir = rootDir,
                    throwOnError = true,
                )
                logger.lifecycle("[version] pushed (attempt $attempt)")
                return@doLast
            } catch (e: Exception) {
                lastError = e
                logger.warn("[version] push attempt $attempt/$maxAttempts failed: ${e.message}")
                if (attempt == maxAttempts) break

                try {
                    ExecUtils.exec(
                        command = listOf("git", "pull", "--rebase", "origin", "main"),
                        workingDir = rootDir,
                        throwOnError = true,
                    )
                    logger.lifecycle("[version] rebased onto origin/main; retrying push")
                } catch (rebaseErr: Exception) {
                    ExecUtils.exec(
                        command = listOf("git", "rebase", "--abort"),
                        workingDir = rootDir,
                        throwOnError = false,
                    )
                    throw GradleException(
                        "versionStandardPackages: rebase failed after push rejection — manual reconciliation required: ${rebaseErr.message}",
                        rebaseErr
                    )
                }
                Thread.sleep(500L * attempt + (Math.random() * 250).toLong())
            }
        }
        throw GradleException(
            "versionStandardPackages: push failed after $maxAttempts attempts: ${lastError?.message}",
            lastError
        )
    }
}
