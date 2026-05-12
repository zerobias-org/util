package com.zerobias.buildtools.monorepo

import com.fasterxml.jackson.annotation.JsonIgnoreProperties
import com.fasterxml.jackson.annotation.JsonInclude
import com.fasterxml.jackson.annotation.JsonPropertyOrder
import com.fasterxml.jackson.core.util.DefaultIndenter
import com.fasterxml.jackson.core.util.DefaultPrettyPrinter
import com.fasterxml.jackson.core.util.Separators
import com.fasterxml.jackson.databind.ObjectMapper
import com.fasterxml.jackson.databind.SerializationFeature
import com.fasterxml.jackson.module.kotlin.readValue
import com.fasterxml.jackson.module.kotlin.registerKotlinModule
import com.zerobias.buildtools.util.SourceHasher
import java.io.File

/**
 * Multi-package gate stamp for monorepo builds.
 *
 * Lives at the repo root as `gate-stamp.json`. Aggregates per-package
 * source/test hashes, task results, and resolved root deps. Used by:
 *
 * 1. CI pre-flight (`zbb gate --check` → `monorepoGateCheck` task) to skip
 *    full gate when nothing changed since the committed stamp.
 * 2. `monorepoPublish` to refuse publishing if any package's stamp is invalid.
 *
 * Format must match what `lib/monorepo/GateStamp.ts` writes byte-for-byte
 * during the migration parity validation phase.
 */

// ── Data classes ─────────────────────────────────────────────────────

/**
 * Validation result for a single package's stamp entry.
 *
 * Order matters for severity comparisons in callers — most-broken first.
 */
enum class GateStampResult {
    /** No stamp file exists, or no entry for this package. */
    MISSING,

    /** sourceHash mismatch, rootDeps drift, or a non-test build task failed. */
    INVALID,

    /** Source ok, but a test task failed last run, or a test suite has failures. */
    TESTS_FAILED,

    /** Source ok, but testHash changed (test files modified). */
    TESTS_CHANGED,

    /** Everything matches. Skip safe. */
    VALID,
}

@JsonInclude(JsonInclude.Include.NON_NULL)
@JsonPropertyOrder("expected", "ran", "status")
data class TestSuiteEntry(
    val expected: Int,
    val ran: Int,
    val status: String, // "passed" | "failed" | "skipped" | "not-run"
)

@JsonInclude(JsonInclude.Include.NON_NULL)
@JsonPropertyOrder("version", "sourceHash", "testHash", "tasks", "tests", "rootDeps")
data class PackageStampEntry(
    val version: String,
    val sourceHash: String,
    val testHash: String,
    /** Map of task name → status: "passed" | "failed" | "skipped" | "not-found" */
    val tasks: Map<String, String>,
    /** Map of test suite name → entry. Suites: unit, integration, e2e. */
    val tests: Map<String, TestSuiteEntry>,
    /**
     * Snapshot of root package.json deps + overrides this package depends on,
     * resolved at stamp write time. Validated against current root at read time
     * to detect drift. Optional — older stamps may not include it.
     *
     * Override values are stored as JSON.stringify'd strings to preserve type
     * (e.g. an object override gets stored as a JSON string for comparison).
     * Field order: written AFTER `tests` to match the TS path's stamp output.
     */
    val rootDeps: Map<String, String>? = null,
)

// ignoreUnknown=true so older stamps that still have a "timestamp" field
// continue to parse during the rollout.
@JsonIgnoreProperties(ignoreUnknown = true)
@JsonPropertyOrder("version", "branch", "packages")
data class GateStamp(
    val version: Int = 1,
    val branch: String,
    val packages: Map<String, PackageStampEntry>,
)

// ── JSON IO ──────────────────────────────────────────────────────────

/**
 * Read/write multi-package gate stamps with byte-equality to the TS path's
 * `JSON.stringify(stamp, null, 2) + '\n'` output format.
 *
 * Critical formatting rules (matching JS `JSON.stringify(_, null, 2)`):
 * - 2-space indent
 * - Newline before each value/element
 * - `": "` (colon space) between key and value
 * - Trailing newline at end of file
 * - LinkedHashMap insertion order preserved (sorted by package name at write time)
 */
