package com.zerobias.buildtools.util

import java.io.File
import java.security.MessageDigest

/**
 * SHA-256 hashing for package source/test directories.
 *
 * Uses `git ls-files` for deterministic file enumeration that ignores
 * gitignored files. This is critical for hash equality between local
 * (where untracked generated files may exist) and CI (where they don't).
 *
 * Falls back to recursive directory walk only when not in a git repo,
 * to support non-git contexts (rare).
 *
 * Shared by:
 * - `zb.base.gradle.kts` per-project gate stamp (single-package consumers)
 * - `com.zerobias.buildtools.monorepo.GateStamp` multi-package gate stamp
 */
object SourceHasher {

    /**
     * Hash a set of source files and source directories within a package.
     *
     * @param packageDir the absolute package directory (working dir for git ls-files)
     * @param sourceFiles individual filenames at the package root (e.g. "tsconfig.json")
     * @param sourceDirs directory names at the package root (e.g. "src")
     * @return SHA-256 hex digest
     */
    fun hashSources(
        packageDir: File,
        sourceFiles: List<String>,
        sourceDirs: List<String>,
    ): String {
        val digest = MessageDigest.getInstance("SHA-256")

        // 1. Hash individual source files — only git-tracked files for cross-environment
        // determinism. Files that exist locally but are gitignored (e.g. generated api.yml)
        // would otherwise produce different hashes between local and CI.
        for (name in sourceFiles) {
            val file = File(packageDir, name)
            if (!file.exists()) continue
            if (!isGitTracked(packageDir, name)) continue
            digest.update(name.toByteArray())
            digest.update(file.readBytes())
        }

        // 2. Hash source directories — only git-tracked files
        for (dirName in sourceDirs) {
            val dir = File(packageDir, dirName)
            if (!dir.exists()) continue

            val files = listGitTrackedFiles(packageDir, dirName)
                ?: walkFallback(dir, packageDir)

            for (relPath in files) {
                val absFile = File(packageDir, relPath)
                // Skip files listed by git but absent on disk (sparse checkout, deleted)
                if (!absFile.exists()) continue
                digest.update(relPath.toByteArray())
                digest.update(absFile.readBytes())
            }
        }

        return digest.digest().joinToString("") { "%02x".format(it) }
    }

    /**
     * Hash test directories. Tests are NOT git-restricted because test files may
     * include locally-generated fixtures that aren't committed but are part of the
     * test surface. Falls back to recursive walk.
     */
    fun hashTests(packageDir: File, testDirs: List<String> = listOf("test")): String {
        val digest = MessageDigest.getInstance("SHA-256")
        for (dirName in testDirs) {
            val dir = File(packageDir, dirName)
            if (!dir.exists()) continue
            val files = walkFallback(dir, packageDir)
            for (relPath in files) {
                val absFile = File(packageDir, relPath)
                if (!absFile.exists()) continue
                digest.update(relPath.toByteArray())
                digest.update(absFile.readBytes())
            }
        }
        return digest.digest().joinToString("") { "%02x".format(it) }
    }

    /**
     * Count expected test cases by scanning for `it(`, `it.only(`, `test(`
     * in `.ts` and `.js` files within the directory.
     */
    fun countExpectedTests(testDir: File): Int {
        if (!testDir.exists()) return 0
        val pattern = Regex("""(?:^|\s)(?:it|it\.only|test)\s*\(""")
        return testDir.walkTopDown()
            .filter { it.isFile && (it.name.endsWith(".ts") || it.name.endsWith(".js")) }
            .sumOf { file ->
                file.readLines().count { line -> pattern.containsMatchIn(line) }
            }
    }

    // ── Git helpers ──────────────────────────────────────────────────

    /**
     * Check if a single file is git-tracked relative to the package directory.
     * Uses `git ls-files --error-unmatch` which exits non-zero if not tracked.
     */
    private fun isGitTracked(packageDir: File, relPath: String): Boolean {
        return try {
            val process = ProcessBuilder("git", "ls-files", "--error-unmatch", relPath)
                .directory(packageDir)
                .redirectErrorStream(false)
                .start()
            val finished = process.waitFor(5, java.util.concurrent.TimeUnit.SECONDS)
            if (!finished) {
                process.destroyForcibly()
                false
            } else {
                process.exitValue() == 0
            }
        } catch (_: Exception) {
            false
        }
    }

    /**
     * List git-tracked files within a directory (relative to package root).
     * Returns null if not in a git repo (caller falls back to walk).
     */
    private fun listGitTrackedFiles(packageDir: File, dirName: String): List<String>? {
        return try {
            val process = ProcessBuilder("git", "ls-files", dirName)
                .directory(packageDir)
                .redirectErrorStream(false)
                .start()
            val output = process.inputStream.bufferedReader().readText()
            val finished = process.waitFor(10, java.util.concurrent.TimeUnit.SECONDS)
            if (!finished || process.exitValue() != 0) {
                process.destroyForcibly()
                null
            } else {
                output.trim().lines().filter { it.isNotEmpty() }.sorted()
            }
        } catch (_: Exception) {
            null
        }
    }

    /**
     * Recursive directory walk fallback (used outside git repos).
     * Returns relative paths from packageDir, sorted.
     */
    private fun walkFallback(dir: File, packageDir: File): List<String> {
        if (!dir.exists()) return emptyList()
        return dir.walkTopDown()
            .filter { it.isFile }
            .map { it.relativeTo(packageDir).path }
            .sorted()
            .toList()
    }
}
