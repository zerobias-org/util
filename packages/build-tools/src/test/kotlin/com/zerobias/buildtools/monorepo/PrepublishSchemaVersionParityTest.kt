package com.zerobias.buildtools.monorepo

import com.fasterxml.jackson.databind.ObjectMapper
import com.fasterxml.jackson.module.kotlin.readValue
import com.fasterxml.jackson.module.kotlin.registerKotlinModule
import org.junit.jupiter.api.Assumptions.assumeTrue
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import java.io.File
import java.nio.file.Path
import java.util.concurrent.TimeUnit

/**
 * Executes BOTH prepublish implementations — Kotlin `Prepublish` and devops'
 * `prepublish-standalone.js` — against the same synthetic fixture and asserts
 * they stamp the identical `schemaVersion`.
 *
 * Why this exists: `Prepublish.kt` carried a comment claiming "Parity:
 * prepublish-standalone.js does the same" while the JS had no schemaVersion
 * logic at all, so anything publishing through the JS path shipped a manifest
 * with no schemaVersion — and an absent value makes the deploy-side
 * schema-check init container skip silently.
 *
 * PrepublishParityTest could never have caught it: it runs `--dry-run`, which
 * writes no manifest, and only diffs the resolved dependency map. This test
 * does real `--target-dir` runs and compares the written artifacts.
 *
 * Fixtures are synthetic (no node_modules, no meta-repo packages), so this runs
 * anywhere the devops checkout is present.
 */
class PrepublishSchemaVersionParityTest {

    private val mapper = ObjectMapper().registerKotlinModule()

    private val jsScript: File? =
        MetaRepo.devops?.resolve("tools/scripts/prepublish-standalone.js")?.takeIf { it.isFile }

    // ── Fixture ──────────────────────────────────────────────────────

    /**
     * Minimal workspace: a root with [rootDeps]/[rootDevDeps] and an optional
     * hydra-schema pin in the lock, plus one service importing [imports].
     */
    private fun fixture(
        tmp: Path,
        imports: List<String>,
        rootDeps: Map<String, String>,
        lockedSchemaVersion: String?,
        rootDevDeps: Map<String, String> = emptyMap(),
    ): Pair<File, File> {
        val root = tmp.resolve("root").toFile()
        val svc = File(root, "svc")
        File(svc, "src").mkdirs()

        root.resolve("package.json").writeText(
            mapper.writeValueAsString(
                mapOf(
                    "name" to "root",
                    "workspaces" to listOf("svc"),
                    "dependencies" to rootDeps,
                    "devDependencies" to rootDevDeps,
                ),
            ),
        )

        val lockPackages = buildMap<String, Any> {
            lockedSchemaVersion?.let {
                put("node_modules/${Prepublish.HYDRA_SCHEMA_PACKAGE}", mapOf("version" to it))
            }
        }
        root.resolve("package-lock.json").writeText(
            mapper.writeValueAsString(mapOf("lockfileVersion" to 3, "packages" to lockPackages)),
        )

        File(svc, "package.json").writeText(
            mapper.writeValueAsString(mapOf("name" to "@scope/svc", "version" to "1.0.0")),
        )
        File(svc, "src/index.ts").writeText(
            imports.joinToString("\n") { "import { x } from '$it'" } + "\n",
        )
        return root to svc
    }

    // ── Runners ──────────────────────────────────────────────────────

    /** Kotlin path: write to [out], return the stamped schemaVersion. */
    private fun kotlinSchemaVersion(svc: File, root: File, out: File): String? {
        out.mkdirs()
        Prepublish.resolve(svc, root, Prepublish.Options(targetDir = out))
        return readSchemaVersion(File(out, "package.json"))
    }

    /** JS path: same inputs through prepublish-standalone.js. */
    private fun jsSchemaVersion(svc: File, root: File, out: File): String? {
        out.mkdirs()
        val proc = ProcessBuilder(
            "node", jsScript!!.absolutePath,
            svc.absolutePath, root.absolutePath,
            "--target-dir=${out.absolutePath}",
        ).redirectErrorStream(false).start()
        val stdout = proc.inputStream.bufferedReader().readText()
        val stderr = proc.errorStream.bufferedReader().readText()
        if (!proc.waitFor(120, TimeUnit.SECONDS)) {
            proc.destroyForcibly()
            throw RuntimeException("prepublish-standalone.js timed out")
        }
        check(proc.exitValue() == 0) {
            "prepublish-standalone.js failed (exit ${proc.exitValue()}):\n$stderr\n$stdout"
        }
        return readSchemaVersion(File(out, "package.json"))
    }

