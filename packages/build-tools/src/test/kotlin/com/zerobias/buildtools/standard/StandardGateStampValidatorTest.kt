package com.zerobias.buildtools.standard

import org.junit.jupiter.api.Test
import org.junit.jupiter.api.Assertions.assertEquals

class StandardGateStampValidatorTest {

    private val sourceHash = "src-abc-123"
    private val testHash = "test-def-456"

    /**
     * Build a valid stamp JSON with the given hashes + task results +
     * optional test-suite block. Mirrors the JSON shape `writeGateStamp`
     * produces in `zb.base.gradle.kts`.
     */
    private fun stamp(
        srcHash: String = sourceHash,
        tstHash: String = testHash,
        tasks: List<Pair<String, String>> = StandardGateStampValidator.REQUIRED_TASKS.map { it to "passed" },
        testSuites: List<Triple<String, Int, String>> = listOf(),
    ): String {
        val tasksJson = tasks.joinToString(",\n    ") { (n, s) -> "\"$n\": \"$s\"" }
        val suitesJson = testSuites.joinToString(",\n    ") { (n, exp, st) ->
            "\"$n\": { \"expected\": $exp, \"ran\": $exp, \"status\": \"$st\" }"
        }
        return """
            {
              "version": "1.0.0",
              "branch": "main",
              "timestamp": "2026-04-13T00:00:00Z",
              "sourceHash": "$srcHash",
              "testHash": "$tstHash",
              "tasks": {
                $tasksJson
              },
              "tests": {
                $suitesJson
              }
            }
        """.trimIndent()
    }

    private fun validate(
        content: String?,
        currSrc: String = sourceHash,
        currTest: String = testHash,
        suites: List<StandardGateStampValidator.SuiteCount> = listOf(),
    ): StandardGateStampValidator.Outcome =
        StandardGateStampValidator.validate(content, currSrc, currTest, suites)

    // ── Missing / malformed ────────────────────────────────────────────

    @Test
    fun `null content (stamp file missing) → INVALID`() {
        val outcome = validate(null)
        assertEquals(StandardGateStampValidator.Result.INVALID, outcome.result)
        assertEquals("stamp-missing", outcome.reason)
    }

    @Test
    fun `stamp without sourceHash field → INVALID`() {
        val outcome = validate("""{ "branch": "main" }""")
        assertEquals(StandardGateStampValidator.Result.INVALID, outcome.result)
        assertEquals("stamp-malformed-no-source-hash", outcome.reason)
    }

    @Test
    fun `unparseable JSON → INVALID with malformed reason`() {
        val outcome = validate("not json at all")
        assertEquals(StandardGateStampValidator.Result.INVALID, outcome.result)
        assertEquals("stamp-malformed-no-source-hash", outcome.reason)
    }

    // ── Source hash drift ──────────────────────────────────────────────

    @Test
    fun `source hash mismatch → INVALID`() {
        val outcome = validate(stamp(srcHash = "OLD"), currSrc = "NEW")
        assertEquals(StandardGateStampValidator.Result.INVALID, outcome.result)
        assertEquals("source-hash-changed", outcome.reason)
    }

    @Test
    fun `source hash match with all defaults → VALID`() {
        val outcome = validate(stamp())
        assertEquals(StandardGateStampValidator.Result.VALID, outcome.result)
    }

    // ── Task result tolerance ──────────────────────────────────────────

    @Test
    fun `task status 'failed' → INVALID with task name in reason`() {
        val tasks = StandardGateStampValidator.REQUIRED_TASKS.map { name ->
            name to (if (name == "test") "failed" else "passed")
        }
        val outcome = validate(stamp(tasks = tasks))
        assertEquals(StandardGateStampValidator.Result.INVALID, outcome.result)
        assert(outcome.reason.contains("test")) { "reason should name failing task: ${outcome.reason}" }
        assert(outcome.reason.contains("failed")) { "reason should include status: ${outcome.reason}" }
    }

    @Test
    fun `task status 'up-to-date' counts as passing → VALID`() {
        val tasks = StandardGateStampValidator.REQUIRED_TASKS.map { name ->
            name to (if (name == "compile") "up-to-date" else "passed")
        }
        val outcome = validate(stamp(tasks = tasks))
        assertEquals(StandardGateStampValidator.Result.VALID, outcome.result)
    }

    @Test
    fun `task status 'skipped' counts as passing → VALID`() {
        val tasks = StandardGateStampValidator.REQUIRED_TASKS.map { name ->
            name to (if (name == "buildArtifacts") "skipped" else "passed")
        }
        val outcome = validate(stamp(tasks = tasks))
        assertEquals(StandardGateStampValidator.Result.VALID, outcome.result)
    }

    @Test
    fun `task status 'not-found' tolerated for forward-compat → VALID`() {
        val tasks = StandardGateStampValidator.REQUIRED_TASKS.map { name ->
            name to (if (name == "testDataloader") "not-found" else "passed")
        }
        val outcome = validate(stamp(tasks = tasks))
        assertEquals(StandardGateStampValidator.Result.VALID, outcome.result)
    }

