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
 * first-parent line, and each commit on it that touched the package is one change:
 * - a squash-merged PR, whose subject is the PR title with ` (#N)`;
 * - a GitHub merge commit, whose PR title is the first line of the merge body;
 * - a commit pushed straight to main.
 *
 * A merge that is not a PR merge (a local `git merge`, or a `git pull` that merged) is opened
 * up, and the first-parent commits it brought in are judged one by one. A PR's own commits, its
 * WIP and "merge main" commits never show.
 *
 * **What counts for this package.** A change counts only if it changed files in the package
 * directory. These don't count:
 * - the gate stamp and lockfiles;
 * - Markdown at the package root (README, USAGE, the changelog itself), while nested Markdown
 *   counts, because content packages keep real content in it;
 * - `test/`, `.github` and `.claude`;
 * - a package.json edit that changes only the version or dependency versions. A change made
 *   up of that alone is a dependency update.
 *
 * **What is listed.**
 * - Listed: `feat`, `fix`, `perf` and `revert`, plus anything breaking (`!` or a
 *   `BREAKING CHANGE:` footer), which also goes under BREAKING CHANGES whatever its type.
 * - Listed only with [Options.includeDependencies]: dependency updates (type or scope `deps`,
 *   or a dependency-only diff).
 * - Left out: every other type, messages that aren't conventional, and the release commits
 *   publish itself makes. A PR merge whose title isn't conventional falls back to its branch
 *   prefix (`fix/…`).
 * - A revert and the change it reverts cancel out when both are in the range, and a revert of
 *   that revert puts the change back.
 *
 * When nothing is left, no section is written, so versions without user-facing changes have no
 * entry and no "version bump only" noise.
 *
 * Everything comes from git, so a local `zbb publish` writes the same notes as CI. Paths are
 * taken relative to [release]'s `repoRoot`, which may be a subdirectory of the git repository
 * (a build rooted below the repo's top level). The section uses conventional-changelog's
 * `## [version](compare) (date)` heading, which [ReleaseAnnouncement.notesFor] reads; lerna's
 * older sections, whatever their heading level, stay below it.
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

    /** What a revert undoes: the reverted commit's sha, its PR, or its title, whichever the message gives. */
    private data class Reverted(val sha: String?, val pr: Int?, val title: String?)

    private class Counted(val change: Change, val subject: String, val entries: List<Entry>, val reverted: Reverted?)

    const val FILE_NAME = "CHANGELOG.md"
    private const val TITLE = "# Changelog"
    private const val INTRO = "Versions with no feature, fix, performance or breaking change have no entry."
    private const val EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904"
    private const val MAX_MERGE_DEPTH = 5

    private val HEADER = Regex("""^(\w+)(?:\(([^()]*)\))?(!)?:\s+(.+)$""")
    private val BREAKING_FOOTER = Regex("""^BREAKING[ -]CHANGE:\s*(.*)$""")
    private val SQUASH_PR = Regex("""\s+\(#(\d+)\)$""")
    private val PR_MERGE = Regex("""^Merge pull request #(\d+) from (\S+)""")
    private val GIT_REVERT = Regex("""^Revert "(.+)"$""")
    private val GIT_REAPPLY = Regex("""^Reapply "(.+)"$""")
    private val REVERTED_SHA = Regex("""This reverts commit ([0-9a-f]{7,40})""")
    private val REVERTED_PR = Regex("""Reverts [\w.-]+/[\w.-]+#(\d+)""")
    private val VERSION_HEADING = Regex("""^#{1,3} \[?v?\d+\.\d+\.\d+[^\n]*$""", RegexOption.MULTILINE)
    private val LISTED_TYPES = setOf("feat", "fix", "perf")
    private val KNOWN_TYPES = setOf("feat", "fix", "perf", "revert", "refactor", "chore", "docs", "test", "build", "ci", "style", "deps")
    private val IGNORED_NAMES = setOf(
        "gate-stamp.json", "package-lock.json", "npm-shrinkwrap.json", "yarn.lock", "pnpm-lock.yaml", "bun.lock", "bun.lockb",
    )
    private val IGNORED_TOP_DIRS = setOf("test", "tests", "__tests__", ".github", ".claude")
    private val DEPENDENCY_FIELDS = setOf("dependencies", "devDependencies", "peerDependencies", "optionalDependencies")
    private val RUNTIME_DEPENDENCY_FIELDS = listOf("dependencies", "peerDependencies", "optionalDependencies")
    private val RELEASE_OWNED_FILES = setOf("package.json", "gate-stamp.json", FILE_NAME, "package-lock.json")
    private val MAPPER = ObjectMapper().registerKotlinModule()

    /**
     * Writes the section for [newVersion] into the package's CHANGELOG.md and stages it, called by
     * the standard-mode release commit (`commitVersion`, `versionStandardPackages`).
     *
     * The previous release is `<tagPrefix><previousVersion>`, fetched from origin when a local
     * clone lacks it; without it, the highest earlier `<tagPrefix><version>` tag reachable from
     * HEAD is used. A package with no earlier release tag gets no notes. Outside CI it also warns
     * when the package has uncommitted changes, since they would ship without a commit to
     * describe them.
     *
     * Never throws and never leaves a half-written file: on any failure, staging included (an
     * ignored CHANGELOG.md, a locked index), the file goes back to what it was, the reason goes
     * to [warn], and the release carries on without notes.
     *
     * @return the staged CHANGELOG.md when it now differs from HEAD, else null
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
        checkUncommitted: Boolean = !inCi(),
    ): File? {
        if (!options.enabled) return null
        var label = packageDir.name
        var written: Pair<File, String?>? = null
        return try {
            label = packageDir.relativeTo(repoRoot).invariantSeparatorsPath.ifEmpty { "." }
            if (checkUncommitted) {
                val dirty = uncommittedChanges(repoRoot, packageDir)
                if (dirty.isNotEmpty()) {
                    warn("[changelog] $label: uncommitted changes ship with this release, and no commit describes them: ${dirty.joinToString(", ")}")
                }
            }
            val baseTag = resolveBaseTag(repoRoot, tagPrefix, previousVersion, newVersion, warn)
            if (baseTag == null) {
                info("[changelog] $label: no earlier $tagPrefix<version> release tag, so no notes for $newVersion")
                return null
            }
            val notes = collect(repoRoot, packageDir, baseTag, options.includeDependencies)
            notes.skipped.forEach { info("[changelog] $label: left out ${it.sha.take(9)} \"${it.subject}\": ${it.reason}") }
            if (notes.entries.isEmpty()) {
                info("[changelog] $label: nothing to list since $baseTag")
                return null
            }
            val file = File(packageDir, FILE_NAME)
            val previous = if (file.exists()) file.readText() else null
            val updated = insert(previous.orEmpty(), render(newVersion, date, baseTag, tagPrefix + newVersion, repoUrl, notes.entries), newVersion)
            written = file to previous
            if (updated != previous) file.writeText(updated)
            val path = file.relativeTo(repoRoot).invariantSeparatorsPath
            if (run(repoRoot, "add", "--", path).first != 0) {
                restore(repoRoot, file, previous)
                warn("[changelog] $label: CHANGELOG.md can't be staged (ignored or locked?), so no notes for $newVersion")
                return null
            }
            info("[changelog] $label: ${notes.entries.size} change(s) since $baseTag listed for $newVersion")
            if (run(repoRoot, "diff", "--cached", "--quiet", "--", path).first != 0) file else null
        } catch (e: Exception) {
            written?.let { (file, previous) -> restore(repoRoot, file, previous) }
            warn("[changelog] $label: no notes written for $newVersion: ${e.message}")
            null
        }
    }

    /**
     * Puts [file] back as it was before [release] touched it: unstaged, with its [previous] text,
     * or gone when it didn't exist. For callers that fail after [release] returned a file.
     */
    fun restore(repoRoot: File, file: File, previous: String?) {
        try {
            run(repoRoot, "reset", "-q", "HEAD", "--", file.relativeTo(repoRoot).invariantSeparatorsPath)
            if (previous == null) file.delete() else file.writeText(previous)
        } catch (_: Exception) {
        }
    }

    /**
     * Collects the entries for [packageDir] from [baseTag] to [head], applying the rules in the
     * class comment. Git narrows the history to the commits that touched the package, so the
     * cost follows the package's own changes, not the repository's size. Pure apart from reading
     * git, so it also works on a ref that isn't checked out.
     */
    fun collect(repoRoot: File, packageDir: File, baseTag: String, includeDependencies: Boolean, head: String = "HEAD"): Notes {
        val dirRel = packageDir.relativeTo(repoRoot).invariantSeparatorsPath
        val pathspec = dirRel.ifEmpty { "." }
        val prefix = if (dirRel.isEmpty()) "" else "$dirRel/"
        val counted = mutableListOf<Counted>()
        val skipped = mutableListOf<Skipped>()

        for (change in changes(repoRoot, "$baseTag..$head", pathspec, 0)) {
            val subject = change.subject.replace(SQUASH_PR, "")
            if (change.pr == null && subject.startsWith("chore(release)")) continue
            val files = changedFiles(repoRoot, change, pathspec).map { it.removePrefix(prefix) }.filterNot(::isIgnored)
            val entries = entriesFor(repoRoot, change, subject, files, prefix, includeDependencies, skipped)
            counted += Counted(change, subject, entries, revertedBy(change, subject))
        }
        return Notes(cancelReverts(counted, skipped), skipped)
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
     * Puts [section] above the first release in the CHANGELOG [existing] text. Releases are
     * recognised at any heading level, bracketed or not, because lerna wrote minor and major
     * releases as `# [x.y.z]` and patches as `## [x.y.z]`. Whatever precedes the first release
     * (the file's title and intro) is kept, and an empty file gets the standard ones. A top
     * section already for [version] is replaced, so a re-run doesn't add a second copy.
     */
    fun insert(existing: String, section: String, version: String): String {
        val text = existing.replace("\r\n", "\n").trim()
        val first = VERSION_HEADING.find(text)
        val preamble = (if (first == null) text else text.substring(0, first.range.first)).trim().ifEmpty { "$TITLE\n\n$INTRO" }
        var releases = if (first == null) "" else text.substring(first.range.first)
        if (first != null && Regex("""^#{1,3} \[?v?${Regex.escape(version)}(?![\w.-])""").containsMatchIn(first.value)) {
            val next = VERSION_HEADING.find(releases, first.value.length)
            releases = if (next == null) "" else releases.substring(next.range.first)
        }
        return buildString {
            append(preamble).append("\n\n").append(section.trim()).append('\n')
            if (releases.isNotBlank()) append('\n').append(releases.trim()).append('\n')
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
     * else the highest earlier tag reachable from HEAD that is exactly `<tagPrefix><x.y.z>`, else
     * null. The exact form keeps `api-v` from matching another package's `api-v2-v1.0.0`.
     */
    fun resolveBaseTag(repoRoot: File, tagPrefix: String, previousVersion: String?, newVersion: String, warn: (String) -> Unit): String? {
        val newTag = tagPrefix + newVersion
        if (previousVersion != null && previousVersion != newVersion) {
            val tag = tagPrefix + previousVersion
            if (!hasTag(repoRoot, tag)) {
                gitOrNull(repoRoot, "fetch", "--quiet", "--no-tags", "origin", "refs/tags/$tag:refs/tags/$tag")
            }
            if (hasTag(repoRoot, tag)) return tag
            warn("[changelog] previous release tag $tag not found; listing changes since the latest earlier $tagPrefix<version> tag")
        }
        val exact = Regex("^${Regex.escape(tagPrefix)}\\d+\\.\\d+\\.\\d+$")
        return gitOrNull(repoRoot, "for-each-ref", "--merged", "HEAD", "--sort=-v:refname", "--format=%(refname:strip=2)", "refs/tags/$tagPrefix*")
            ?.lineSequence()?.map { it.trim() }?.firstOrNull { exact.matches(it) && it != newTag }
    }

    /** Uncommitted paths in the package, apart from the files the release itself writes. */
    fun uncommittedChanges(repoRoot: File, packageDir: File): List<String> {
        val pathspec = packageDir.relativeTo(repoRoot).invariantSeparatorsPath.ifEmpty { "." }
        val status = gitOrNull(repoRoot, "status", "--porcelain", "--untracked-files=normal", "--", pathspec) ?: return emptyList()
        return status.lines().filter { it.length > 3 }.map { it.substring(3).trim() }
            .filterNot { it.substringAfterLast('/') in RELEASE_OWNED_FILES }
    }

    /** True on a CI runner, where the checkout is what was pushed and the build may touch tracked files. */
    private fun inCi(): Boolean = System.getenv("CI") == "true"

    /**
     * The entries one change earns for the package given the [files] it counted for, recording in
     * [skipped] why a change earns none. A change limited to package.json versions is a
     * dependency update whatever its type says.
     */
    private fun entriesFor(
        repoRoot: File,
        change: Change,
        subject: String,
        files: List<String>,
        prefix: String,
        includeDependencies: Boolean,
        skipped: MutableList<Skipped>,
    ): List<Entry> {
        if (files.isEmpty()) {
            skipped += Skipped(change.sha, subject, "touches only the gate stamp, lockfiles, docs or tests")
            return emptyList()
        }
        if (files.all { it == "package.json" }) {
            val moved = dependencyOnlyChanges(repoRoot, change, "${prefix}package.json")
            if (moved != null) {
                if (moved.isNotEmpty() && includeDependencies) {
                    return listOf(Entry(Section.DEPENDENCIES, null, "update ${moved.joinToString(", ")}", change.sha, change.pr))
                }
                skipped += Skipped(change.sha, subject, if (moved.isEmpty()) "changes only the version or dev dependencies" else "dependency update")
                return emptyList()
            }
        }
        return classify(repoRoot, change, subject, includeDependencies, skipped)
    }

    /**
     * Turns one counted change into entries by its header. A `Revert "…"` wrapped an odd number
     * of times is a revert of the innermost change; wrapped an even number of times it puts that
     * change back, and is listed as the change itself.
     */
    private fun classify(repoRoot: File, change: Change, subject: String, includeDependencies: Boolean, skipped: MutableList<Skipped>): List<Entry> {
        val (depth, innermost) = unwrapReverts(subject)
        val described = if (depth == 0 || parseHeader(innermost.replace(SQUASH_PR, "")) != null) innermost else revertedTitle(repoRoot, change) ?: innermost
        val effective = described.replace(SQUASH_PR, "")
        val header = parseHeader(effective)
            ?: branchType(change.branch)?.let { Header(it, null, false, if (PR_MERGE.containsMatchIn(effective)) branchTitle(change.branch) else effective) }
        if (header == null) {
            skipped += Skipped(change.sha, subject, if (depth % 2 == 1) "reverts a change that isn't listed" else "not a conventional commit")
            return emptyList()
        }
        if (depth % 2 == 1) {
            if (!header.breaking && header.type !in LISTED_TYPES) {
                skipped += Skipped(change.sha, subject, "reverts a change that isn't listed")
                return emptyList()
            }
            return listOf(Entry(Section.REVERTS, null, described, change.sha, change.pr))
        }
        val note = breakingNote(change.message)
        val entries = mutableListOf<Entry>()
        if (header.breaking || note != null) {
            entries += Entry(Section.BREAKING, header.scope, note ?: header.subject, change.sha, change.pr)
        }
        val dependency = header.type == "deps" || header.scope == "deps"
        val section = when {
            dependency -> if (includeDependencies) Section.DEPENDENCIES else null
            header.type == "feat" -> Section.FEATURES
            header.type == "fix" -> Section.FIXES
            header.type == "perf" -> Section.PERFORMANCE
            else -> null
        }
        if (section != null) {
            entries += Entry(section, header.scope, header.subject, change.sha, change.pr)
        } else if (entries.isEmpty()) {
            skipped += Skipped(change.sha, subject, if (dependency) "dependency update" else "${header.type} changes aren't listed")
        }
        return entries
    }

    /** The text of a `BREAKING CHANGE:` footer: its whole paragraph on one line, since footers wrap. */
    private fun breakingNote(message: String): String? {
        val lines = message.lines()
        val start = lines.indexOfFirst { BREAKING_FOOTER.matches(it.trim()) }
        if (start < 0) return null
        val paragraph = listOf(BREAKING_FOOTER.matchEntire(lines[start].trim())!!.groupValues[1]) + lines.drop(start + 1).takeWhile { it.isNotBlank() }
        return paragraph.joinToString(" ") { it.trim() }.trim().ifEmpty { null }
    }

    /**
     * Drops each revert together with the change it undoes when both are in the range, newest
     * first, so a revert of a revert cancels that revert and leaves the original change listed.
     * The target is the nearest older change matching the reverted sha, else its PR, else (for a
     * GitHub revert PR, whose merge body holds only its title) its title. A revert whose target
     * is in an older release keeps its entry.
     */
    private fun cancelReverts(counted: List<Counted>, skipped: MutableList<Skipped>): List<Entry> {
        val cancelled = mutableSetOf<String>()
        for ((index, item) in counted.withIndex()) {
            val reverted = item.reverted ?: continue
            if (item.change.sha in cancelled) continue
            val older = counted.subList(index + 1, counted.size).filter { it.change.sha !in cancelled }
            val target = older.firstOrNull { reverted.sha != null && it.change.sha.startsWith(reverted.sha) }
                ?: older.firstOrNull { reverted.pr != null && it.change.pr == reverted.pr }
                ?: older.firstOrNull { reverted.title != null && (it.change.subject == reverted.title || it.subject == reverted.title.replace(SQUASH_PR, "")) }
                ?: continue
            cancelled += item.change.sha
            cancelled += target.change.sha
            if (item.entries.isNotEmpty()) skipped += Skipped(item.change.sha, item.subject, "undoes ${target.change.sha.take(9)} in the same release")
            if (target.entries.isNotEmpty()) skipped += Skipped(target.change.sha, target.subject, "undone by ${item.change.sha.take(9)} in the same release")
        }
        return counted.filterNot { it.change.sha in cancelled }.flatMap { it.entries }
    }

    /**
     * What [change] directly reverts, or null when its subject isn't a `Revert "…"`, a
     * `revert: …` or a `Reapply "…"` (git 2.43's title for reverting a revert, which undoes
     * `Revert "…"`).
     */
    private fun revertedBy(change: Change, subject: String): Reverted? {
        val title = GIT_REVERT.matchEntire(subject)?.groupValues?.get(1)
            ?: GIT_REAPPLY.matchEntire(subject)?.groupValues?.get(1)?.let { "Revert \"$it\"" }
            ?: parseHeader(subject)?.takeIf { it.type == "revert" }?.subject
            ?: return null
        val pr = REVERTED_PR.find(change.message)?.groupValues?.get(1)?.toInt()
            ?: PR_MERGE.find(title)?.groupValues?.get(1)?.toInt()
            ?: SQUASH_PR.find(title)?.groupValues?.get(1)?.toInt()
        return Reverted(REVERTED_SHA.find(change.message)?.groupValues?.get(1), pr, title)
    }

    /**
     * Strips the `Revert "…"` / `revert: …` wrappers off [subject]: how many there were, and what
     * is inside. A `Reapply "…"` counts as two, being a revert of a revert.
     */
    private fun unwrapReverts(subject: String): Pair<Int, String> {
        var depth = 0
        var current = subject
        while (depth < 10) {
            val reapplied = GIT_REAPPLY.matchEntire(current)?.groupValues?.get(1)
            val inner = reapplied
                ?: GIT_REVERT.matchEntire(current)?.groupValues?.get(1)
                ?: parseHeader(current)?.takeIf { it.type == "revert" }?.subject
                ?: break
            depth += if (reapplied != null) 2 else 1
            current = inner.trim()
        }
        return depth to current
    }

    /** The title of the commit a revert names by sha, for a `Revert "Merge pull request …"` whose own subject says nothing. */
    private fun revertedTitle(repoRoot: File, change: Change): String? {
        val sha = REVERTED_SHA.find(change.message)?.groupValues?.get(1) ?: return null
        val message = gitOrNull(repoRoot, "log", "-1", "--format=%B", sha)?.trim() ?: return null
        val subject = message.lineSequence().first().trim()
        val title = if (PR_MERGE.containsMatchIn(subject)) message.substringAfter('\n', "").trim().lineSequence().firstOrNull()?.trim() else subject
        return title?.takeIf { it.isNotEmpty() }
    }

    /**
     * The first-parent changes in [range] that touched [pathspec]. A merge counts as one change
     * when it is a GitHub PR merge or carries a PR title (`… (#N)`); any other merge is opened up
     * and its own first-parent line is walked the same way.
     */
    private fun changes(repoRoot: File, range: String, pathspec: String, depth: Int): List<Change> {
        val result = mutableListOf<Change>()
        for (commit in firstParentCommits(repoRoot, range, pathspec)) {
            val titled = SQUASH_PR.find(commit.subject)?.groupValues?.get(1)?.toInt()
            val merged = if (commit.parents.size > 1) PR_MERGE.find(commit.subject) else null
            when {
                merged != null ->
                    result += Change(commit.sha, commit.body.ifEmpty { commit.subject }, merged.groupValues[1].toInt(), merged.groupValues[2], commit.parents[0])
                commit.parents.size < 2 || titled != null ->
                    result += Change(commit.sha, commit.message, titled, null, commit.parents.firstOrNull())
                depth < MAX_MERGE_DEPTH ->
                    result += changes(repoRoot, "${commit.parents[0]}..${commit.parents[1]}", pathspec, depth + 1)
            }
        }
        return result
    }

    /**
     * The commits on [range]'s first-parent line that differ from their first parent under
     * [pathspec]; with `--first-parent`, git compares a merge to its first parent only.
     */
    private fun firstParentCommits(repoRoot: File, range: String, pathspec: String): List<Commit> =
        git(repoRoot, "log", "--first-parent", "--format=%H%x1f%P%x1f%B%x1e", range, "--", pathspec).split('\u001e').mapNotNull { record ->
            val fields = record.trim('\n', '\r').split('\u001f')
            if (fields.size < 3 || fields[0].isBlank()) null
            else Commit(fields[0].trim(), fields[1].trim().split(' ').filter { it.isNotBlank() }, fields[2].trim())
        }

    private fun changedFiles(repoRoot: File, change: Change, pathspec: String): List<String> =
        git(repoRoot, "diff", "--name-only", "--no-renames", "--relative", "-z", change.from ?: EMPTY_TREE, change.sha, "--", pathspec)
            .split('\u0000').filter { it.isNotEmpty() }

    private fun isIgnored(pathInPackage: String): Boolean {
        val name = pathInPackage.substringAfterLast('/')
        val nested = pathInPackage.contains('/')
        return name in IGNORED_NAMES || (!nested && name.endsWith(".md", ignoreCase = true)) ||
            (nested && pathInPackage.substringBefore('/') in IGNORED_TOP_DIRS)
    }

    /**
     * For a package.json edit, the runtime dependency changes when it changed nothing but the
     * version and dependency versions (empty when only those and dev dependencies moved), or null
     * when it changed anything else.
     */
    private fun dependencyOnlyChanges(repoRoot: File, change: Change, path: String): List<String>? {
        val before = readJson(repoRoot, change.from ?: return null, path) ?: return null
        val after = readJson(repoRoot, change.sha, path) ?: return null
        if (before - "version" - DEPENDENCY_FIELDS != after - "version" - DEPENDENCY_FIELDS) return null
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
        val text = gitOrNull(repoRoot, "show", "$rev:./$path") ?: return null
        return try { MAPPER.readValue<Map<String, Any?>>(text) } catch (_: Exception) { null }
    }

    private fun branchType(branch: String?): String? =
        branch?.split('/')?.map { it.lowercase() }?.firstOrNull { it in KNOWN_TYPES }

    /** A readable title from a branch name, for a PR merge that kept no title: `acme/fix/retry-upload` gives "retry upload". */
    private fun branchTitle(branch: String?): String =
        branch.orEmpty().substringAfterLast('/').replace(Regex("[-_]+"), " ").trim()

    private fun line(entry: Entry, repoUrl: String?): String {
        val scope = entry.scope?.let { "**$it:** " } ?: ""
        val pr = entry.pr?.let { if (repoUrl != null) " ([#$it]($repoUrl/pull/$it))" else " (#$it)" } ?: ""
        val short = entry.sha.take(7)
        val commit = if (repoUrl != null) " ([$short]($repoUrl/commit/${entry.sha}))" else " ($short)"
        return "$scope${entry.text}$pr$commit"
    }

    private fun hasTag(repoRoot: File, tag: String): Boolean =
        gitOrNull(repoRoot, "rev-parse", "-q", "--verify", "refs/tags/$tag") != null

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
        builder.environment()["GIT_LITERAL_PATHSPECS"] = "1"
        val process = builder.start()
        val out = process.inputStream.bufferedReader().readText()
        return process.waitFor() to out
    }
}
