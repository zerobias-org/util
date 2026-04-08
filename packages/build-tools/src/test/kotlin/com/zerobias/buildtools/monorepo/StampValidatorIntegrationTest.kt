package com.zerobias.buildtools.monorepo

import com.fasterxml.jackson.databind.ObjectMapper
import com.fasterxml.jackson.module.kotlin.readValue
import com.fasterxml.jackson.module.kotlin.registerKotlinModule
import com.zerobias.buildtools.util.SourceHasher
import org.junit.jupiter.api.Assumptions.assumeTrue
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNotNull
import java.io.File

/**
 * Integration test that validates the Kotlin gate stamp logic against a REAL
 * production monorepo (com/util) with its committed gate-stamp.json and real
 * source files.
 *
 * Skipped if run outside the meta-repo environment (com/util not present).
 *
 * This is the strongest signal that the Kotlin port matches the TS path:
 * if our SourceHasher computes the same SHA-256 as the TS GateStamp.computeSourceHash
 * for a real package, validation returns VALID — meaning the TS-written stamp
 * is round-trippable through our Kotlin without invalidation.
 */
class StampValidatorIntegrationTest {

    private val comUtilRoot = File("/root/nfa-repos/com/util")
    private val isAvailable = comUtilRoot.exists() && File(comUtilRoot, "gate-stamp.json").exists()

    @Test
    fun `validates real com-util stamp against real source files`() {
        assumeTrue(isAvailable, "com/util not present in environment")

        val stampFile = File(comUtilRoot, "gate-stamp.json")
        val stamp = GateStampIO.read(stampFile)
        assertNotNull(stamp) { "failed to parse com/util gate-stamp.json" }

        // util-dynamodb is a small, well-defined package — pick it as the test target
        val pkgName = "@zerobias-com/util-dynamodb"
        val pkgDir = File(comUtilRoot, "packages/dynamodb")
        assumeTrue(pkgDir.exists(), "util-dynamodb package dir not found")

        val stampEntry = stamp!!.packages[pkgName]
        assertNotNull(stampEntry) { "$pkgName not in stamp" }

        // Compute the source hash with the same parameters the TS code uses
        // (sourceFiles defaults to [tsconfig.json], sourceDirs to [src])
        val computedHash = SourceHasher.hashSources(
            packageDir = pkgDir,
            // From com/util/.zbb.yaml monorepo block
            sourceFiles = listOf("tsconfig.json", "api.yml", "package.json"),
            sourceDirs = listOf("src"),
        )

        // The recorded sourceHash in the stamp must match what we just computed.
        // If this fails, the Kotlin SourceHasher diverges from the TS implementation.
        assertEquals(stampEntry!!.sourceHash, computedHash) {
            """
            Source hash mismatch — Kotlin SourceHasher diverges from TS GateStamp.

            Package: $pkgName
            Dir:     ${pkgDir.absolutePath}
            Stamp:   ${stampEntry.sourceHash}
            Kotlin:  $computedHash

            This means the gate stamp written by the TS path would be marked
            INVALID when validated by the Kotlin path, breaking parity.
            """.trimIndent()
        }
    }

    @Test
    fun `full validate() returns VALID for unmodified com-util stamp`() {
        assumeTrue(isAvailable, "com/util not present in environment")

        val stampFile = File(comUtilRoot, "gate-stamp.json")
        val stamp = GateStampIO.read(stampFile)
        assertNotNull(stamp)

        // Read root package.json for the rootDeps drift check
        val rootPkgFile = File(comUtilRoot, "package.json")
        val mapper = ObjectMapper().registerKotlinModule()
        val rootPkg: Map<String, Any?> = mapper.readValue(rootPkgFile)

        val validator = StampValidator(
            // From com/util/.zbb.yaml monorepo block
            sourceFiles = listOf("tsconfig.json", "api.yml", "package.json"),
            sourceDirs = listOf("src"),
            testPhases = setOf("test"),
        )

        val pkgName = "@zerobias-com/util-dynamodb"
        val pkgDir = File(comUtilRoot, "packages/dynamodb")
        assumeTrue(pkgDir.exists())

        val result = validator.validate(
            packageDir = pkgDir,
            packageName = pkgName,
            stamp = stamp,
            rootPackageJson = rootPkg,
        )

        assertEquals(GateStampResult.VALID, result) {
            "Expected VALID for unmodified com/util util-dynamodb stamp, got $result"
        }
    }
}
