package com.zerobias.buildtools.util

import com.fasterxml.jackson.databind.ObjectMapper
import com.fasterxml.jackson.module.kotlin.readValue
import com.fasterxml.jackson.module.kotlin.registerKotlinModule
import java.io.File
import java.time.LocalDate
import java.time.ZoneOffset

/**
 * Writes a package's release notes into its CHANGELOG.md from the conventional commits made
 * since its previous release tag.
 *
 * **What a change is.** The history from the previous release to HEAD is walked along the
 * first-parent line, and each commit on it is one change:
 * - a squash-merged PR, whose subject is the PR title with ` (#N)`;
 * - a GitHub merge commit, whose PR title is the first line of the merge body;
 * - a commit pushed straight to main.
 *
 * A merge that is not a GitHub PR merge (a local `git merge`, or a `git pull` that merged) is
 * opened up, and the first-parent commits it brought in are judged one by one. A PR's own
 * commits, its WIP and "merge main" commits never show.
 *
 * **What counts for this package.** A change counts only if it changed files in the package
 * directory. These don't count:
 * - the gate stamp, lockfiles, Markdown, `test/` and `.github`/`.claude`;
 * - a package.json edit that changes only the version or dependency versions. A change made
 *   up of that alone is a dependency update.
 *
 * **What is listed.**
 * - Listed: `feat`, `fix`, `perf` and `revert`, plus anything breaking (`!` or a
 *   `BREAKING CHANGE:` footer), which also goes under BREAKING CHANGES whatever its type.
 * - Listed only with [Options.includeDependencies]: dependency updates (type or scope `deps`,
 *   or a dependency-only diff).
 * - Left out: `chore(release)` commits, `[skip ci]` commits, every other type, and messages
 *   that aren't conventional. A PR merge whose title isn't conventional falls back to its
 *   branch prefix (`fix/…`).
 * - A revert and the change it reverts cancel out when both are in the range.
 *
 * When nothing is left, no section is written, so versions without user-facing changes have no
 * entry and no "version bump only" noise.
 *
 * Everything comes from git, so a local `zbb publish` writes the same notes as CI. The section
 * uses conventional-changelog's `## [version](compare) (date)` heading, which
 * [ReleaseAnnouncement.firstChangelogBlock] reads.
 */
object ChangelogWriter {

    /** Per-repo switches, from the `zb.changelog` and `zb.changelog.dependencies` Gradle properties. */
    data class Options(
        val enabled: Boolean = true,
        val includeDependencies: Boolean = false,
    ) {
        companion object {
            /** Reads the switches from [property] (Gradle's `findProperty`): on by default, dependencies off. */
            fun from(property: (String) -> Any?): Options = Options(
                enabled = property("zb.changelog")?.toString()?.trim()?.toBoolean() ?: true,
                includeDependencies = property("zb.changelog.dependencies")?.toString()?.trim()?.toBoolean() ?: false,
            )
        }
    }

    /** Release-note sections, in the order they are written. */
    enum class Section(val heading: String) {
        BREAKING("⚠ BREAKING CHANGES"),
        FEATURES("Features"),
        FIXES("Bug Fixes"),
        PERFORMANCE("Performance Improvements"),
        REVERTS("Reverts"),
        DEPENDENCIES("Dependencies"),
    }

    /** One line of release notes. */
    data class Entry(
        val section: Section,
        val scope: String?,
        val text: String,
        val sha: String,
        val pr: Int?,
    )

    /** A change that touched the package but was left out, and why. */
    data class Skipped(val sha: String, val subject: String, val reason: String)

    /** The entries for a release and the changes left out of it. */
    data class Notes(val entries: List<Entry>, val skipped: List<Skipped>)

    /** A parsed conventional-commit header: `type(scope)!: subject`. */
    data class Header(val type: String, val scope: String?, val breaking: Boolean, val subject: String)

    private data class Change(
        val sha: String,
        val message: String,
        val pr: Int?,
        val branch: String?,
        val from: String?,
    ) {
        val subject: String get() = message.lineSequence().first().trim()
    }

    private data class Commit(val sha: String, val parents: List<String>, val message: String) {
        val subject: String get() = message.lineSequence().first().trim()
        val body: String get() = message.substringAfter('\n', "").trim()
    }

