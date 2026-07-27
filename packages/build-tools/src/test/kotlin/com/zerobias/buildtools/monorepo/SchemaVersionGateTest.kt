package com.zerobias.buildtools.monorepo

import com.zerobias.buildtools.util.SourceHasher
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNotNull
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import java.io.File
import java.nio.file.Path

/**
 * Regression coverage for the schemaVersion gate input.
 *
 * `prepublishPackage` stamps the lock-resolved `@zerobias-com/hydra-schema`
 * version into the published manifest, but hydra-schema is DDL that no service
 * ever `import`s — so it never enters `resolveRootDeps`' import-scanned snapshot
 * and never contributes to sourceHash. Before this was tracked, bumping
 * hydra-schema left every stamped package's gate entry byte-identical: the gate
 * reported VALID, `prepublishPackage` was skipped, and the artifact shipped the
 * *previous* schemaVersion. Terraform then read that stale value and pinned
 * deployments to a schema that was no longer current.
 *
 * The load-bearing case is `schemaVersion drift alone invalidates an otherwise
 * pristine stamp` — everything else here guards its supporting pieces.
 */
class SchemaVersionGateTest {

    private val sourceFiles = listOf("package.json")
    private val sourceDirs = listOf("src")

    // ── Fixtures ─────────────────────────────────────────────────────

    /** Root lock with hydra-schema at [version] (lockfileVersion 3 layout). */
    private fun writeLockV3(rootDir: File, version: String?) {
        val entry = version?.let {
            """"node_modules/${Prepublish.HYDRA_SCHEMA_PACKAGE}": { "version": "$it" }"""
        } ?: ""
        File(rootDir, "package-lock.json")
            .writeText("""{ "lockfileVersion": 3, "packages": { $entry } }""")
    }

    /** Root lock in the legacy v1 layout, where deps live under `dependencies`. */
    private fun writeLockV1(rootDir: File, version: String) {
        File(rootDir, "package-lock.json").writeText(
            """{ "lockfileVersion": 1, "dependencies": { "${Prepublish.HYDRA_SCHEMA_PACKAGE}": { "version": "$version" } } }""",
        )
    }

    /**
     * A minimal package dir with no `files` field — so the untracked-published
     * guard finds nothing and validation reaches the checks under test.
     */
    private fun makePackage(tmp: Path, name: String = "svc"): File {
        val dir = tmp.resolve(name).toFile()
        File(dir, "src").mkdirs()
        File(dir, "package.json").writeText("""{ "name": "@scope/$name", "version": "1.0.0" }""")
        File(dir, "src/index.ts").writeText("export const x = 1\n")
        return dir
    }

    /**
     * A stamp entry whose hashes genuinely match [pkgDir], so the only thing
     * that can flip validation is the field the test is exercising.
     */
    private fun freshEntry(pkgDir: File, schemaVersion: String?) = PackageStampEntry(
        version = "1.0.0",
        sourceHash = SourceHasher.hashSources(
            pkgDir, sourceFiles, sourceDirs, SourceHasher.readFilesPatterns(pkgDir),
        ),
        testHash = SourceHasher.hashTests(pkgDir),
        tasks = linkedMapOf("transpile" to "passed", "test" to "passed"),
        tests = linkedMapOf("unit" to TestSuiteEntry(expected = 1, ran = 1, status = "passed")),
        schemaVersion = schemaVersion,
    )

    private fun stampFor(pkgDir: File, schemaVersion: String?) = GateStamp(
        version = 1,
        branch = "main",
        packages = linkedMapOf("@scope/svc" to freshEntry(pkgDir, schemaVersion)),
    )

    private fun validator() = StampValidator(sourceFiles, sourceDirs, testPhases = setOf("test"))

    // ── Lock resolution ──────────────────────────────────────────────

    @Test
    fun `readHydraSchemaVersion reads the lockfile v3 packages map`(@TempDir tmp: Path) {
        val root = tmp.toFile()
        writeLockV3(root, "2.0.50")
        assertEquals("2.0.50", Prepublish.readHydraSchemaVersion(root))
    }

