package com.zerobias.buildtools.util

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNotNull
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import java.io.File
import java.time.LocalDate

class ChangelogWriterTest {

    @TempDir
    lateinit var tmp: File

    private val url = "https://github.com/acme/modules"
    private val date = LocalDate.of(2026, 11, 25)
    private val widget = "package/acme/widget"

    /** A throwaway git repo on `main` whose `widget` package was released as `widget-v1.0.0`, next to an `other` package. */
    private fun repo(): Repo {
        val repo = Repo(tmp)
        repo.git("init", "-q", "-b", "main")
        repo.git("config", "user.email", "dev@example.com")
        repo.git("config", "user.name", "Dev")
        repo.git("config", "commit.gpgsign", "false")
        repo.git("config", "tag.gpgsign", "false")
        repo.commit(
            "chore: initial",
            "$widget/package.json" to packageJson("1.0.0"),
            "$widget/src/index.ts" to "export const a = 1\n",
            "package/acme/other/package.json" to packageJson("1.0.0", name = "other"),
            "package/acme/other/src/index.ts" to "export const b = 1\n",
        )
        repo.git("tag", "-a", "widget-v1.0.0", "-m", "Release widget v1.0.0")
        return repo
    }

    private fun packageJson(version: String, name: String = "widget", depA: String = "1.0.0"): String =
        "{\n  \"name\": \"@acme/$name\",\n  \"version\": \"$version\",\n  \"dependencies\": {\n    \"dep-a\": \"$depA\"\n  }\n}\n"

    private fun release(
        repo: Repo,
        previous: String? = "1.0.0",
        version: String = "1.0.1",
        options: ChangelogWriter.Options = ChangelogWriter.Options(),
        warnings: MutableList<String> = mutableListOf(),
    ): File? = ChangelogWriter.release(
        repo.root, File(repo.root, widget), "widget-v", previous, version, options,
        info = {}, warn = { warnings += it }, date = date, repoUrl = url,
    )

    private fun changelog(repo: Repo): String = File(repo.root, "$widget/CHANGELOG.md").readText()

    /** Squash-merged PRs: this package's features and fixes are listed with PR and commit links, a sibling's aren't. */
    @Test
    fun `lists squash-merged features and fixes of this package only`() {
        val repo = repo()
        val feat = repo.commit("feat(widget): add search (#10)", "$widget/src/search.ts" to "x\n")
        repo.commit("fix(other): stop the crash (#11)", "package/acme/other/src/index.ts" to "y\n")
        repo.commit("fix: handle empty input (#12)", "$widget/src/index.ts" to "export const a = 2\n")

        assertNotNull(release(repo))
        val text = changelog(repo)
        assertTrue(text.startsWith("# Changelog\n"), text)
        assertTrue(text.contains("## [1.0.1]($url/compare/widget-v1.0.0...widget-v1.0.1) (2026-11-25)"), text)
        assertTrue(text.contains("### Features\n\n* **widget:** add search ([#10]($url/pull/10)) ([${feat.take(7)}]($url/commit/$feat))\n"), text)
        assertTrue(text.contains("### Bug Fixes\n\n* handle empty input ([#12]($url/pull/12))"), text)
        assertFalse(text.contains("stop the crash"), text)
    }

    /** A GitHub merge commit contributes its PR title; the PR's own WIP and review commits never show. */
    @Test
    fun `takes the PR title from a GitHub merge commit`() {
        val repo = repo()
        repo.git("checkout", "-q", "-b", "feat/export")
        repo.commit("wip", "$widget/src/export.ts" to "1\n")
        repo.commit("address review", "$widget/src/export.ts" to "2\n")
        repo.git("checkout", "-q", "main")
        repo.merge("feat/export", "Merge pull request #21 from acme/feat/export", "feat(widget): bulk export")

        release(repo)
        val text = changelog(repo)
        assertTrue(text.contains("* **widget:** bulk export ([#21]($url/pull/21))"), text)
        assertFalse(text.contains("wip"), text)
        assertFalse(text.contains("address review"), text)
    }

    /** A PR title that isn't conventional takes its type from the branch prefix. */
    @Test
    fun `falls back to the branch prefix for a PR title that isn't conventional`() {
        val repo = repo()
        repo.git("checkout", "-q", "-b", "fix/task-367")
        repo.commit("replay", "$widget/src/replay.ts" to "1\n")
        repo.git("checkout", "-q", "main")
        repo.merge("fix/task-367", "Merge pull request #22 from acme/fix/task-367", "Replay deletes in order")

        release(repo)
        assertTrue(changelog(repo).contains("### Bug Fixes\n\n* Replay deletes in order ([#22]($url/pull/22))"))
    }

    /** A commit pushed straight to main is listed, with its commit link and no PR. */
    @Test
    fun `lists a direct commit on main`() {
        val repo = repo()
        val sha = repo.commit("fix(widget): retry the upload", "$widget/src/upload.ts" to "1\n")

        release(repo)
        assertTrue(changelog(repo).contains("* **widget:** retry the upload ([${sha.take(7)}]($url/commit/$sha))\n"))
    }