    const val FILE_NAME = "CHANGELOG.md"
    private const val TITLE = "# Changelog"
    private const val INTRO = "Versions with no feature, fix, performance or breaking change have no entry."
    private const val EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904"
    private const val MAX_MERGE_DEPTH = 5

    private val HEADER = Regex("""^(\w+)(?:\(([^()]*)\))?(!)?:\s+(.+)$""")
    private val BREAKING_FOOTER = Regex("""^BREAKING[ -]CHANGE:\s*(.+)$""", RegexOption.MULTILINE)
    private val SQUASH_PR = Regex("""\s+\(#(\d+)\)$""")
    private val PR_MERGE = Regex("""^Merge pull request #(\d+) from (\S+)""")
    private val GIT_REVERT = Regex("""^Revert "(.+)"$""")
    private val REVERTED_SHA = Regex("""This reverts commit ([0-9a-f]{7,40})""")
    private val REVERTED_PR = Regex("""Reverts [\w.-]+/[\w.-]+#(\d+)""")
    private val SKIP_CI = Regex("""\[(skip ci|ci skip)]""", RegexOption.IGNORE_CASE)
    private val KNOWN_TYPES = setOf("feat", "fix", "perf", "revert", "refactor", "chore", "docs", "test", "build", "ci", "style", "deps")
    private val IGNORED_NAMES = setOf("gate-stamp.json", "package-lock.json", "npm-shrinkwrap.json")
    private val IGNORED_TOP_DIRS = setOf("test", "tests", "__tests__", ".github", ".claude")
    private val DEPENDENCY_FIELDS = listOf("dependencies", "devDependencies", "peerDependencies", "optionalDependencies")
    private val RUNTIME_DEPENDENCY_FIELDS = listOf("dependencies", "peerDependencies", "optionalDependencies")
    private val RELEASE_OWNED_FILES = setOf("package.json", "gate-stamp.json", FILE_NAME, "package-lock.json")
    private val MAPPER = ObjectMapper().registerKotlinModule()

    /**
     * Writes the section for [newVersion] into the package's CHANGELOG.md, called by the
     * standard-mode release commit (`commitVersion`, `versionStandardPackages`) before staging.
     *
     * The previous release is `<tagPrefix><previousVersion>`, fetched from origin when a local
     * clone lacks it; without it, the latest earlier `<tagPrefix>*` tag is used. A package with
     * no earlier release tag gets no notes. It also warns when the package has uncommitted
     * changes, since they would ship without a commit to describe them.
     *
     * Never throws: any failure goes to [warn] and the release carries on without notes.
     *
     * @return the CHANGELOG.md to stage when it now differs from HEAD, else null
     */
    fun release(
        repoRoot: File,
        packageDir: File,
        tagPrefix: String,
        previousVersion: String?,
        newVersion: String,
        options: Options,
        info: (String) -> Unit,
        warn: (String) -> Unit,
        date: LocalDate = LocalDate.now(ZoneOffset.UTC),
        repoUrl: String? = repositoryUrl(repoRoot),
    ): File? {
        if (!options.enabled) return null
        val label = packageDir.relativeTo(repoRoot).invariantSeparatorsPath.ifEmpty { "." }
        return try {
            val dirty = uncommittedChanges(repoRoot, packageDir)
            if (dirty.isNotEmpty()) {
                warn("[changelog] $label: uncommitted changes ship with this release, and no commit describes them: ${dirty.joinToString(", ")}")
            }
            val baseTag = resolveBaseTag(repoRoot, tagPrefix, previousVersion, newVersion, warn)
            if (baseTag == null) {
                info("[changelog] $label: no earlier $tagPrefix* release tag, so no notes for $newVersion")
                return null
            }
            val notes = collect(repoRoot, packageDir, baseTag, options.includeDependencies)
            notes.skipped.forEach { info("[changelog] $label: left out ${it.sha.take(9)} \"${it.subject}\": ${it.reason}") }
            if (notes.entries.isEmpty()) {
                info("[changelog] $label: nothing to list since $baseTag")
                return null
            }
            val file = File(packageDir, FILE_NAME)
            val existing = if (file.exists()) file.readText() else ""
            val updated = insert(existing, render(newVersion, date, baseTag, tagPrefix + newVersion, repoUrl, notes.entries), newVersion)
            if (updated != existing) file.writeText(updated)
            info("[changelog] $label: ${notes.entries.size} change(s) since $baseTag listed for $newVersion")
            if (differsFromHead(repoRoot, file)) file else null
        } catch (e: Exception) {
            warn("[changelog] $label: no notes written for $newVersion: ${e.message}")
            null
        }
    }