    @Test
    fun `readHydraSchemaVersion falls back to the v1 dependencies map`(@TempDir tmp: Path) {
        val root = tmp.toFile()
        writeLockV1(root, "2.0.49")
        assertEquals("2.0.49", Prepublish.readHydraSchemaVersion(root))
    }

    @Test
    fun `readHydraSchemaVersion returns null with no lock or no hydra-schema entry`(@TempDir tmp: Path) {
        val root = tmp.toFile()
        assertNull(Prepublish.readHydraSchemaVersion(root), "no lock file at all")

        writeLockV3(root, null)
        assertNull(Prepublish.readHydraSchemaVersion(root), "lock present but no hydra-schema")
    }

    @Test
    fun `readHydraSchemaVersion resolves the lock, not the package-json range`(@TempDir tmp: Path) {
        // The whole point of reading the lock: a caret range can hold steady at
        // ^2.0.50 while the resolved version moves underneath it. Reading the
        // range would report no change and skip the republish.
        val root = tmp.toFile()
        File(root, "package.json").writeText(
            """{ "devDependencies": { "${Prepublish.HYDRA_SCHEMA_PACKAGE}": "^2.0.50" } }""",
        )
        writeLockV3(root, "2.0.51")
        assertEquals("2.0.51", Prepublish.readHydraSchemaVersion(root))
    }

    // ── Stamp-trigger selection ──────────────────────────────────────

    @Test
    fun `schemaVersionFor stamps only packages carrying a hydra runtime dep`(@TempDir tmp: Path) {
        val root = tmp.toFile()
        writeLockV3(root, "2.0.50")

        assertEquals("2.0.50", Prepublish.schemaVersionFor(setOf("@zerobias-com/hydra-dao"), root))
        assertEquals("2.0.50", Prepublish.schemaVersionFor(setOf("@zerobias-com/hydra-core"), root))
        assertEquals(
            "2.0.50",
            Prepublish.schemaVersionFor(setOf("express", Prepublish.HYDRA_SCHEMA_PACKAGE), root),
            "a direct hydra-schema dependency is the clearest 'built against this schema' case " +
                "and must be stamped — excluding it is what left platform-content unstamped",
        )
        assertNull(Prepublish.schemaVersionFor(setOf("express", "@zerobias-org/logger"), root))
        assertNull(Prepublish.schemaVersionFor(emptySet(), root))
    }

    @Test
    fun `schemaVersionFor yields null when the lock has no hydra-schema`(@TempDir tmp: Path) {
        val root = tmp.toFile()
        writeLockV3(root, null)
        assertNull(Prepublish.schemaVersionFor(setOf("@zerobias-com/hydra-dao"), root))
    }

    // ── Serialization ────────────────────────────────────────────────

