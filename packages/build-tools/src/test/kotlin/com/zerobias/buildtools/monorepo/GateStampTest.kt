package com.zerobias.buildtools.monorepo

import org.junit.jupiter.api.Test
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNotNull
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.io.TempDir
import java.io.File
import java.nio.file.Path

class GateStampTest {

    private fun sampleStamp(): GateStamp = GateStamp(
        version = 1,
        branch = "main",
        timestamp = "2026-04-08T12:00:00.000Z",
        packages = linkedMapOf(
            "@scope/foo" to PackageStampEntry(
                version = "1.0.0",
                sourceHash = "abc123",
                testHash = "def456",
                rootDeps = linkedMapOf("lodash" to "^4.17.21", "tslib" to "^2.0.0"),
                tasks = linkedMapOf(
                    "lint" to "passed",
                    "transpile" to "passed",
                    "test" to "passed",
                ),
                tests = linkedMapOf(
                    "unit" to TestSuiteEntry(expected = 12, ran = 12, status = "passed"),
                    "integration" to TestSuiteEntry(expected = 0, ran = 0, status = "skipped"),
                ),
            ),
        ),
    )

    @Test
    fun `write produces 2-space indented JSON with trailing newline`(@TempDir tmp: Path) {
        val file = tmp.resolve("gate-stamp.json").toFile()
        GateStampIO.write(file, sampleStamp())
        val content = file.readText()

        // Trailing newline (matches JS JSON.stringify(_, null, 2) + '\n')
        assert(content.endsWith("\n")) { "stamp must end with newline, got: ${content.takeLast(20).map { it.code }}" }

        // 2-space indent at first level
        assert(content.contains("\n  \"version\":")) { "expected 2-space indented version key, got:\n$content" }

        // Nested 4-space indent for package fields
        assert(content.contains("\n    \"@scope/foo\":")) { "expected 4-space indented package key" }

        // Colon-space separator
        assert(content.contains("\"version\": 1")) { "expected colon-space format" }
    }

    @Test
    fun `read round-trip preserves data`(@TempDir tmp: Path) {
        val file = tmp.resolve("gate-stamp.json").toFile()
        val original = sampleStamp()
        GateStampIO.write(file, original)

        val loaded = GateStampIO.read(file)
        assertNotNull(loaded)
        assertEquals(original.version, loaded!!.version)
        assertEquals(original.branch, loaded.branch)
        assertEquals(original.timestamp, loaded.timestamp)
        assertEquals(original.packages.size, loaded.packages.size)

        val foo = loaded.packages["@scope/foo"]
        assertNotNull(foo)
        assertEquals("abc123", foo!!.sourceHash)
        assertEquals("def456", foo.testHash)
        assertEquals("^4.17.21", foo.rootDeps?.get("lodash"))
        assertEquals("passed", foo.tasks["lint"])
        assertEquals(12, foo.tests["unit"]?.expected)
    }

    @Test
    fun `read returns null for missing file`(@TempDir tmp: Path) {
        val missing = tmp.resolve("nonexistent.json").toFile()
        assertNull(GateStampIO.read(missing))
    }

    @Test
    fun `read returns null for malformed JSON`(@TempDir tmp: Path) {
        val file = tmp.resolve("bad.json").toFile()
        file.writeText("{ not valid json")
        assertNull(GateStampIO.read(file))
    }

    @Test
    fun `parity round-trip with real TS-generated stamp from com-util`(@TempDir tmp: Path) {
        // Load a real production stamp written by lib/monorepo/GateStamp.ts.
        // This is the canonical byte-equality test: read the file, write it back,
        // and assert byte-for-byte equality.
        val resource = javaClass.classLoader.getResource("fixtures/gate-stamps/com-util.json")
        assertNotNull(resource) { "fixture not found on classpath" }
        val originalBytes = resource!!.readBytes()
        val originalText = String(originalBytes, Charsets.UTF_8)

        val tmpInput = tmp.resolve("input.json").toFile()
        tmpInput.writeBytes(originalBytes)

        // Read via Jackson
        val stamp = GateStampIO.read(tmpInput)
        assertNotNull(stamp) { "failed to parse real stamp" }

        // Write back
        val tmpOutput = tmp.resolve("output.json").toFile()
        GateStampIO.write(tmpOutput, stamp!!)
        val rewrittenText = tmpOutput.readText()

        // Diff line by line for friendlier error messages
        val originalLines = originalText.split("\n")
        val rewrittenLines = rewrittenText.split("\n")

        if (originalText != rewrittenText) {
            val diffs = StringBuilder()
            val maxLines = maxOf(originalLines.size, rewrittenLines.size)
            for (i in 0 until maxLines) {
                val o = originalLines.getOrNull(i) ?: "<EOF>"
                val r = rewrittenLines.getOrNull(i) ?: "<EOF>"
                if (o != r) {
                    diffs.appendLine("line ${i + 1}:")
                    diffs.appendLine("  expected: $o")
                    diffs.appendLine("  actual:   $r")
                }
            }
            throw AssertionError("byte-equality failed:\n$diffs")
        }
    }

    @Test
    fun `package without rootDeps roundtrips correctly (older stamps)`(@TempDir tmp: Path) {
        val stampWithoutRootDeps = sampleStamp().copy(
            packages = linkedMapOf(
                "@scope/foo" to sampleStamp().packages["@scope/foo"]!!.copy(rootDeps = null)
            )
        )
        val file = tmp.resolve("stamp.json").toFile()
        GateStampIO.write(file, stampWithoutRootDeps)
        val content = file.readText()

        // rootDeps should be omitted (NON_NULL)
        assert(!content.contains("rootDeps")) { "rootDeps should be omitted when null, got:\n$content" }

        val loaded = GateStampIO.read(file)
        assertNull(loaded?.packages?.get("@scope/foo")?.rootDeps)
    }
}
