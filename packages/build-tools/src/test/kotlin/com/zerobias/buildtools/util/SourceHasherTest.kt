package com.zerobias.buildtools.util

import org.junit.jupiter.api.Test
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNotEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.io.TempDir
import java.io.File
import java.nio.file.Path

class SourceHasherTest {

    private fun runGit(dir: File, vararg args: String): String {
        val process = ProcessBuilder("git", *args)
            .directory(dir)
            .redirectErrorStream(true)
            .start()
        process.waitFor()
        return process.inputStream.bufferedReader().readText().trim()
    }

    /**
     * Initialize a git repo in tmp with some files. Returns the package dir.
     */
    private fun setupGitRepo(tmp: Path): File {
        val pkgDir = tmp.toFile()
        runGit(pkgDir, "init", "-q")
        runGit(pkgDir, "config", "user.email", "test@test.com")
        runGit(pkgDir, "config", "user.name", "test")
        runGit(pkgDir, "config", "commit.gpgsign", "false")
        return pkgDir
    }

    @Test
    fun `hashSources is deterministic across runs`(@TempDir tmp: Path) {
        val pkg = setupGitRepo(tmp)
        File(pkg, "tsconfig.json").writeText("{ \"compilerOptions\": {} }")
        File(pkg, "src").mkdirs()
        File(pkg, "src/index.ts").writeText("export const foo = 1;")
        runGit(pkg, "add", ".")
        runGit(pkg, "commit", "-q", "-m", "init")

        val h1 = SourceHasher.hashSources(pkg, listOf("tsconfig.json"), listOf("src"))
        val h2 = SourceHasher.hashSources(pkg, listOf("tsconfig.json"), listOf("src"))
        assertEquals(h1, h2)
    }

    @Test
    fun `hashSources changes when source content changes`(@TempDir tmp: Path) {
        val pkg = setupGitRepo(tmp)
        File(pkg, "tsconfig.json").writeText("{ \"compilerOptions\": {} }")
        File(pkg, "src").mkdirs()
        File(pkg, "src/index.ts").writeText("export const foo = 1;")
        runGit(pkg, "add", ".")
        runGit(pkg, "commit", "-q", "-m", "init")

        val before = SourceHasher.hashSources(pkg, listOf("tsconfig.json"), listOf("src"))

        File(pkg, "src/index.ts").writeText("export const foo = 2;")
        runGit(pkg, "add", ".")
        runGit(pkg, "commit", "-q", "-m", "change")

        val after = SourceHasher.hashSources(pkg, listOf("tsconfig.json"), listOf("src"))
        assertNotEquals(before, after)
    }

    @Test
    fun `hashSources ignores untracked files in source dir`(@TempDir tmp: Path) {
        val pkg = setupGitRepo(tmp)
        File(pkg, "tsconfig.json").writeText("{}")
        File(pkg, "src").mkdirs()
        File(pkg, "src/index.ts").writeText("export const foo = 1;")
        runGit(pkg, "add", ".")
        runGit(pkg, "commit", "-q", "-m", "init")

        val before = SourceHasher.hashSources(pkg, listOf("tsconfig.json"), listOf("src"))

        // Add an untracked file (e.g. a generated artifact that exists locally but not in git)
        File(pkg, "src/generated.ts").writeText("// auto-generated")

        val after = SourceHasher.hashSources(pkg, listOf("tsconfig.json"), listOf("src"))
        assertEquals(before, after) {
            "untracked file should NOT affect hash — that's the whole point of the git ls-files fix"
        }
    }

    @Test
    fun `hashSources ignores untracked source files at package root`(@TempDir tmp: Path) {
        val pkg = setupGitRepo(tmp)
        File(pkg, "tsconfig.json").writeText("{}")
        File(pkg, "src").mkdirs()
        File(pkg, "src/index.ts").writeText("x")
        runGit(pkg, "add", ".")
        runGit(pkg, "commit", "-q", "-m", "init")

        val before = SourceHasher.hashSources(pkg, listOf("tsconfig.json", "api.yml"), listOf("src"))

        // Create api.yml as untracked file — should not be hashed
        File(pkg, "api.yml").writeText("openapi: 3.0.0")

        val after = SourceHasher.hashSources(pkg, listOf("tsconfig.json", "api.yml"), listOf("src"))
        assertEquals(before, after) {
            "untracked api.yml at root should not affect hash (matches the gitignored generated file fix)"
        }
    }

