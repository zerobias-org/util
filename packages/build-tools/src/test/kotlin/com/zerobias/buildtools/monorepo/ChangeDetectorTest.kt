package com.zerobias.buildtools.monorepo

import org.junit.jupiter.api.Test
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.io.TempDir
import java.io.File
import java.nio.file.Path

class ChangeDetectorTest {

    private fun runGit(dir: File, vararg args: String): String {
        val process = ProcessBuilder("git", *args)
            .directory(dir)
            .redirectErrorStream(true)
            .start()
        process.waitFor()
        return process.inputStream.bufferedReader().readText().trim()
    }

    /**
     * Initialize a 2-package monorepo in tmp with git history.
     */
    private fun setupMonorepo(tmp: Path): File {
        val root = tmp.toFile()
        runGit(root, "init", "-q", "-b", "main")
        runGit(root, "config", "user.email", "test@test.com")
        runGit(root, "config", "user.name", "test")
        runGit(root, "config", "commit.gpgsign", "false")

        File(root, "package.json").writeText("""
            {
              "name": "test-monorepo",
              "version": "1.0.0",
              "workspaces": ["packages/foo", "packages/bar"],
              "dependencies": {"lodash": "^4.0.0"}
            }
        """.trimIndent())

        File(root, "packages/foo").mkdirs()
        File(root, "packages/foo/package.json").writeText("""
            {"name": "@t/foo", "version": "1.0.0"}
        """.trimIndent())
        File(root, "packages/foo/src").mkdirs()
        File(root, "packages/foo/src/index.ts").writeText("export const foo = 1;")

        File(root, "packages/bar").mkdirs()
        File(root, "packages/bar/package.json").writeText("""
            {"name": "@t/bar", "version": "1.0.0", "dependencies": {"@t/foo": "1.0.0"}}
        """.trimIndent())
        File(root, "packages/bar/src").mkdirs()
        File(root, "packages/bar/src/index.ts").writeText("export const bar = 1;")

        runGit(root, "add", ".")
        runGit(root, "commit", "-q", "-m", "init")
        return root
    }

    @Test
    fun `--all returns all packages`(@TempDir tmp: Path) {
        val root = setupMonorepo(tmp)
        val packages = Workspace.discoverWorkspaces(root)
        val graph = Workspace.buildDependencyGraph(packages)

        val result = ChangeDetector.detectChanges(root, graph, all = true)
        assertEquals(setOf("@t/foo", "@t/bar"), result.affected)
        assertEquals("N/A (--all)", result.baseRef)
    }

    @Test
    fun `direct file change marks package as changed`(@TempDir tmp: Path) {
        val root = setupMonorepo(tmp)
        val packages = Workspace.discoverWorkspaces(root)
        val graph = Workspace.buildDependencyGraph(packages)

        // Modify foo's source file (uncommitted)
        File(root, "packages/foo/src/index.ts").writeText("export const foo = 2;")

        val result = ChangeDetector.detectChanges(root, graph)
        assertTrue(result.changed.contains("@t/foo"), "foo should be in changed set")
        assertTrue(result.affected.contains("@t/foo"), "foo should be in affected set")
        // bar depends on foo → also affected (transitive)
        assertTrue(result.affected.contains("@t/bar"), "bar should be transitively affected")
    }

    @Test
    fun `transitive dependents are pulled in`(@TempDir tmp: Path) {
        val root = setupMonorepo(tmp)
        val packages = Workspace.discoverWorkspaces(root)
        val graph = Workspace.buildDependencyGraph(packages)

        File(root, "packages/foo/src/index.ts").writeText("// changed")

        val result = ChangeDetector.detectChanges(root, graph)
        // foo is directly changed, bar is transitively affected
        assertEquals(setOf("@t/foo"), result.changed)
        assertEquals(setOf("@t/foo", "@t/bar"), result.affected)
        // affectedOrdered should be in topo order: foo first, bar after
        assertEquals(listOf("@t/foo", "@t/bar"), result.affectedOrdered)
    }

    @Test
    fun `tsconfig changes invalidate all packages`(@TempDir tmp: Path) {
        val root = setupMonorepo(tmp)
        File(root, "tsconfig.json").writeText("{}")
        runGit(root, "add", ".")
        runGit(root, "commit", "-q", "-m", "add tsconfig")

        val packages = Workspace.discoverWorkspaces(root)
        val graph = Workspace.buildDependencyGraph(packages)

        // Modify tsconfig.json (uncommitted)
        File(root, "tsconfig.json").writeText("{\"compilerOptions\": {\"strict\": true}}")

        val result = ChangeDetector.detectChanges(root, graph)
        assertEquals(setOf("@t/foo", "@t/bar"), result.affected,
            "tsconfig.json change should invalidate all packages")
    }

    @Test
    fun `gate-stamp changes are ignored`(@TempDir tmp: Path) {
        val root = setupMonorepo(tmp)
        val packages = Workspace.discoverWorkspaces(root)
        val graph = Workspace.buildDependencyGraph(packages)

        // Create gate-stamp.json (uncommitted)
        File(root, "gate-stamp.json").writeText("{}")

        val result = ChangeDetector.detectChanges(root, graph)
        // Only foo and bar should appear if their dist/ is missing — they will be
        // because we never built them. So we expect them in affected via the
        // missing-dist fallback, NOT because of gate-stamp.json.
        // Verify gate-stamp was filtered out by checking neither package was
        // in the `changed` set:
        assertFalse(result.changed.contains("@t/foo"), "foo not directly changed")
        assertFalse(result.changed.contains("@t/bar"), "bar not directly changed")
    }

    @Test
    fun `missing dist directory marks package as affected`(@TempDir tmp: Path) {
        val root = setupMonorepo(tmp)
        val packages = Workspace.discoverWorkspaces(root)
        val graph = Workspace.buildDependencyGraph(packages)

        // Create dist for foo, leave bar without
        File(root, "packages/foo/dist").mkdirs()

        val result = ChangeDetector.detectChanges(root, graph)
        assertFalse(result.changed.contains("@t/bar"), "bar not git-changed")
        assertTrue(result.affected.contains("@t/bar"), "bar missing dist → affected")
    }

    @Test
    fun `getCurrentBranch returns the active branch`(@TempDir tmp: Path) {
        val root = setupMonorepo(tmp)
        val branch = ChangeDetector.getCurrentBranch(root)
        assertEquals("main", branch)
    }
}