    /**
     * Collects the entries for [packageDir] from [baseTag] to [head], applying the rules in the
     * class comment. Pure apart from reading git, so it also works on a ref that isn't checked out.
     */
    fun collect(repoRoot: File, packageDir: File, baseTag: String, includeDependencies: Boolean, head: String = "HEAD"): Notes {
        val dirRel = packageDir.relativeTo(repoRoot).invariantSeparatorsPath
        val prefix = if (dirRel.isEmpty()) "" else "$dirRel/"
        val produced = mutableListOf<Pair<Change, List<Entry>>>()
        val skipped = mutableListOf<Skipped>()

        for (change in changes(repoRoot, "$baseTag..$head", 0)) {
            if (change.subject.startsWith("chore(release)") || SKIP_CI.containsMatchIn(change.subject)) continue
            val files = changedFiles(repoRoot, change, dirRel.ifEmpty { "." }).map { it.removePrefix(prefix) }
            if (files.isEmpty()) continue
            val counted = files.filterNot(::isIgnored)
            val subject = change.subject.replace(SQUASH_PR, "")
            if (counted.none { it != "package.json" }) {
                val dependencyChanges = if ("package.json" in counted) dependencyOnlyChanges(repoRoot, change, "${prefix}package.json") else null
                when {
                    "package.json" !in counted -> skipped += Skipped(change.sha, subject, "touches only the gate stamp, lockfiles, docs or tests")
                    dependencyChanges == null -> {}
                    dependencyChanges.isEmpty() -> skipped += Skipped(change.sha, subject, "changes only the version or dev dependencies")
                    !includeDependencies -> skipped += Skipped(change.sha, subject, "dependency update")
                    else -> produced += change to listOf(Entry(Section.DEPENDENCIES, null, "update ${dependencyChanges.joinToString(", ")}", change.sha, change.pr))
                }
                if (dependencyChanges != null || "package.json" !in counted) continue
            }
            val entries = classify(change, subject, includeDependencies, skipped)
            if (entries.isNotEmpty()) produced += change to entries
        }
        return Notes(cancelReverts(produced, skipped), skipped)
    }

    /** Parses a `type(scope)!: subject` header, or returns null when [line] isn't conventional. */
    fun parseHeader(line: String): Header? {
        val match = HEADER.matchEntire(line.trim()) ?: return null
        val (type, scope, bang, subject) = match.destructured
        return Header(type.lowercase(), scope.trim().ifEmpty { null }, bang == "!", subject.trim())
    }

    /**
     * Renders a release section: `## [version](compare) (date)` and one `###` block per section
     * with entries, linking PRs and commits when [repoUrl] is known.
     */
    fun render(version: String, date: LocalDate, baseTag: String?, newTag: String, repoUrl: String?, entries: List<Entry>): String {
        val heading = when {
            repoUrl != null && baseTag != null -> "## [$version]($repoUrl/compare/$baseTag...$newTag) ($date)"
            repoUrl != null -> "## [$version]($repoUrl/tree/$newTag) ($date)"
            else -> "## [$version] ($date)"
        }
        val out = StringBuilder(heading).append('\n')
        for (section in Section.values()) {
            val lines = entries.filter { it.section == section }
            if (lines.isEmpty()) continue
            out.append("\n### ").append(section.heading).append("\n\n")
            lines.forEach { out.append("* ").append(line(it, repoUrl)).append('\n') }
        }
        return out.toString()
    }