    private fun readSchemaVersion(manifest: File): String? {
        val json: Map<String, Any?> = mapper.readValue(manifest)
        return json["schemaVersion"] as? String
    }

    /** Run both implementations and assert they agree with [expected]. */
    private fun assertParity(
        tmp: Path,
        imports: List<String>,
        rootDeps: Map<String, String>,
        lockedSchemaVersion: String?,
        expected: String?,
        rootDevDeps: Map<String, String> = emptyMap(),
    ) {
        assumeTrue(jsScript != null) { "org/devops checkout not found — cannot run the JS path" }
        val (root, svc) = fixture(tmp, imports, rootDeps, lockedSchemaVersion, rootDevDeps)

        val kotlin = kotlinSchemaVersion(svc, root, tmp.resolve("out-kotlin").toFile())
        val js = jsSchemaVersion(svc, root, tmp.resolve("out-js").toFile())

        assertEquals(expected, kotlin) { "Kotlin Prepublish stamped the wrong schemaVersion" }
        assertEquals(expected, js) { "prepublish-standalone.js stamped the wrong schemaVersion" }
        assertEquals(kotlin, js) { "Kotlin and JS prepublish disagree — the paths have drifted" }
    }

    // ── Cases ────────────────────────────────────────────────────────

    @Test
    fun `hydra-dao consumer is stamped identically by both paths`(@TempDir tmp: Path) {
        assertParity(
            tmp,
            imports = listOf("@zerobias-com/hydra-dao"),
            rootDeps = mapOf("@zerobias-com/hydra-dao" to "3.0.66"),
            lockedSchemaVersion = "2.0.50",
            expected = "2.0.50",
        )
    }

    @Test
    fun `hydra-core consumer is stamped identically by both paths`(@TempDir tmp: Path) {
        assertParity(
            tmp,
            imports = listOf("@zerobias-com/hydra-core"),
            rootDeps = mapOf("@zerobias-com/hydra-core" to "3.0.46"),
            lockedSchemaVersion = "2.0.49",
            expected = "2.0.49",
        )
    }

    @Test
    fun `both paths read the lock, not the package-json range`(@TempDir tmp: Path) {
        // The regression that started this: root pinned ^2.0.50 while the lock
        // resolved 2.0.51. Stamping the range would publish a version that was
        // never installed.
        assertParity(
            tmp,
            imports = listOf("@zerobias-com/hydra-dao"),
            rootDeps = mapOf("@zerobias-com/hydra-dao" to "3.0.66"),
            rootDevDeps = mapOf(Prepublish.HYDRA_SCHEMA_PACKAGE to "^2.0.50"),
            lockedSchemaVersion = "2.0.51",
            expected = "2.0.51",
        )
    }

    @Test
    fun `a direct hydra-schema consumer is stamped by both paths`(@TempDir tmp: Path) {
        // platform-content's shape: depends on the DDL package itself, no
        // hydra-core/hydra-dao. It used to be the one package a hydra-schema
        // bump marked as changed and the one package never stamped.
        assertParity(
            tmp,
            imports = listOf(Prepublish.HYDRA_SCHEMA_PACKAGE),
            rootDeps = mapOf(Prepublish.HYDRA_SCHEMA_PACKAGE to "2.0.50"),
            lockedSchemaVersion = "2.0.50",
            expected = "2.0.50",
        )
    }

    @Test
    fun `neither path stamps a package with no hydra dependency`(@TempDir tmp: Path) {
        assertParity(
            tmp,
            imports = listOf("express"),
            rootDeps = mapOf("express" to "5.1.0"),
            lockedSchemaVersion = "2.0.50",
            expected = null,
        )
    }

    @Test
    fun `neither path stamps when the lock has no hydra-schema`(@TempDir tmp: Path) {
        assertParity(
            tmp,
            imports = listOf("@zerobias-com/hydra-dao"),
            rootDeps = mapOf("@zerobias-com/hydra-dao" to "3.0.66"),
            lockedSchemaVersion = null,
            expected = null,
        )
    }
}