    @Test
    fun `task missing entirely from stamp is silently ignored → VALID`() {
        // Older stamps may not carry every required task name. The
        // validator should treat missing entries as "no opinion" and keep
        // checking the rest, not bail with INVALID.
        val tasks = StandardGateStampValidator.REQUIRED_TASKS
            .filter { it != "testDirect" }
            .map { it to "passed" }
        val outcome = validate(stamp(tasks = tasks))
        assertEquals(StandardGateStampValidator.Result.VALID, outcome.result)
    }

    // ── Test hash drift ────────────────────────────────────────────────

    @Test
    fun `test hash mismatch → TESTS_CHANGED`() {
        val outcome = validate(stamp(tstHash = "OLD"), currTest = "NEW")
        assertEquals(StandardGateStampValidator.Result.TESTS_CHANGED, outcome.result)
        assertEquals("test-hash-changed", outcome.reason)
    }

    @Test
    fun `missing testHash field treated as empty → TESTS_CHANGED if current is non-empty`() {
        // Stamp was written by an older zbb that didn't yet record testHash.
        // Today's stamp HAS a testHash, so the diff trips TESTS_CHANGED.
        val noTestHashStamp = """
            {
              "sourceHash": "$sourceHash",
              "tasks": { "validate": "passed" }
            }
        """.trimIndent()
        val outcome = validate(noTestHashStamp)
        assertEquals(StandardGateStampValidator.Result.TESTS_CHANGED, outcome.result)
    }

    // ── Per-suite test count drift ────────────────────────────────────

    @Test
    fun `unit test count drifted from stamp → TESTS_CHANGED`() {
        val content = stamp(testSuites = listOf(Triple("unit", 12, "passed")))
        val outcome = validate(
            content,
            suites = listOf(StandardGateStampValidator.SuiteCount("unit", 14)),
        )
        assertEquals(StandardGateStampValidator.Result.TESTS_CHANGED, outcome.result)
        assert(outcome.reason.contains("unit")) { "reason should name suite: ${outcome.reason}" }
    }

    @Test
    fun `unit test count matches stamp → VALID`() {
        val content = stamp(testSuites = listOf(Triple("unit", 12, "passed")))
        val outcome = validate(
            content,
            suites = listOf(StandardGateStampValidator.SuiteCount("unit", 12)),
        )
        assertEquals(StandardGateStampValidator.Result.VALID, outcome.result)
    }

    @Test
    fun `suite missing from stamp but present in working tree → INVALID`() {
        // Working tree has integration tests but the stamp doesn't record
        // them. Either the stamp predates the suite or someone tampered —
        // safest bet is force a re-gate.
        val content = stamp(testSuites = listOf(Triple("unit", 12, "passed")))
        val outcome = validate(
            content,
            suites = listOf(
                StandardGateStampValidator.SuiteCount("unit", 12),
                StandardGateStampValidator.SuiteCount("integration", 5),
            ),
        )
        assertEquals(StandardGateStampValidator.Result.INVALID, outcome.result)
        assert(outcome.reason.contains("integration")) { "reason should name suite: ${outcome.reason}" }
    }

    @Test
    fun `suite recorded as failed → INVALID`() {
        val content = stamp(testSuites = listOf(Triple("unit", 12, "failed")))
        val outcome = validate(
            content,
            suites = listOf(StandardGateStampValidator.SuiteCount("unit", 12)),
        )
        assertEquals(StandardGateStampValidator.Result.INVALID, outcome.result)
        assert(outcome.reason.contains("unit")) { "reason should name suite: ${outcome.reason}" }
        assert(outcome.reason.contains("failed")) { "reason should include status: ${outcome.reason}" }
    }

    @Test
    fun `suite with currentExpected==0 is ignored (no tests in working tree)`() {
        // The stamp recorded an integration suite, but the working tree
        // currently has zero `it()` calls there (e.g. the suite was
        // deleted). Validator should not require the stamp entry at all.
        val content = stamp(testSuites = listOf(Triple("integration", 7, "passed")))
        val outcome = validate(
            content,
            suites = listOf(StandardGateStampValidator.SuiteCount("integration", 0)),
        )
        assertEquals(StandardGateStampValidator.Result.VALID, outcome.result)
    }

    // ── Order of precedence ────────────────────────────────────────────

    @Test
    fun `source hash drift trumps test count drift → INVALID, not TESTS_CHANGED`() {
        // If both source AND tests changed, INVALID wins because we need
        // to rerun everything, not just tests.
        val content = stamp(
            srcHash = "OLD",
            testSuites = listOf(Triple("unit", 12, "passed")),
        )
        val outcome = validate(
            content,
            currSrc = "NEW",
            suites = listOf(StandardGateStampValidator.SuiteCount("unit", 14)),
        )
        assertEquals(StandardGateStampValidator.Result.INVALID, outcome.result)
        assertEquals("source-hash-changed", outcome.reason)
    }

    @Test
    fun `task failure trumps test hash drift → INVALID, not TESTS_CHANGED`() {
        val tasks = StandardGateStampValidator.REQUIRED_TASKS.map { name ->
            name to (if (name == "lint") "failed" else "passed")
        }
        val content = stamp(tasks = tasks, tstHash = "OLD")
        val outcome = validate(content, currTest = "NEW")
        assertEquals(StandardGateStampValidator.Result.INVALID, outcome.result)
        assert(outcome.reason.contains("lint"))
    }
}
