package com.zerobias.buildtools.util

import org.junit.jupiter.api.Test
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Assumptions.assumeTrue
import java.io.File

/**
 * Guards the env contract between build-tools and zbb's hermetic seal.
 *
 * Every env var that build-tools reads via `System.getenv("X")` must be
 * COVERED by zbb's per-command env contracts in
 * packages/zbb/lib/env/effective.ts — one of:
 *   - a COMMAND_ENV_CONTRACT (a lifecycle command needs it through the LOCAL seal),
 *   - ENV_CONTRACT_IGNORED (prod-default override / framework var, stays strippable),
 *   - SYSTEM_BASE_VARS (OS machinery).
 *
 * Without this, adding `System.getenv("NEW_VAR")` to a build-tools task would
 * silently get stripped by the seal and fail only in a real local gate/publish.
 * This test fails at build time instead, telling you to register it.
 *
 * (In CI the seal is off, so this is purely about the local-dispatch contract.)
 */
class EnvContractCoverageTest {

    @Test
    fun `every build-tools System_getenv literal is covered by a zbb env contract`() {
        // effective.ts lives in the sibling zbb package. Skip cleanly if it
        // isn't alongside (isolated / published-artifact build).
        val effective = listOf(
            File("../zbb/lib/env/effective.ts"),
            File("../../zbb/lib/env/effective.ts"),
        ).firstOrNull { it.isFile }
        assumeTrue(effective != null) { "zbb effective.ts not found alongside — skipping coverage check" }

        val getenvRe = Regex("""System\.getenv\("([A-Z_][A-Z0-9_]*)"\)""")
        val read = File("src/main").walkTopDown()
            .filter { it.isFile && (it.extension == "kt" || it.extension == "kts") }
            .flatMap { f -> getenvRe.findAll(f.readText()).map { it.groupValues[1] } }
            .toSortedSet()

        // Covered = every single-quoted UPPER_SNAKE literal in effective.ts
        // (SYSTEM_BASE_VARS + the command contracts + ENV_CONTRACT_IGNORED).
        val covered = Regex("""'([A-Z_][A-Z0-9_]*)'""")
            .findAll(effective!!.readText())
            .map { it.groupValues[1] }
            .toSet()

        val missing = read.filterNot { it in covered }.sorted()
        assertTrue(missing.isEmpty()) {
            "These build-tools System.getenv() vars are NOT covered by zbb's env contracts " +
            "(packages/zbb/lib/env/effective.ts) — the hermetic seal will strip them at runtime. " +
            "Add each to a COMMAND_ENV_CONTRACT (if a lifecycle command needs it through the local " +
            "seal) or to ENV_CONTRACT_IGNORED (prod-default override / framework var): $missing"
        }
    }
}
