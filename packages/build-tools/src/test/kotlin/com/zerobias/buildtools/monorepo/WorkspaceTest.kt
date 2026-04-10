package com.zerobias.buildtools.monorepo

import org.junit.jupiter.api.Assumptions.assumeTrue
import org.junit.jupiter.api.DynamicTest
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.TestFactory
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNotNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.io.TempDir
import java.io.File
import java.nio.file.Path

class WorkspaceTest {

    @Test
    fun `discoverWorkspaces expands glob patterns`(@TempDir tmp: Path) {
        val root = tmp.toFile()
        File(root, "package.json").writeText("""
            {
              "name": "test-monorepo",
              "version": "1.0.0",
              "workspaces": ["packages/*"]
            }
        """.trimIndent())

        // Create three workspace packages
        for (name in listOf("foo", "bar", "baz")) {
            val dir = File(root, "packages/$name")
            dir.mkdirs()
            File(dir, "package.json").writeText("""
                {"name": "@test/$name", "version": "1.0.0"}
            """.trimIndent())
        }

        val packages = Workspace.discoverWorkspaces(root)
        assertEquals(3, packages.size)
        assertTrue(packages.containsKey("@test/foo"))
        assertTrue(packages.containsKey("@test/bar"))
        assertTrue(packages.containsKey("@test/baz"))
    }

    @Test
    fun `discoverWorkspaces handles literal directory paths`(@TempDir tmp: Path) {
        val root = tmp.toFile()
        File(root, "package.json").writeText("""
            {
              "name": "test-monorepo",
              "version": "1.0.0",
              "workspaces": ["core", "server", "utils/helper"]
            }
        """.trimIndent())

        for (path in listOf("core", "server", "utils/helper")) {
            val dir = File(root, path)
            dir.mkdirs()
            File(dir, "package.json").writeText("""
                {"name": "@test/${path.replace("/", "-")}", "version": "1.0.0"}
            """.trimIndent())
        }

        val packages = Workspace.discoverWorkspaces(root)
        assertEquals(3, packages.size)
        assertEquals("utils/helper", packages["@test/utils-helper"]?.relDir)
    }

    @Test
    fun `discoverWorkspaces resolves internal deps`(@TempDir tmp: Path) {
        val root = tmp.toFile()
        File(root, "package.json").writeText("""
            {"name": "monorepo", "workspaces": ["a", "b", "c"]}
        """.trimIndent())

        File(root, "a").mkdirs()
        File(root, "a/package.json").writeText("""
            {"name": "@t/a", "version": "1.0.0", "dependencies": {"@t/b": "1.0.0", "lodash": "^4.0.0"}}
        """.trimIndent())
        File(root, "b").mkdirs()
        File(root, "b/package.json").writeText("""
            {"name": "@t/b", "version": "1.0.0", "dependencies": {"@t/c": "1.0.0", "react": "^18.0.0"}}
        """.trimIndent())
        File(root, "c").mkdirs()
        File(root, "c/package.json").writeText("""
            {"name": "@t/c", "version": "1.0.0"}
        """.trimIndent())

        val packages = Workspace.discoverWorkspaces(root)
        assertEquals(listOf("@t/b"), packages["@t/a"]?.internalDeps)
        assertEquals(listOf("@t/c"), packages["@t/b"]?.internalDeps)
        assertEquals(emptyList<String>(), packages["@t/c"]?.internalDeps)
    }

    @Test
    fun `discoverWorkspaces throws on missing root package json`(@TempDir tmp: Path) {
        assertThrows(IllegalStateException::class.java) {
            Workspace.discoverWorkspaces(tmp.toFile())
        }
    }

