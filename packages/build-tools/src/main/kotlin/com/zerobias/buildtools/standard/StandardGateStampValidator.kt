package com.zerobias.buildtools.standard

/**
 * Pure decision logic for the standard-mode (zb.base) gate-stamp validator.
 *
 * Extracted from `zb.base.gradle.kts` so it can be unit-tested without a
 * Gradle build context. The script plugin's `checkGateStamp()` collects
 * the inputs (current hashes + test counts + on-disk stamp content) and
 * delegates the actual decision to [StandardGateStampValidator.validate].
 *
 * Three-state result:
 *   - VALID:         sourceHash + testHash match, all recorded task results
 *                    were successful → skip everything
 *   - TESTS_CHANGED: sourceHash matches but testHash differs → rerun tests
 *                    only, keep build/validation skipped
 *   - INVALID:       stamp missing, sourceHash mismatch, recorded task
 *                    failed/not-run, or test status missing → rerun all
 */
object StandardGateStampValidator {

    enum class Result { VALID, TESTS_CHANGED, INVALID }

    /**
     * Diagnostic returned alongside the result so callers can log a useful
     * message without re-deriving the reason from result + inputs.
     */
    data class Outcome(val result: Result, val reason: String)

    /** Per-suite expected test count from the on-disk source. */
    data class SuiteCount(val name: String, val currentExpected: Int)

    /**
     * Tasks whose recorded result must be one of the [PASSING_STATUSES].
     * "not-found" is tolerated because the active task set is plugin-
     * specific and an older stamp may not include all current entries.
     */
    val REQUIRED_TASKS = listOf(
        "validate", "lint", "compile",
        "test", "testDirect", "testDocker", "testDataloader",
        "buildArtifacts",
    )

    /** Recorded task results that count as "ok to skip". */
    val PASSING_STATUSES = setOf("passed", "skipped", "up-to-date", "not-found")

    /** Recorded test-suite statuses that count as "ok to skip". */
    val PASSING_TEST_STATUSES = setOf("passed", "skipped")

    /**
     * Decide whether the gate stamp permits skipping work.
     *
     * @param stampContent      Raw JSON content of `gate-stamp.json`, or
     *                          `null` if the file does not exist.
     * @param currentSourceHash SourceHasher.hashSources(...) for the working tree.
     * @param currentTestHash   SourceHasher.hashTests(...) for the working tree.
     * @param currentTestCounts Per-suite expected counts derived from the
     *                          working tree's test/ subdirectories. Suites
     *                          with `currentExpected == 0` are ignored
     *                          (they don't exist in the working tree).
     */
    fun validate(
        stampContent: String?,
        currentSourceHash: String,
        currentTestHash: String,
        currentTestCounts: List<SuiteCount>,
    ): Outcome {
        if (stampContent == null) {
            return Outcome(Result.INVALID, "stamp-missing")
        }

        val content = stampContent

        // 1. sourceHash must match — otherwise the source code drifted
        //    from what was stamped and the gate must run end-to-end.
        val stampSourceHash = Regex(""""sourceHash"\s*:\s*"([^"]+)"""")
            .find(content)?.groupValues?.get(1)
            ?: return Outcome(Result.INVALID, "stamp-malformed-no-source-hash")
        if (stampSourceHash != currentSourceHash) {
            return Outcome(Result.INVALID, "source-hash-changed")
        }

        // 2. Every recorded task result must be a passing status. "not-
        //    found" tolerated for forward-compat with older stamps.
        for (taskName in REQUIRED_TASKS) {
            val taskStatus = Regex(""""$taskName"\s*:\s*"([^"]+)"""")
                .find(content)?.groupValues?.get(1)
                ?: continue
            if (taskStatus !in PASSING_STATUSES) {
                return Outcome(Result.INVALID, "task-$taskName-status-$taskStatus")
            }
        }

        // 3. testHash mismatch → tests changed but source didn't, rerun
        //    tests only. Missing testHash field is treated as empty
        //    string so the comparison fails predictably (TESTS_CHANGED
        //    rather than crash).
        val stampTestHash = Regex(""""testHash"\s*:\s*"([^"]+)"""")
            .find(content)?.groupValues?.get(1)
            ?: ""
        if (stampTestHash != currentTestHash) {
            return Outcome(Result.TESTS_CHANGED, "test-hash-changed")
        }

        // 4. Recorded per-suite test counts/status must match the working
        //    tree. A drift in expected count (e.g. `it()` removed) is
        //    treated as TESTS_CHANGED — rerun the affected suites — even
        //    though strictly the testHash should already have flagged it.
        //    This is a redundant safety net for hash false-negatives.
        for (suite in currentTestCounts) {
            if (suite.currentExpected == 0) continue

            val stampExpected = Regex(""""${suite.name}"\s*:\s*\{[^}]*"expected"\s*:\s*(\d+)""")
                .find(content)?.groupValues?.get(1)?.toIntOrNull()
            val stampStatus = Regex(""""${suite.name}"\s*:\s*\{[^}]*"status"\s*:\s*"([^"]+)"""")
                .find(content)?.groupValues?.get(1)

            if (stampExpected == null || stampStatus == null) {
                return Outcome(Result.INVALID, "test-${suite.name}-missing-from-stamp")
            }
            if (stampStatus !in PASSING_TEST_STATUSES) {
                return Outcome(Result.INVALID, "test-${suite.name}-status-$stampStatus")
            }
            if (suite.currentExpected != stampExpected) {
                return Outcome(Result.TESTS_CHANGED, "test-${suite.name}-count-${stampExpected}-to-${suite.currentExpected}")
            }
        }

        return Outcome(Result.VALID, "stamp-valid")
    }
}
