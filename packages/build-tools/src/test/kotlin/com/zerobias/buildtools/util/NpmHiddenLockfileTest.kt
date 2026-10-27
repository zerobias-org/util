package com.zerobias.buildtools.util

import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import java.io.File
import java.nio.file.Files
import java.nio.file.Path

class NpmHiddenLockfileTest {

    /**
     * Lays out a workspace root the way npm leaves it: a registry package, a scoped one, a nested
     * one, a workspace sibling linked under node_modules, and the hidden lockfile listing them all.
     */
    private fun installedRoot(tmp: Path): File {
        val root = tmp.toFile()
        for (dir in listOf("node_modules/is-number", "node_modules/@scope/pkg", "node_modules/@scope/pkg/node_modules/dep", "packages/sibling")) {
            File(root, dir).mkdirs()
        }
        Files.createSymbolicLink(File(root, "node_modules/@scope/sibling").toPath(), Path.of("../../packages/sibling"))
        File(root, "node_modules/${NpmHiddenLockfile.FILE_NAME}").writeText(
            """
            {
              "name": "root",
              "lockfileVersion": 3,
              "requires": true,
              "packages": {
                "node_modules/@scope/pkg": { "version": "1.0.0" },
                "node_modules/@scope/pkg/node_modules/dep": { "version": "2.0.0" },
                "node_modules/@scope/sibling": { "resolved": "packages/sibling", "link": true },
                "node_modules/is-number": { "version": "7.0.0" },
                "packages/sibling": { "name": "@scope/sibling", "version": "1.0.0" },
                "packages/removed": { "name": "removed", "version": "1.0.0", "extraneous": true }
              }
            }
            """.trimIndent()
        )
        return root
    }

    @Test
    fun `intact install with links and stale workspace entries is present`(@TempDir tmp: Path) {
        val root = installedRoot(tmp)
        assertTrue(NpmHiddenLockfile.packagesPresent(File(root, "node_modules")))
    }

    @Test
    fun `missing hidden lockfile is not present`(@TempDir tmp: Path) {
        val root = installedRoot(tmp)
        File(root, "node_modules/${NpmHiddenLockfile.FILE_NAME}").delete()
        assertFalse(NpmHiddenLockfile.packagesPresent(File(root, "node_modules")))
        assertFalse(NpmHiddenLockfile.packagesPresent(File(tmp.toFile(), "absent/node_modules")))
    }

    @Test
    fun `deleted package folder is not present`(@TempDir tmp: Path) {
        val root = installedRoot(tmp)
        File(root, "node_modules/@scope/pkg/node_modules/dep").deleteRecursively()
        assertFalse(NpmHiddenLockfile.packagesPresent(File(root, "node_modules")))
    }

    @Test
    fun `broken workspace link is not present`(@TempDir tmp: Path) {
        val root = installedRoot(tmp)
        File(root, "packages/sibling").deleteRecursively()
        assertFalse(NpmHiddenLockfile.packagesPresent(File(root, "node_modules")))
    }

    @Test
    fun `unreadable hidden lockfile is not present`(@TempDir tmp: Path) {
        val root = installedRoot(tmp)
        val nodeModules = File(root, "node_modules")
        for (content in listOf("{ not json", "", "{}")) {
            File(nodeModules, NpmHiddenLockfile.FILE_NAME).writeText(content)
            assertFalse(NpmHiddenLockfile.packagesPresent(nodeModules), "content: '$content'")
        }
    }
}