    /** A local `git merge` (no PR) is opened up, and its commits are judged one by one. */
    @Test
    fun `opens up a local merge`() {
        val repo = repo()
        repo.git("checkout", "-q", "-b", "topic")
        repo.commit("feat(widget): one", "$widget/src/one.ts" to "1\n")
        repo.commit("chore: tidy", "$widget/src/one.ts" to "2\n")
        repo.git("checkout", "-q", "main")
        repo.merge("topic", "Merge branch 'topic'")

        release(repo)
        val text = changelog(repo)
        assertTrue(text.contains("### Features\n\n* **widget:** one"), text)
        assertFalse(text.contains("tidy"), text)
    }

    /**
     * Mislabeled maintenance (stamp, lockfile, docs, tests), release and `[skip ci]` commits are
     * left out; with nothing left there is no section and no file.
     */
    @Test
    fun `leaves out maintenance commits and writes nothing when nothing is left`() {
        val repo = repo()
        repo.commit("fix: correct stamp", "$widget/gate-stamp.json" to "{}\n", "$widget/package-lock.json" to "{}\n")
        repo.commit("fix: typo in the readme", "$widget/README.md" to "# widget\n")
        repo.commit("fix: flaky test", "$widget/test/index.test.ts" to "it()\n")
        repo.commit("fix: version only", "$widget/package.json" to packageJson("1.0.3"))
        repo.commit("chore(release): @acme/widget v1.0.1", "$widget/package.json" to packageJson("1.0.1"))
        repo.commit("feat: refresh the bundle [skip ci]", "$widget/src/bundle.ts" to "1\n")

        assertNull(release(repo))
        assertFalse(File(repo.root, "$widget/CHANGELOG.md").exists())
    }

    /** A commit that only moves dependency versions is a dependency update: hidden by default, listed when asked for. */
    @Test
    fun `treats a dependency-only package json change as a dependency update`() {
        val repo = repo()
        repo.commit("fix: bump schema", "$widget/package.json" to packageJson("1.0.0", depA = "1.1.0"))
        assertNull(release(repo))

        assertNotNull(release(repo, options = ChangelogWriter.Options(includeDependencies = true)))
        assertTrue(changelog(repo).contains("### Dependencies\n\n* update `dep-a` 1.0.0 → 1.1.0"))
    }

    /** Breaking changes are listed under BREAKING CHANGES whatever their type, with the footer's note when there is one. */
    @Test
    fun `lists breaking changes from any type`() {
        val repo = repo()
        repo.commit("refactor(widget)!: drop the v1 API", "$widget/src/v1.ts" to "")
        repo.commit("feat: move the config\n\nBREAKING CHANGE: config now lives in widget.yml", "$widget/src/config.ts" to "1\n")

        release(repo)
        val text = changelog(repo)
        assertTrue(text.contains("### ⚠ BREAKING CHANGES\n\n* config now lives in widget.yml"), text)
        assertTrue(text.contains("* **widget:** drop the v1 API"), text)
        assertTrue(text.contains("### Features\n\n* move the config"), text)
    }

    /** A change and its revert in the same release cancel out. */
    @Test
    fun `drops a change and its revert in the same release`() {
        val repo = repo()
        repo.commit("feat(widget): risky (#30)", "$widget/src/risky.ts" to "1\n")
        repo.git("revert", "--no-edit", "HEAD")

        assertNull(release(repo))
    }

    /** A GitHub revert PR, whose merge body holds only `Revert "<title>"`, cancels the PR it reverts. */
    @Test
    fun `drops a merged PR and the revert PR of it`() {
        val repo = repo()
        repo.git("checkout", "-q", "-b", "feat/risky")
        repo.commit("risky", "$widget/src/risky.ts" to "1\n")
        repo.git("checkout", "-q", "main")
        repo.merge("feat/risky", "Merge pull request #30 from acme/feat/risky", "feat(widget): risky")
        repo.git("checkout", "-q", "-b", "revert-30-feat/risky")
        repo.commit("Revert \"risky\"", "$widget/src/risky.ts" to "")
        repo.git("checkout", "-q", "main")
        repo.merge("revert-30-feat/risky", "Merge pull request #31 from acme/revert-30-feat/risky", "Revert \"feat(widget): risky\"")

        assertNull(release(repo))
    }

    /** Reverting a change from an earlier release is listed under Reverts. */
    @Test
    fun `lists a revert of an earlier release`() {
        val repo = repo()
        repo.commit("feat(widget): risky (#30)", "$widget/src/risky.ts" to "1\n")
        repo.git("tag", "-a", "widget-v1.0.1", "-m", "Release widget v1.0.1")
        repo.git("revert", "--no-edit", "HEAD")

        release(repo, previous = "1.0.1", version = "1.0.2")
        assertTrue(changelog(repo).contains("### Reverts\n\n* feat(widget): risky (#30)"))
    }

