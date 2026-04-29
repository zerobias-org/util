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
}
