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
        dataloaderEnv: String? = null,
    ): String {
        val tasksJson = tasks.joinToString(",\n    ") { (n, s) -> "\"$n\": \"$s\"" }
        val suitesJson = testSuites.joinToString(",\n    ") { (n, exp, st) ->
            "\"$n\": { \"expected\": $exp, \"ran\": $exp, \"status\": \"$st\" }"
        }
        val envLine = dataloaderEnv?.let { "\n              \"dataloaderEnv\": \"$it\"," } ?: ""
        return """
            {
              "version": "1.0.0",
              "branch": "main",
              "sourceHash": "$srcHash",
              "testHash": "$tstHash",$envLine
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
        distTag: String = "latest",
    ): StandardGateStampValidator.Outcome =
        StandardGateStampValidator.validate(content, currSrc, currTest, suites, distTag)

    // ── Dataloader environment ─────────────────────────────────────────

    @Test
    fun `stamp without dataloaderEnv is a prod check, valid on every branch`() {
        for (distTag in listOf("dev", "qa", "uat", "latest")) {
            assertEquals(StandardGateStampValidator.Result.VALID, validate(stamp(), distTag = distTag).result, distTag)
        }
    }

    @Test
    fun `dev-checked stamp is valid on dev only`() {
        val content = stamp(dataloaderEnv = "dev")
        assertEquals(StandardGateStampValidator.Result.VALID, validate(content, distTag = "dev").result)
        for (distTag in listOf("qa", "uat", "latest")) {
            val outcome = validate(content, distTag = distTag)
            assertEquals(StandardGateStampValidator.Result.INVALID, outcome.result, distTag)
            assertEquals("dataloader-env-dev-not-accepted-on-$distTag", outcome.reason)
        }
    }

    @Test
    fun `qa-checked stamp is valid on dev and qa, not uat or main`() {
        val content = stamp(dataloaderEnv = "qa")
        for (distTag in listOf("dev", "qa")) {
            assertEquals(StandardGateStampValidator.Result.VALID, validate(content, distTag = distTag).result, distTag)
        }
        for (distTag in listOf("uat", "latest")) {
            assertEquals(StandardGateStampValidator.Result.INVALID, validate(content, distTag = distTag).result, distTag)
        }
    }

    @Test
    fun `without a distTag the strictest rule applies`() {
        val outcome = StandardGateStampValidator.validate(stamp(dataloaderEnv = "dev"), sourceHash, testHash, listOf())
        assertEquals(StandardGateStampValidator.Result.INVALID, outcome.result)
    }

    // ── Dataloader load (dataloaderExec) ───────────────────────────────

    /** Every required task passed, plus the load recorded with [loadStatus], the shape writeGateStamp writes for a package with a dataloader step. */
    private fun withLoad(loadStatus: String): List<Pair<String, String>> =
        StandardGateStampValidator.REQUIRED_TASKS.map { it to "passed" } + ("dataloaderExec" to loadStatus)

    @Test
    fun `stamp without a dataloaderExec entry is not checked for it (old stamps, packages without a load)`() {
        // Every stamp written before the entry existed has testDataloader "passed" and nothing else.
        for (distTag in listOf("dev", "qa", "uat", "latest")) {
            assertEquals(StandardGateStampValidator.Result.VALID, validate(stamp(), distTag = distTag).result, distTag)
        }
    }

    @Test
    fun `recorded load that passed → VALID`() {
        assertEquals(StandardGateStampValidator.Result.VALID, validate(stamp(tasks = withLoad("passed"))).result)
    }

    @Test
    fun `recorded load that was skipped → INVALID, although testDataloader says passed`() {
        for (distTag in listOf("dev", "qa", "uat", "latest")) {
            val outcome = validate(stamp(tasks = withLoad("skipped")), distTag = distTag)
            assertEquals(StandardGateStampValidator.Result.INVALID, outcome.result, distTag)
            assertEquals("dataloader-load-skipped", outcome.reason)
        }
    }

    @Test
    fun `recorded load with any status but passed → INVALID`() {
        // "skipped", "up-to-date" and "not-found" pass for every other task.
        for (status in listOf("unknown", "not-found", "up-to-date", "failed")) {
            val outcome = validate(stamp(tasks = withLoad(status)))
            assertEquals(StandardGateStampValidator.Result.INVALID, outcome.result, status)
            assertEquals("dataloader-load-$status", outcome.reason)
        }
    }

    @Test
    fun `skipped load trumps test hash drift → INVALID, not TESTS_CHANGED`() {
        val outcome = validate(stamp(tasks = withLoad("skipped"), tstHash = "OLD"), currTest = "NEW")
        assertEquals(StandardGateStampValidator.Result.INVALID, outcome.result)
        assertEquals("dataloader-load-skipped", outcome.reason)
    }

    @Test
    fun `dataloader env is still checked when the load passed`() {
        val outcome = validate(stamp(tasks = withLoad("passed"), dataloaderEnv = "dev"), distTag = "latest")
        assertEquals(StandardGateStampValidator.Result.INVALID, outcome.result)
        assertEquals("dataloader-env-dev-not-accepted-on-latest", outcome.reason)
    }

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