    /** A re-run rewrites its own section rather than adding a second copy, and earlier releases stay below it. */
    @Test
    fun `rewrites the same version's section and keeps earlier releases`() {
        val repo = repo()
        repo.commit("docs: seed the changelog", "$widget/CHANGELOG.md" to "# Changelog\n\n## [1.0.0](x) (2026-01-01)\n\n### Features\n\n* first\n")
        repo.commit("feat: second", "$widget/src/second.ts" to "1\n")

        assertNotNull(release(repo))
        assertNotNull(release(repo))
        val text = changelog(repo)
        assertEquals(1, Regex("""^## \[1\.0\.1]""", RegexOption.MULTILINE).findAll(text).count(), text)
        assertTrue(text.indexOf("## [1.0.1]") < text.indexOf("## [1.0.0]"), text)
        assertTrue(text.contains("* first"), text)
    }

    /** Without a tag for the previous version, the latest earlier release tag is the start, and the log says so. */
    @Test
    fun `falls back to the latest earlier tag`() {
        val repo = repo()
        repo.commit("fix: one", "$widget/src/one.ts" to "1\n")
        val warnings = mutableListOf<String>()

        release(repo, previous = "1.0.4", version = "1.0.5", warnings = warnings)
        assertTrue(changelog(repo).contains("compare/widget-v1.0.0...widget-v1.0.5"))
        assertTrue(warnings.any { it.contains("widget-v1.0.4 not found") }, warnings.toString())
    }

    /** A package with no earlier release tag gets no notes. */
    @Test
    fun `writes nothing without an earlier release tag`() {
        val repo = repo()
        repo.git("tag", "-d", "widget-v1.0.0")
        repo.commit("feat: one", "$widget/src/one.ts" to "1\n")

        assertNull(release(repo))
    }

    /** Uncommitted changes in the package ship without a commit to describe them, so the release warns. */
    @Test
    fun `warns about uncommitted changes in the package`() {
        val repo = repo()
        repo.commit("feat: one", "$widget/src/one.ts" to "1\n")
        File(repo.root, "$widget/src/dirty.ts").writeText("1\n")
        val warnings = mutableListOf<String>()

        release(repo, warnings = warnings)
        assertTrue(warnings.any { it.contains("uncommitted") && it.contains("dirty.ts") }, warnings.toString())
    }

    /** `zb.changelog=false` writes nothing. */
    @Test
    fun `does nothing when turned off`() {
        val repo = repo()
        repo.commit("feat: one", "$widget/src/one.ts" to "1\n")

        assertNull(release(repo, options = ChangelogWriter.Options(enabled = false)))
    }

    @Test
    fun `parses conventional headers`() {
        assertEquals(ChangelogWriter.Header("feat", "api", false, "add x"), ChangelogWriter.parseHeader("feat(api): add x"))
        assertEquals(ChangelogWriter.Header("fix", null, true, "drop y"), ChangelogWriter.parseHeader("fix!: drop y"))
        assertNull(ChangelogWriter.parseHeader("Promote codeserverworkspace to prod (1.0.6) — pin initializer 1.0.4"))
        assertNull(ChangelogWriter.parseHeader("Merge branch 'main'"))
    }

    @Test
    fun `reads its switches from Gradle properties`() {
        val props = mapOf("zb.changelog" to "false", "zb.changelog.dependencies" to "true")
        assertEquals(ChangelogWriter.Options(enabled = false, includeDependencies = true), ChangelogWriter.Options.from { props[it] })
        assertEquals(ChangelogWriter.Options(), ChangelogWriter.Options.from { null })
    }

    /** The release announcement reads the newest section, including from a file holding a single release. */
    @Test
    fun `release announcement reads the newest section`() {
        val one = "# Changelog\n\nintro\n\n## [1.0.1](x) (2026-11-25)\n\n### Features\n\n* a\n"
        assertEquals("## [1.0.1](x) (2026-11-25)\n\n### Features\n\n* a", ReleaseAnnouncement.firstChangelogBlock(one))
        val two = one + "\n## [1.0.0](y) (2026-11-01)\n\n### Bug Fixes\n\n* b\n"
        assertEquals("## [1.0.1](x) (2026-11-25)\n\n### Features\n\n* a", ReleaseAnnouncement.firstChangelogBlock(two))
    }

    /** A git working copy driven through the CLI. */
    class Repo(val root: File) {
        fun git(vararg args: String): String {
            val process = ProcessBuilder(listOf("git") + args).directory(root).redirectErrorStream(true).start()
            val out = process.inputStream.bufferedReader().readText()
            check(process.waitFor() == 0) { "git ${args.joinToString(" ")} failed: $out" }
            return out.trim()
        }

        fun commit(message: String, vararg files: Pair<String, String>): String {
            for ((path, text) in files) File(root, path).apply { parentFile.mkdirs(); writeText(text) }
            git("add", "-A")
            git("commit", "-q", "--allow-empty", "-m", message)
            return git("rev-parse", "HEAD")
        }

        fun merge(branch: String, vararg paragraphs: String) {
            git("merge", "--no-ff", "-q", *paragraphs.flatMap { listOf("-m", it) }.toTypedArray(), branch)
        }
    }
}