object GateStampIO {

    private val mapper: ObjectMapper = ObjectMapper().registerKotlinModule().apply {
        // Configure pretty printer to match JS JSON.stringify(_, null, 2):
        //   - 2-space indent (no tabs)
        //   - Newline after open brace and before each element
        //   - "key": value (no space BEFORE colon, space AFTER)
        //   - Default Jackson is "key" : value (space before AND after) — must override
        val indenter = DefaultIndenter("  ", "\n")
        val separators = Separators.createDefaultInstance()
            .withObjectFieldValueSpacing(Separators.Spacing.AFTER) // ": " not " : "
        val printer = DefaultPrettyPrinter()
            .withSeparators(separators)
            // Without this, the root-object opener uses the default which adds a space.
            .also { it.indentObjectsWith(indenter) }
            .also { it.indentArraysWith(indenter) }
        setDefaultPrettyPrinter(printer)
        enable(SerializationFeature.INDENT_OUTPUT)
    }

    /**
     * Read a stamp from disk. Returns null if missing or unparseable.
     */
    fun read(file: File): GateStamp? {
        if (!file.exists()) return null
        return try {
            mapper.readValue<GateStamp>(file)
        } catch (_: Exception) {
            null
        }
    }

    /**
     * Write a stamp to disk. Always ends with a trailing newline to match
     * the TS path's `JSON.stringify(_, null, 2) + '\n'` output.
     */
    fun write(file: File, stamp: GateStamp) {
        file.parentFile?.mkdirs()
        val json = mapper.writeValueAsString(stamp)
        file.writeText(json + "\n")
    }
}

// ── Validation ───────────────────────────────────────────────────────

/**
 * Outcome of validating one package's stamp entry, plus a human-readable
 * `reason` identifying WHICH check failed. `reason` is null when `result` is
 * VALID. Get it from [StampValidator.validateDetailed]; [StampValidator.validate]
 * returns just the enum for callers that don't surface a reason.
 */
data class StampValidation(val result: GateStampResult, val reason: String? = null)

/**
 * Validates a single package's stamp entry against the current source state.
 *
 * Mirrors `validatePackageStamp` from `lib/monorepo/GateStamp.ts`.
 */