    /**
     * Puts [section] at the top of the CHANGELOG [existing] text. A file's own title and intro are
     * kept (an empty file gets the standard ones), and an existing top section for the same
     * [version] is replaced, so a re-run doesn't add a second copy.
     */
    fun insert(existing: String, section: String, version: String): String {
        val text = existing.replace("\r\n", "\n").trim()
        val firstSection = Regex("^## ", RegexOption.MULTILINE).find(text)?.range?.first ?: text.length
        val preamble = text.substring(0, firstSection).trim().ifEmpty { "$TITLE\n\n$INTRO" }
        var sections = text.substring(firstSection).trim()
        if (sections.startsWith("## [$version]")) {
            val next = Regex("^## ", RegexOption.MULTILINE).find(sections, 3)?.range?.first ?: sections.length
            sections = sections.substring(next).trim()
        }
        return buildString {
            append(preamble).append("\n\n").append(section.trim()).append('\n')
            if (sections.isNotEmpty()) append('\n').append(sections).append('\n')
        }
    }

    /**
     * The repository's web URL for links: `GITHUB_SERVER_URL`/`GITHUB_REPOSITORY` in Actions,
     * otherwise the GitHub slug of `origin` (credentials in the URL are never kept).
     */
    fun repositoryUrl(repoRoot: File): String? {
        val server = System.getenv("GITHUB_SERVER_URL")?.trimEnd('/') ?: "https://github.com"
        val slug = System.getenv("GITHUB_REPOSITORY")?.takeIf { it.isNotBlank() }
            ?: ReleaseAnnouncement.detectGithubRepo(repoRoot)
        return slug?.let { "$server/$it" }
    }

    /**
     * The previous release's tag: `<tagPrefix><previousVersion>` when it exists here or on origin,
     * else the latest earlier `<tagPrefix>*` tag reachable from HEAD, else null.
     */
    fun resolveBaseTag(repoRoot: File, tagPrefix: String, previousVersion: String?, newVersion: String, warn: (String) -> Unit): String? {
        val newTag = tagPrefix + newVersion
        if (previousVersion != null && previousVersion != newVersion) {
            val tag = tagPrefix + previousVersion
            if (!hasTag(repoRoot, tag)) {
                gitOrNull(repoRoot, "fetch", "--quiet", "--no-tags", "origin", "refs/tags/$tag:refs/tags/$tag")
            }
            if (hasTag(repoRoot, tag)) return tag
            warn("[changelog] previous release tag $tag not found; listing changes since the latest earlier $tagPrefix* tag")
        }
        return gitOrNull(repoRoot, "describe", "--tags", "--abbrev=0", "--match", "$tagPrefix*", "--exclude", newTag, "HEAD")
            ?.trim()?.takeIf { it.isNotEmpty() }
    }

    /** Uncommitted paths in the package, apart from the files the release itself writes. */
    fun uncommittedChanges(repoRoot: File, packageDir: File): List<String> {
        val pathspec = packageDir.relativeTo(repoRoot).invariantSeparatorsPath.ifEmpty { "." }
        val status = gitOrNull(repoRoot, "status", "--porcelain", "--untracked-files=normal", "--", pathspec) ?: return emptyList()
        return status.lines().filter { it.length > 3 }.map { it.substring(3).trim() }
            .filterNot { it.substringAfterLast('/') in RELEASE_OWNED_FILES }
    }

    /** Turns one counted change into entries by its header, recording why a change got none. */
    private fun classify(change: Change, subject: String, includeDependencies: Boolean, skipped: MutableList<Skipped>): List<Entry> {
        val reverted = revertedSubject(subject)
        val header = when {
            reverted != null -> Header("revert", null, false, reverted)
            else -> parseHeader(subject) ?: branchType(change.branch)?.let { Header(it, null, false, subject) }
        }
        if (header == null) {
            skipped += Skipped(change.sha, subject, "not a conventional commit")
            return emptyList()
        }
        if (header.type == "revert") {
            val target = parseHeader(header.subject.replace(SQUASH_PR, ""))
            if (target == null || !(target.breaking || target.type in setOf("feat", "fix", "perf"))) {
                skipped += Skipped(change.sha, subject, "reverts a change that isn't listed")
                return emptyList()
            }
        }
        val note = BREAKING_FOOTER.find(change.message)?.groupValues?.get(1)?.trim()
        val entries = mutableListOf<Entry>()
        if (header.breaking || note != null) {
            entries += Entry(Section.BREAKING, header.scope, note ?: header.subject, change.sha, change.pr)
        }
        val section = when {
            header.type == "deps" || header.scope == "deps" -> if (includeDependencies) Section.DEPENDENCIES else null
            header.type == "feat" -> Section.FEATURES
            header.type == "fix" -> Section.FIXES
            header.type == "perf" -> Section.PERFORMANCE
            header.type == "revert" -> Section.REVERTS
            else -> null
        }
        if (section != null) {
            entries += Entry(section, header.scope, header.subject, change.sha, change.pr)
        } else if (entries.isEmpty()) {
            val dependency = header.type == "deps" || header.scope == "deps"
            skipped += Skipped(change.sha, subject, if (dependency) "dependency update" else "${header.type} changes aren't listed")
        }
        return entries
    }