    @Test
    fun `hashSources includes tracked source files at root`(@TempDir tmp: Path) {
        val pkg = setupGitRepo(tmp)
        File(pkg, "tsconfig.json").writeText("{}")
        File(pkg, "api.yml").writeText("openapi: 3.0.0")
        File(pkg, "src").mkdirs()
        File(pkg, "src/index.ts").writeText("x")
        runGit(pkg, "add", ".")
        runGit(pkg, "commit", "-q", "-m", "init")

        val withApi = SourceHasher.hashSources(pkg, listOf("tsconfig.json", "api.yml"), listOf("src"))

        // Modify api.yml and commit — should change the hash
        File(pkg, "api.yml").writeText("openapi: 3.1.0")
        runGit(pkg, "add", ".")
        runGit(pkg, "commit", "-q", "-m", "bump api")

        val after = SourceHasher.hashSources(pkg, listOf("tsconfig.json", "api.yml"), listOf("src"))
        assertNotEquals(withApi, after) {
            "tracked api.yml change must affect hash"
        }
    }

    @Test
    fun `hashTests is independent of source hash`(@TempDir tmp: Path) {
        val pkg = setupGitRepo(tmp)
        File(pkg, "src").mkdirs()
        File(pkg, "src/index.ts").writeText("x")
        File(pkg, "test").mkdirs()
        File(pkg, "test/index.test.ts").writeText("it('works', () => {})")
        // SourceHasher uses `git ls-files` to enumerate files, so untracked
        // files return the empty-string hash. Commit before hashing.
        runGit(pkg, "add", ".")
        runGit(pkg, "commit", "-q", "-m", "init")

        val srcHash = SourceHasher.hashSources(pkg, listOf(), listOf("src"))
        val testHash = SourceHasher.hashTests(pkg)
        assertNotEquals(srcHash, testHash)

        // Adding more test files changes test hash but not source hash
        File(pkg, "test/another.test.ts").writeText("it('also', () => {})")
        runGit(pkg, "add", ".")
        runGit(pkg, "commit", "-q", "-m", "add another test")
        val srcHash2 = SourceHasher.hashSources(pkg, listOf(), listOf("src"))
        val testHash2 = SourceHasher.hashTests(pkg)
        assertEquals(srcHash, srcHash2) { "source hash should be unchanged" }
        assertNotEquals(testHash, testHash2) { "test hash should change" }
    }

    @Test
    fun `countExpectedTests counts it and test calls`(@TempDir tmp: Path) {
        val testDir = tmp.toFile()
        File(testDir, "a.test.ts").writeText("""
            describe('foo', () => {
              it('does thing', () => {})
              it.only('does other', () => {})
              test('alt syntax', () => {})
            })
        """.trimIndent())
        File(testDir, "b.test.js").writeText("""
            it('one', () => {})
            it('two', () => {})
        """.trimIndent())
        // Non-test helper file with no test-like calls
        File(testDir, "helper.ts").writeText("export function helperUtil() { return 1 }")

        val count = SourceHasher.countExpectedTests(testDir)
        assertEquals(5, count)
    }

    @Test
    fun `countExpectedTests returns zero for missing dir`(@TempDir tmp: Path) {
        val missing = File(tmp.toFile(), "nonexistent")
        assertEquals(0, SourceHasher.countExpectedTests(missing))
    }

    @Test
    fun `hashSources skips files listed by git but absent on disk`(@TempDir tmp: Path) {
        val pkg = setupGitRepo(tmp)
        File(pkg, "src").mkdirs()
        File(pkg, "src/a.ts").writeText("a")
        File(pkg, "src/b.ts").writeText("b")
        runGit(pkg, "add", ".")
        runGit(pkg, "commit", "-q", "-m", "init")

        // Delete b.ts on disk but not in git index (simulates sparse checkout)
        File(pkg, "src/b.ts").delete()

        // Should not throw — gracefully skips missing files
        val hash = SourceHasher.hashSources(pkg, listOf(), listOf("src"))
        assertTrue(hash.isNotEmpty())
    }

    @Test
    fun `hashSources ignores a version-only change to package json`(@TempDir tmp: Path) {
        val pkg = setupGitRepo(tmp)
        File(pkg, "package.json").writeText("""{"name":"@x/y","version":"1.0.0","dependencies":{"lodash":"^4"}}""")
        File(pkg, "src").mkdirs()
        File(pkg, "src/index.ts").writeText("export const foo = 1;")
        runGit(pkg, "add", ".")
        runGit(pkg, "commit", "-q", "-m", "init")

        val before = SourceHasher.hashSources(pkg, listOf("package.json"), listOf("src"))

        // Bump only the version — the kind of change a `chore(release)` commit makes.
        File(pkg, "package.json").writeText("""{"name":"@x/y","version":"1.0.1","dependencies":{"lodash":"^4"}}""")
        runGit(pkg, "add", ".")
        runGit(pkg, "commit", "-q", "-m", "release")

        val after = SourceHasher.hashSources(pkg, listOf("package.json"), listOf("src"))
        assertEquals(before, after) {
            "a version-only bump to package.json must not invalidate the gate stamp"
        }
    }