class StampValidator(
    private val sourceFiles: List<String>,
    private val sourceDirs: List<String>,
    private val testPhases: Set<String> = setOf("test"),
) {
    private val overrideJson = ObjectMapper().registerKotlinModule()

    /**
     * @param packageDir absolute path to the package being validated
     * @param packageName the npm package name (used for the rootDeps lookup)
     * @param stamp the loaded stamp file (null if missing)
     * @param rootPackageJson parsed root package.json (used for rootDeps drift check),
     *                       or null to skip rootDeps validation
     */
    fun validate(
        packageDir: File,
        packageName: String,
        stamp: GateStamp?,
        rootPackageJson: Map<String, Any?>? = null,
    ): GateStampResult = validateDetailed(packageDir, packageName, stamp, rootPackageJson).result

    /**
     * Like [validate], but also returns a reason identifying the exact check
     * that failed (mismatched hash with both truncated values, the drifted
     * root dep + values, the failing task name, …). A bare `INVALID` is
     * undiagnosable — anything user-facing should print this reason.
     */
    fun validateDetailed(
        packageDir: File,
        packageName: String,
        stamp: GateStamp?,
        rootPackageJson: Map<String, Any?>? = null,
    ): StampValidation {
        if (stamp == null) return StampValidation(GateStampResult.MISSING, "no gate-stamp.json on disk")
        val entry = stamp.packages[packageName]
            ?: return StampValidation(GateStampResult.MISSING, "no stamp entry for $packageName (run a full `zbb gate`)")

        // 1. Source hash check
        val currentSourceHash = SourceHasher.hashSources(packageDir, sourceFiles, sourceDirs)
        if (entry.sourceHash != currentSourceHash) {
            return StampValidation(
                GateStampResult.INVALID,
                "sourceHash mismatch: stamp=${shortHash(entry.sourceHash)} current=${shortHash(currentSourceHash)} " +
                "— a tracked source file ($sourceFiles + $sourceDirs/) changed since the stamp was written, " +
                "or build-tools' hashing differs between where the stamp was written and here " +
                "(check both are on the same build-tools version)",
            )
        }

        // 1b. Root deps drift check (only if rootDeps is present in stamp and root pkg available)
        if (entry.rootDeps != null && rootPackageJson != null) {
            val currentRootDeps = extractRootDeps(rootPackageJson)
            val currentOverrides = extractRootOverrides(rootPackageJson)
            for ((depName, stampVersion) in entry.rootDeps) {
                val currentDep = currentRootDeps[depName]
                val currentOverride = currentOverrides[depName]?.let { jsonStringify(it) }
                if (currentDep != stampVersion && currentOverride != stampVersion) {
                    val now = currentOverride ?: currentDep ?: "<absent>"
                    return StampValidation(
                        GateStampResult.INVALID,
                        "root package.json dep drift: '$depName' stamp=$stampVersion now=$now",
                    )
                }
            }
        }

        // 2. Build task failures (test tasks separated)
        var failedTestTask: String? = null
        for ((taskName, status) in entry.tasks) {
            if (status != "passed" && status != "skipped" && status != "not-found") {
                if (testPhases.contains(taskName)) {
                    if (failedTestTask == null) failedTestTask = taskName
                } else {
                    return StampValidation(
                        GateStampResult.INVALID,
                        "build task '$taskName' recorded as '$status' in the stamp",
                    )
                }
            }
        }

        // 3. Test hash check
        val currentTestHash = SourceHasher.hashTests(packageDir)
        if (entry.testHash != currentTestHash) {
            return StampValidation(
                GateStampResult.TESTS_CHANGED,
                "testHash mismatch: stamp=${shortHash(entry.testHash)} current=${shortHash(currentTestHash)} — test files changed since the stamp",
            )
        }

        // 4. Test task or test suite failures
        if (failedTestTask != null) {
            return StampValidation(GateStampResult.TESTS_FAILED, "test task '$failedTestTask' recorded as failed in the stamp")
        }
        for ((suite, s) in entry.tests) {
            if (s.expected > 0 && s.status != "passed" && s.status != "skipped") {
                return StampValidation(GateStampResult.TESTS_FAILED, "test suite '$suite' status='${s.status}' in the stamp")
            }
        }

        return StampValidation(GateStampResult.VALID)
    }

    private fun shortHash(h: String): String = if (h.length > 12) h.take(12) + "…" else h

    @Suppress("UNCHECKED_CAST")
    private fun extractRootDeps(rootPkg: Map<String, Any?>): Map<String, String> {
        val deps = mutableMapOf<String, String>()
        (rootPkg["dependencies"] as? Map<String, Any?>)?.forEach { (k, v) ->
            if (v is String) deps[k] = v
        }
        (rootPkg["devDependencies"] as? Map<String, Any?>)?.forEach { (k, v) ->
            if (v is String) deps[k] = v
        }
        return deps
    }

    @Suppress("UNCHECKED_CAST")
    private fun extractRootOverrides(rootPkg: Map<String, Any?>): Map<String, Any?> {
        return (rootPkg["overrides"] as? Map<String, Any?>) ?: emptyMap()
    }

    /**
     * Match JS `JSON.stringify(value)` for any value.
     *
     * The TS path stores override values as `JSON.stringify(rootOverrides[name])`
     * — so a string "^3.0.6" becomes the literal string `"^3.0.6"` (with quotes),
     * an object becomes `{"key":"val"}`, etc. This must match exactly for the
     * rootDeps drift check to compare correctly against the stored value.
     */
    private fun jsonStringify(value: Any?): String {
        return overrideJson.writeValueAsString(value)
    }
}