    /**
     * Drops a revert and the change it reverts when both are in the range, matched by the
     * reverted sha, a `Reverts owner/repo#N` line, or (for a GitHub revert PR, whose merge body
     * holds only its title) the reverted title. A revert of an older release stays listed.
     */
    private fun cancelReverts(produced: List<Pair<Change, List<Entry>>>, skipped: MutableList<Skipped>): List<Entry> {
        val cancelled = mutableSetOf<String>()
        for ((change, entries) in produced) {
            if (entries.none { it.section == Section.REVERTS }) continue
            val sha = REVERTED_SHA.find(change.message)?.groupValues?.get(1)
            val pr = REVERTED_PR.find(change.message)?.groupValues?.get(1)?.toInt()
            val title = revertedSubject(change.subject.replace(SQUASH_PR, ""))
            val target = produced.firstOrNull { (other, _) ->
                other.sha != change.sha && other.sha !in cancelled && (
                    (sha != null && other.sha.startsWith(sha)) || (pr != null && other.pr == pr) ||
                        (title != null && (other.subject == title || other.subject.replace(SQUASH_PR, "") == title.replace(SQUASH_PR, "")))
                    )
            } ?: continue
            cancelled += change.sha
            cancelled += target.first.sha
            skipped += Skipped(change.sha, change.subject, "reverts ${target.first.sha.take(9)} in the same release")
            skipped += Skipped(target.first.sha, target.first.subject, "reverted by ${change.sha.take(9)} in the same release")
        }
        return produced.filterNot { it.first.sha in cancelled }.flatMap { it.second }
    }

    /** The first-parent changes in [range], opening up merges that aren't GitHub PR merges. */
    private fun changes(repoRoot: File, range: String, depth: Int): List<Change> {
        val result = mutableListOf<Change>()
        for (commit in firstParentCommits(repoRoot, range)) {
            if (commit.parents.size < 2) {
                result += Change(commit.sha, commit.message, SQUASH_PR.find(commit.subject)?.groupValues?.get(1)?.toInt(), null, commit.parents.firstOrNull())
                continue
            }
            val pr = PR_MERGE.find(commit.subject)
            if (pr != null) {
                val message = commit.body.ifEmpty { commit.subject }
                result += Change(commit.sha, message, pr.groupValues[1].toInt(), pr.groupValues[2], commit.parents[0])
            } else if (depth < MAX_MERGE_DEPTH) {
                result += changes(repoRoot, "${commit.parents[0]}..${commit.parents[1]}", depth + 1)
            }
        }
        return result
    }

    private fun firstParentCommits(repoRoot: File, range: String): List<Commit> =
        git(repoRoot, "log", "--first-parent", "--format=%H%x1f%P%x1f%B%x1e", range).split('\u001e').mapNotNull { record ->
            val fields = record.trim('\n', '\r').split('\u001f')
            if (fields.size < 3 || fields[0].isBlank()) null
            else Commit(fields[0].trim(), fields[1].trim().split(' ').filter { it.isNotBlank() }, fields[2].trim())
        }

    private fun changedFiles(repoRoot: File, change: Change, pathspec: String): List<String> =
        git(repoRoot, "diff", "--name-only", "--no-renames", change.from ?: EMPTY_TREE, change.sha, "--", pathspec)
            .lines().map { it.trim() }.filter { it.isNotEmpty() }