    @Test
    fun `schemaVersion round-trips and is omitted when absent`(@TempDir tmp: Path) {
        val pkgDir = makePackage(tmp)

        val withVersion = tmp.resolve("with.json").toFile()
        GateStampIO.write(withVersion, stampFor(pkgDir, "2.0.50"))
        assertTrue(withVersion.readText().contains(""""schemaVersion": "2.0.50""""))
        assertEquals("2.0.50", GateStampIO.read(withVersion)!!.packages["@scope/svc"]!!.schemaVersion)

        // NON_NULL: non-hydra packages must not gain a null key — that would
        // rewrite every stamp entry in every repo on the first gate run.
        val without = tmp.resolve("without.json").toFile()
        GateStampIO.write(without, stampFor(pkgDir, null))
        assertTrue(!without.readText().contains("schemaVersion")) {
            "null schemaVersion must be omitted, got:\n${without.readText()}"
        }
        assertNull(GateStampIO.read(without)!!.packages["@scope/svc"]!!.schemaVersion)
    }

    @Test
    fun `stamps written before this field still parse`(@TempDir tmp: Path) {
        val file = tmp.resolve("legacy.json").toFile()
        file.writeText(
            """
            {
              "version": 1,
              "branch": "main",
              "packages": {
                "@scope/svc": {
                  "version": "1.0.0",
                  "sourceHash": "abc",
                  "testHash": "def",
                  "tasks": { "transpile": "passed" },
                  "tests": {}
                }
              }
            }
            """.trimIndent(),
        )
        val loaded = GateStampIO.read(file)
        assertNotNull(loaded)
        assertNull(loaded!!.packages["@scope/svc"]!!.schemaVersion)
    }

    // ── The regression ───────────────────────────────────────────────

    @Test
    fun `schemaVersion drift alone invalidates an otherwise pristine stamp`(@TempDir tmp: Path) {
        val root = tmp.toFile()
        val pkgDir = makePackage(tmp)

        // Stamp gated against 2.0.49; hydra-schema has since moved to 2.0.50.
        // Nothing else differs — same sources, same hashes, same root deps.
        // This is exactly the platform-events case that shipped a stale stamp.
        writeLockV3(root, "2.0.50")
        val v = validator().validateDetailed(
            packageDir = pkgDir,
            packageName = "@scope/svc",
            stamp = stampFor(pkgDir, "2.0.49"),
            rootPackageJson = emptyMap(),
            rootDir = root,
        )

        assertEquals(GateStampResult.INVALID, v.result) {
            "a hydra-schema bump must force a republish; got ${v.result} (${v.reason})"
        }
        val reason = v.reason.orEmpty()
        assertTrue(reason.contains("schemaVersion drift")) { "unhelpful reason: $reason" }
        assertTrue(reason.contains("2.0.49") && reason.contains("2.0.50")) {
            "reason must name both versions: $reason"
        }
    }

    @Test
    fun `matching schemaVersion stays VALID`(@TempDir tmp: Path) {
        val root = tmp.toFile()
        val pkgDir = makePackage(tmp)
        writeLockV3(root, "2.0.50")

        val result = validator().validate(
            packageDir = pkgDir,
            packageName = "@scope/svc",
            stamp = stampFor(pkgDir, "2.0.50"),
            rootPackageJson = emptyMap(),
            rootDir = root,
        )
        assertEquals(GateStampResult.VALID, result) { "an unchanged schema version must not force a rebuild" }
    }

    @Test
    fun `hydra-schema disappearing from the lock also invalidates`(@TempDir tmp: Path) {
        val root = tmp.toFile()
        val pkgDir = makePackage(tmp)
        writeLockV3(root, null)

        val v = validator().validateDetailed(
            packageDir = pkgDir,
            packageName = "@scope/svc",
            stamp = stampFor(pkgDir, "2.0.49"),
            rootPackageJson = emptyMap(),
            rootDir = root,
        )
        assertEquals(GateStampResult.INVALID, v.result)
        assertTrue(v.reason.orEmpty().contains("<absent>")) { "reason should show the value is gone: ${v.reason}" }
    }

    @Test
    fun `check is skipped when the caller passes no rootDir`(@TempDir tmp: Path) {
        // Back-compat: callers that never opt in keep their old behaviour rather
        // than hard-failing on an unreadable lock.
        val pkgDir = makePackage(tmp)
        val result = validator().validate(
            packageDir = pkgDir,
            packageName = "@scope/svc",
            stamp = stampFor(pkgDir, "2.0.49"),
            rootPackageJson = emptyMap(),
        )
        assertEquals(GateStampResult.VALID, result)
    }

    @Test
    fun `entries with no recorded schemaVersion are not drift-checked`(@TempDir tmp: Path) {
        // Non-hydra packages, and stamps predating the field, must not be
        // invalidated just because a lock happens to contain hydra-schema.
        val root = tmp.toFile()
        val pkgDir = makePackage(tmp)
        writeLockV3(root, "2.0.50")

        val result = validator().validate(
            packageDir = pkgDir,
            packageName = "@scope/svc",
            stamp = stampFor(pkgDir, null),
            rootPackageJson = emptyMap(),
            rootDir = root,
        )
        assertEquals(GateStampResult.VALID, result)
    }
}