    @Test
    fun `hashSources still detects non-version package json changes`(@TempDir tmp: Path) {
        val pkg = setupGitRepo(tmp)
        File(pkg, "package.json").writeText("""{"name":"@x/y","version":"1.0.0","dependencies":{"lodash":"^4"}}""")
        File(pkg, "src").mkdirs()
        File(pkg, "src/index.ts").writeText("export const foo = 1;")
        runGit(pkg, "add", ".")
        runGit(pkg, "commit", "-q", "-m", "init")

        val before = SourceHasher.hashSources(pkg, listOf("package.json"), listOf("src"))

        // Change a dependency pin — that IS a meaningful change.
        File(pkg, "package.json").writeText("""{"name":"@x/y","version":"1.0.0","dependencies":{"lodash":"^5"}}""")
        runGit(pkg, "add", ".")
        runGit(pkg, "commit", "-q", "-m", "bump dep")

        val after = SourceHasher.hashSources(pkg, listOf("package.json"), listOf("src"))
        assertNotEquals(before, after) {
            "a dependency change in package.json must still affect the hash"
        }
    }

    @Test
    fun `hashSources ignores package json reformatting`(@TempDir tmp: Path) {
        val pkg = setupGitRepo(tmp)
        File(pkg, "package.json").writeText("""{"name":"@x/y","version":"1.0.0","dependencies":{"lodash":"^4"}}""")
        File(pkg, "src").mkdirs()
        File(pkg, "src/index.ts").writeText("export const foo = 1;")
        runGit(pkg, "add", ".")
        runGit(pkg, "commit", "-q", "-m", "init")

        val before = SourceHasher.hashSources(pkg, listOf("package.json"), listOf("src"))

        // Same content, pretty-printed — re-serialization normalizes whitespace.
        File(pkg, "package.json").writeText(
            """
            {
              "name": "@x/y",
              "version": "1.0.0",
              "dependencies": {
                "lodash": "^4"
              }
            }
            """.trimIndent() + "\n"
        )
        runGit(pkg, "add", ".")
        runGit(pkg, "commit", "-q", "-m", "reformat")

        val after = SourceHasher.hashSources(pkg, listOf("package.json"), listOf("src"))
        assertEquals(before, after) {
            "reformatting package.json (no semantic change) must not invalidate the gate stamp"
        }
    }

    @Test
    fun `hashSources falls back to raw bytes for malformed package json`(@TempDir tmp: Path) {
        val pkg = setupGitRepo(tmp)
        File(pkg, "package.json").writeText("{ this is not valid json ")
        File(pkg, "src").mkdirs()
        File(pkg, "src/index.ts").writeText("x")
        runGit(pkg, "add", ".")
        runGit(pkg, "commit", "-q", "-m", "init")

        // Should not throw — bad JSON just gets hashed verbatim.
        val before = SourceHasher.hashSources(pkg, listOf("package.json"), listOf("src"))
        assertTrue(before.isNotEmpty())

        File(pkg, "package.json").writeText("{ still not valid, but different ")
        runGit(pkg, "add", ".")
        runGit(pkg, "commit", "-q", "-m", "change")
        val after = SourceHasher.hashSources(pkg, listOf("package.json"), listOf("src"))
        assertNotEquals(before, after) { "raw-byte fallback still tracks changes" }
    }

    // ── package.json `files` payload hashing (content packages) ──────────

    @Test
    fun `content package — editing a files-listed index_yml invalidates the hash`(@TempDir tmp: Path) {
        // A content package: no src/, no tsconfig — exactly the case where the
        // src-based defaults produced a constant empty hash and never re-gated.
        val pkg = setupGitRepo(tmp)
        File(pkg, "index.yml").writeText("name: scarola\nversion: 1\n")
        runGit(pkg, "add", ".")
        runGit(pkg, "commit", "-q", "-m", "init")

        val files = listOf("index.yml", "logo.*")
        val before = SourceHasher.hashSources(pkg, listOf("tsconfig.json"), listOf("src"), files)

        File(pkg, "index.yml").writeText("name: scarola\nversion: 2\n")
        runGit(pkg, "add", ".")
        runGit(pkg, "commit", "-q", "-m", "edit index")

        val after = SourceHasher.hashSources(pkg, listOf("tsconfig.json"), listOf("src"), files)
        assertNotEquals(before, after) { "editing the published index.yml must re-gate" }
    }