    @Test
    fun `buildDependencyGraph topo sort puts leaves first`() {
        // Build packages: a → b → c (a depends on b, b depends on c)
        val packages = linkedMapOf<String, WorkspacePackage>()
        for (name in listOf("a", "b", "c")) {
            packages[name] = WorkspacePackage(
                name = name,
                dir = File("/tmp/$name"),
                relDir = name,
                version = "1.0.0",
                private = false,
                scripts = emptyMap(),
                internalDeps = when (name) {
                    "a" -> listOf("b")
                    "b" -> listOf("c")
                    else -> emptyList()
                },
                packageJson = emptyMap(),
            )
        }

        val graph = Workspace.buildDependencyGraph(packages)
        assertEquals(listOf("c", "b", "a"), graph.buildOrder)
        assertEquals(setOf("a"), graph.dependents["b"])
        assertEquals(setOf("b"), graph.dependents["c"])
        assertEquals(emptySet<String>(), graph.dependents["a"])
    }

    @Test
    fun `buildDependencyGraph detects cycles`() {
        val packages = linkedMapOf<String, WorkspacePackage>()
        packages["a"] = WorkspacePackage("a", File("/tmp/a"), "a", "1.0.0", false, emptyMap(), listOf("b"), emptyMap())
        packages["b"] = WorkspacePackage("b", File("/tmp/b"), "b", "1.0.0", false, emptyMap(), listOf("a"), emptyMap())

        assertThrows(IllegalStateException::class.java) {
            Workspace.buildDependencyGraph(packages)
        }
    }

    @Test
    fun `getTransitiveDependents BFS through reverse graph`() {
        // Diamond: a → b, a → c, b → d, c → d
        val packages = linkedMapOf<String, WorkspacePackage>()
        packages["a"] = WorkspacePackage("a", File("/tmp/a"), "a", "1.0.0", false, emptyMap(), listOf("b", "c"), emptyMap())
        packages["b"] = WorkspacePackage("b", File("/tmp/b"), "b", "1.0.0", false, emptyMap(), listOf("d"), emptyMap())
        packages["c"] = WorkspacePackage("c", File("/tmp/c"), "c", "1.0.0", false, emptyMap(), listOf("d"), emptyMap())
        packages["d"] = WorkspacePackage("d", File("/tmp/d"), "d", "1.0.0", false, emptyMap(), emptyList(), emptyMap())

        val graph = Workspace.buildDependencyGraph(packages)
        // Build order: d, b/c (any order), a
        assertEquals("d", graph.buildOrder[0])
        assertEquals("a", graph.buildOrder[3])

        // Transitive dependents of d: b, c, a
        val depsOfD = Workspace.getTransitiveDependents("d", graph)
        assertEquals(setOf("a", "b", "c"), depsOfD)
    }

    // ── Integration: real production repos ────────────────────────────

    @TestFactory
    fun `discovers workspaces in all 6 production repos`(): List<DynamicTest> {
        val repoPaths = listOf(
            "/root/nfa-repos/com/util",
            "/root/nfa-repos/com/hub",
            "/root/nfa-repos/com/dana",
            "/root/nfa-repos/com/hydra-service",
            "/root/nfa-repos/com/fileservice",
            "/root/nfa-repos/com/platform",
        )

        return repoPaths.mapNotNull { path ->
            val root = File(path)
            if (!root.exists()) return@mapNotNull null
            DynamicTest.dynamicTest(root.name) {
                val packages = Workspace.discoverWorkspaces(root)
                assertTrue(packages.isNotEmpty(), "expected packages discovered for ${root.name}")

                val graph = Workspace.buildDependencyGraph(packages)
                assertEquals(packages.size, graph.buildOrder.size,
                    "build order should include every package")

                // Sanity: every package's internalDeps should be in the package map
                for ((name, pkg) in packages) {
                    for (dep in pkg.internalDeps) {
                        assertTrue(packages.containsKey(dep),
                            "$name depends on $dep but $dep is not in workspace")
                    }
                }

                println("${root.name}: ${packages.size} packages, build order leaves first: ${graph.buildOrder.take(3)}")
            }
        }
    }
}
