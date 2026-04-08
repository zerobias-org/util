package com.zerobias.buildtools.monorepo

import com.fasterxml.jackson.databind.ObjectMapper
import com.fasterxml.jackson.module.kotlin.readValue
import com.fasterxml.jackson.module.kotlin.registerKotlinModule
import org.junit.jupiter.api.Assumptions.assumeTrue
import org.junit.jupiter.api.DynamicTest
import org.junit.jupiter.api.TestFactory
import java.io.File

/**
 * Parity test: runs the bash/JS prepublish-standalone script against EVERY
 * package in EVERY production monorepo, runs Kotlin Prepublish against the
 * same input, and diffs the resolved dependency maps.
 *
 * This is the strongest signal that the Kotlin port matches bash. Surfaces
 * edge cases that hand-coded fixtures might miss.
 *
 * Skipped if run outside the meta-repo environment (none of the repos exist).
 *
 * Each package becomes its own JUnit 5 dynamic test, so you get per-package
 * pass/fail granularity in the report.
 */
class PrepublishParityTest {

    private val repos = listOf(
        "/root/nfa-repos/com/util",
        "/root/nfa-repos/com/hub",
        "/root/nfa-repos/com/dana",
        "/root/nfa-repos/com/hydra-service",
        "/root/nfa-repos/com/fileservice",
        "/root/nfa-repos/com/platform",
    )

    private val mapper = ObjectMapper().registerKotlinModule()

    @TestFactory
    fun `parity across all 6 production repos`(): List<DynamicTest> {
        val tests = mutableListOf<DynamicTest>()

        for (repoPath in repos) {
            val rootDir = File(repoPath)
            if (!rootDir.exists()) continue

            val bashScript = File(rootDir, "node_modules/@zerobias-org/devops-tools/scripts/prepublish-standalone.js")
            if (!bashScript.exists()) continue

            // Discover workspace packages
            val rootPkgFile = File(rootDir, "package.json")
            if (!rootPkgFile.exists()) continue
            val rootPkg: Map<String, Any?> = try {
                mapper.readValue(rootPkgFile)
            } catch (_: Exception) { continue }

            @Suppress("UNCHECKED_CAST")
            val workspaces = (rootPkg["workspaces"] as? List<String>) ?: continue

            // For each workspace entry, find concrete package directories
            val packageDirs = mutableListOf<File>()
            for (ws in workspaces) {
                if (ws.contains("*")) {
                    // Glob expansion: split on /*, walk
                    val baseStr = ws.substringBefore("/*")
                    val baseDir = File(rootDir, baseStr)
                    if (baseDir.isDirectory) {
                        baseDir.listFiles { f -> f.isDirectory && File(f, "package.json").exists() }
                            ?.forEach { packageDirs.add(it) }
                    }
                } else {
                    val d = File(rootDir, ws)
                    if (d.isDirectory && File(d, "package.json").exists()) {
                        packageDirs.add(d)
                    }
                }
            }

            // Skip the `stack` package — it has no source to scan and is a special case
            val filteredDirs = packageDirs.filter { it.name != "stack" }

            for (pkgDir in filteredDirs) {
                val repoName = rootDir.name
                val pkgName = pkgDir.relativeTo(rootDir).path
                val testName = "$repoName/$pkgName"

                tests.add(DynamicTest.dynamicTest(testName) {
                    runParity(bashScript, pkgDir, rootDir, testName)
                })
            }
        }

        if (tests.isEmpty()) {
            tests.add(DynamicTest.dynamicTest("no repos available") {
                assumeTrue(false, "No production repos found in environment")
            })
        }

        return tests
    }

    private fun runParity(bashScript: File, serviceDir: File, rootDir: File, label: String) {
        val bashDeps = runBashDryRun(bashScript, serviceDir, rootDir)
        val kotlinDeps = runKotlinDryRun(serviceDir, rootDir)

        val onlyInBash = bashDeps.keys - kotlinDeps.keys
        val onlyInKotlin = kotlinDeps.keys - bashDeps.keys
        val versionMismatches = bashDeps.keys.intersect(kotlinDeps.keys).filter { key ->
            bashDeps[key] != kotlinDeps[key]
        }

        if (onlyInBash.isNotEmpty() || onlyInKotlin.isNotEmpty() || versionMismatches.isNotEmpty()) {
            val msg = StringBuilder()
            msg.appendLine("Parity mismatch for $label:")
            msg.appendLine("  bash deps: ${bashDeps.size}, kotlin deps: ${kotlinDeps.size}")
            if (onlyInBash.isNotEmpty()) {
                msg.appendLine("  Only in BASH (${onlyInBash.size}):")
                onlyInBash.sorted().forEach { msg.appendLine("    - $it: ${bashDeps[it]}") }
            }
            if (onlyInKotlin.isNotEmpty()) {
                msg.appendLine("  Only in KOTLIN (${onlyInKotlin.size}):")
                onlyInKotlin.sorted().forEach { msg.appendLine("    + $it: ${kotlinDeps[it]}") }
            }
            if (versionMismatches.isNotEmpty()) {
                msg.appendLine("  Version mismatches (${versionMismatches.size}):")
                versionMismatches.sorted().forEach {
                    msg.appendLine("    ~ $it: bash=${bashDeps[it]} kotlin=${kotlinDeps[it]}")
                }
            }
            throw AssertionError(msg.toString())
        }
    }

    private fun runBashDryRun(bashScript: File, serviceDir: File, rootDir: File): Map<String, String> {
        val process = ProcessBuilder(
            "node",
            bashScript.absolutePath,
            serviceDir.absolutePath,
            rootDir.absolutePath,
            "--dry-run"
        )
            .redirectErrorStream(false)
            .start()
        val output = process.inputStream.bufferedReader().readText()
        val errorOutput = process.errorStream.bufferedReader().readText()
        val finished = process.waitFor(120, java.util.concurrent.TimeUnit.SECONDS)
        if (!finished) {
            process.destroyForcibly()
            throw RuntimeException("bash prepublish timed out for ${serviceDir.name}")
        }
        if (process.exitValue() != 0) {
            throw RuntimeException("bash prepublish failed for ${serviceDir.name} (exit ${process.exitValue()}):\n$errorOutput")
        }

        val deps = linkedMapOf<String, String>()
        val depsMatch = Regex("""Dependencies that would be included:\n([\s\S]*?)(?:\n\n|\nOverrides|$)""")
            .find(output)
        if (depsMatch != null) {
            for (line in depsMatch.groupValues[1].lines()) {
                val match = Regex("""^\s+(\S+):\s+(\S+)""").matchEntire(line)
                if (match != null) {
                    deps[match.groupValues[1]] = match.groupValues[2]
                }
            }
        }
        return deps
    }

    private fun runKotlinDryRun(serviceDir: File, rootDir: File): Map<String, String> {
        val result = Prepublish.resolve(serviceDir, rootDir, Prepublish.Options(dryRun = true))
        return result.dependencies
    }
}