    @Test
    fun `files glob resolves — editing a tracked logo invalidates the hash`(@TempDir tmp: Path) {
        val pkg = setupGitRepo(tmp)
        File(pkg, "index.yml").writeText("x")
        File(pkg, "logo.svg").writeText("<svg>a</svg>")
        runGit(pkg, "add", ".")
        runGit(pkg, "commit", "-q", "-m", "init")

        val files = listOf("index.yml", "logo.*")
        val before = SourceHasher.hashSources(pkg, listOf(), listOf(), files)

        File(pkg, "logo.svg").writeText("<svg>b</svg>")
        runGit(pkg, "add", ".")
        runGit(pkg, "commit", "-q", "-m", "edit logo")

        val after = SourceHasher.hashSources(pkg, listOf(), listOf(), files)
        assertNotEquals(before, after) { "logo.* glob must resolve and track the tracked logo" }
    }

    @Test
    fun `gitignored build output listed in files is a no-op`(@TempDir tmp: Path) {
        // Typical TS service package: files: ["dist"], dist gitignored. Folding
        // files must contribute nothing so existing stamps stay byte-identical.
        val pkg = setupGitRepo(tmp)
        File(pkg, ".gitignore").writeText("dist/\n")
        File(pkg, "tsconfig.json").writeText("{}")
        File(pkg, "src").mkdirs()
        File(pkg, "src/index.ts").writeText("export const x = 1;")
        runGit(pkg, "add", ".")
        runGit(pkg, "commit", "-q", "-m", "init")

        val sourceOnly = SourceHasher.hashSources(pkg, listOf("tsconfig.json"), listOf("src"))
        val withFiles = SourceHasher.hashSources(pkg, listOf("tsconfig.json"), listOf("src"), listOf("dist"))
        assertEquals(sourceOnly, withFiles) {
            "gitignored dist in `files` must not change the hash — keeps existing TS stamps valid"
        }

        // And a locally-built dist file (untracked, gitignored) stays a no-op.
        File(pkg, "dist").mkdirs()
        File(pkg, "dist/index.js").writeText("var x = 1;")
        val afterBuild = SourceHasher.hashSources(pkg, listOf("tsconfig.json"), listOf("src"), listOf("dist"))
        assertEquals(sourceOnly, afterBuild) { "untracked built output must never affect the hash" }
    }

    @Test
    fun `readFilesPatterns reads the files array, empty when absent`(@TempDir tmp: Path) {
        val pkg = tmp.toFile()
        assertEquals(emptyList<String>(), SourceHasher.readFilesPatterns(pkg)) // no package.json

        File(pkg, "package.json").writeText("{ \"name\": \"x\", \"files\": [\"index.yml\", \"logo.*\"] }")
        assertEquals(listOf("index.yml", "logo.*"), SourceHasher.readFilesPatterns(pkg))

        File(pkg, "package.json").writeText("{ \"name\": \"x\" }")
        assertEquals(emptyList<String>(), SourceHasher.readFilesPatterns(pkg)) // no files field
    }

    // ── untracked-published guard (airtight gate for new content) ────────

    @Test
    fun `findUntrackedPublishedFiles flags a never-committed published file`(@TempDir tmp: Path) {
        val pkg = setupGitRepo(tmp)
        File(pkg, "package.json").writeText("{ \"name\": \"x\", \"files\": [\"index.yml\", \"logo.*\"] }")
        File(pkg, "index.yml").writeText("name: scarola")  // exists on disk, never `git add`ed
        val files = SourceHasher.readFilesPatterns(pkg)

        val untracked = SourceHasher.findUntrackedPublishedFiles(pkg, files)
        assertTrue(untracked.contains("index.yml")) {
            "a published file git doesn't track must be flagged so the gate can't silently pass it"
        }

        // Staging makes it git-tracked → no longer flagged.
        runGit(pkg, "add", "index.yml")
        assertTrue(SourceHasher.findUntrackedPublishedFiles(pkg, files).isEmpty()) {
            "staged (tracked) file must not be flagged"
        }
    }

    @Test
    fun `findUntrackedPublishedFiles ignores gitignored build output`(@TempDir tmp: Path) {
        val pkg = setupGitRepo(tmp)
        File(pkg, ".gitignore").writeText("dist/\n")
        File(pkg, "dist").mkdirs()
        File(pkg, "dist/index.js").writeText("var x = 1;")  // built, gitignored, untracked

        val untracked = SourceHasher.findUntrackedPublishedFiles(pkg, listOf("dist"))
        assertTrue(untracked.isEmpty()) {
            "gitignored build output is intentionally untracked — must NOT trip the guard"
        }
    }
}