    private fun isIgnored(pathInPackage: String): Boolean {
        val name = pathInPackage.substringAfterLast('/')
        val top = pathInPackage.substringBefore('/')
        return name in IGNORED_NAMES || name.endsWith(".md", ignoreCase = true) ||
            (pathInPackage.contains('/') && top in IGNORED_TOP_DIRS)
    }

    /**
     * For a package.json edit, the runtime dependency changes when it changed nothing but the
     * version and dependency versions (empty when only those and dev dependencies moved), or null
     * when it changed anything else.
     */
    private fun dependencyOnlyChanges(repoRoot: File, change: Change, path: String): List<String>? {
        val before = readJson(repoRoot, change.from ?: return null, path) ?: return null
        val after = readJson(repoRoot, change.sha, path) ?: return null
        if (before - "version" - DEPENDENCY_FIELDS.toSet() != after - "version" - DEPENDENCY_FIELDS.toSet()) return null
        val changes = mutableListOf<String>()
        for (field in RUNTIME_DEPENDENCY_FIELDS) {
            val old = before[field] as? Map<*, *> ?: emptyMap<String, Any?>()
            val new = after[field] as? Map<*, *> ?: emptyMap<String, Any?>()
            for (name in (old.keys + new.keys).map { it.toString() }.distinct().sorted()) {
                val from = old[name]?.toString()
                val to = new[name]?.toString()
                when {
                    from == to -> {}
                    from == null -> changes += "`$name` $to (added)"
                    to == null -> changes += "`$name` (removed)"
                    else -> changes += "`$name` $from → $to"
                }
            }
        }
        return changes
    }

    private fun readJson(repoRoot: File, rev: String, path: String): Map<String, Any?>? {
        val text = gitOrNull(repoRoot, "show", "$rev:$path") ?: return null
        return try { MAPPER.readValue<Map<String, Any?>>(text) } catch (_: Exception) { null }
    }

    /** The reverted header of a `Revert "…"` subject or a `revert: …` header, else null. */
    private fun revertedSubject(subject: String): String? =
        GIT_REVERT.matchEntire(subject)?.groupValues?.get(1)
            ?: parseHeader(subject)?.takeIf { it.type == "revert" }?.subject

    private fun branchType(branch: String?): String? =
        branch?.split('/')?.map { it.lowercase() }?.firstOrNull { it in KNOWN_TYPES }

    private fun line(entry: Entry, repoUrl: String?): String {
        val scope = entry.scope?.let { "**$it:** " } ?: ""
        val pr = entry.pr?.let { if (repoUrl != null) " ([#$it]($repoUrl/pull/$it))" else " (#$it)" } ?: ""
        val short = entry.sha.take(7)
        val commit = if (repoUrl != null) " ([$short]($repoUrl/commit/${entry.sha}))" else " ($short)"
        return "$scope${entry.text}$pr$commit"
    }

    private fun hasTag(repoRoot: File, tag: String): Boolean =
        gitOrNull(repoRoot, "rev-parse", "-q", "--verify", "refs/tags/$tag") != null

    private fun differsFromHead(repoRoot: File, file: File): Boolean {
        val path = file.relativeTo(repoRoot).invariantSeparatorsPath
        val tracked = gitOrNull(repoRoot, "ls-files", "--error-unmatch", "--", path) != null
        return !tracked || run(repoRoot, "diff", "--quiet", "HEAD", "--", path).first != 0
    }

    private fun git(repoRoot: File, vararg args: String): String {
        val (code, out) = run(repoRoot, *args)
        if (code != 0) throw IllegalStateException("git ${args.first()} exited $code")
        return out
    }

    private fun gitOrNull(repoRoot: File, vararg args: String): String? =
        run(repoRoot, *args).let { (code, out) -> if (code == 0) out else null }

    private fun run(repoRoot: File, vararg args: String): Pair<Int, String> {
        val builder = ProcessBuilder(listOf("git") + args).directory(repoRoot).redirectError(ProcessBuilder.Redirect.DISCARD)
        builder.environment()["GIT_TERMINAL_PROMPT"] = "0"
        val process = builder.start()
        val out = process.inputStream.bufferedReader().readText()
        return process.waitFor() to out
    }
}
