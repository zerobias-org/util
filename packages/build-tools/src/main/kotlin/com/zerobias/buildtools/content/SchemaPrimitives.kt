package com.zerobias.buildtools.content

import com.fasterxml.jackson.databind.ObjectMapper
import com.fasterxml.jackson.module.kotlin.readValue
import org.yaml.snakeyaml.Yaml
import java.io.File
import java.time.Instant

/**
 * Reusable schema-check primitives for content-package validators.
 *
 * Each consumer repo composes its own validator from these primitives plus
 * any repo-specific rules, then plugs it into `zb.content`'s slot:
 *
 *     // <repo>/build.gradle.kts (root)
 *     import com.zerobias.buildtools.content.SchemaPrimitives
 *
 *     extra["contentValidator"] = { proj: org.gradle.api.Project ->
 *         val indexYml = proj.file("index.yml")
 *         require(indexYml.isFile) { "[<repo>] index.yml missing" }
 *         val doc = SchemaPrimitives.parseYaml(indexYml)
 *         SchemaPrimitives.requireUuid(doc["id"], "id")
 *         SchemaPrimitives.requireNonBlankString(doc["name"], "name")
 *         SchemaPrimitives.requireEnum(
 *             doc["status"], "status",
 *             setOf("active", "verified", "deprecated"),
 *         )
 *         // ... repo-specific rules (npm name formula, payload dirs, etc) ...
 *     }
 *
 * Util provides building blocks; each repo owns its own validation rules.
 * No per-artifact-type code lives in util — adding suite/product/framework/
 * standard/crosswalk/benchmark to the gradle pipeline doesn't change util.
 *
 * The dataloader (run by `dataloaderExec` against an ephemeral
 * Neon branch) is the universal "is this loadable?" check. Validators
 * built from these primitives are pre-flight schema checks — fast, fail
 * early on obvious problems before the artifact ever reaches the
 * dataloader.
 */
object SchemaPrimitives {

    private val UUID_REGEX = Regex(
        "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$",
        RegexOption.IGNORE_CASE,
    )

    // ── Parsing ──────────────────────────────────────────────────────

    /** Read a YAML file as a string-keyed map. */
    @JvmStatic
    fun parseYaml(file: File): Map<String, Any?> {
        require(file.isFile) { "YAML file not found: ${file.path}" }
        @Suppress("UNCHECKED_CAST")
        return (Yaml().load(file.readText()) as? Map<String, Any?>)
            ?: throw IllegalArgumentException("Unable to parse ${file.name} as a YAML map")
    }

    /** Read a JSON file as a string-keyed map. */
    @JvmStatic
    fun parseJson(file: File): Map<String, Any?> {
        require(file.isFile) { "JSON file not found: ${file.path}" }
        return ObjectMapper().readValue(file.readText())
    }

    /**
     * Walk a JSON/YAML-shaped map by dotted path and return the leaf
     * value (or null if any segment is missing).
     *
     *   getPath(json, "zerobias.import-artifact") → "vendor"
     */
    @JvmStatic
    fun getPath(doc: Map<String, Any?>, path: String): Any? {
        var node: Any? = doc
        for (segment in path.split(".")) {
            val map = node as? Map<*, *> ?: return null
            node = map[segment]
        }
        return node
    }

    // ── Field checks ─────────────────────────────────────────────────

    /**
     * Throw if [value] is not a non-blank, non-template-placeholder string.
     * Catches the common "{name}" / "{id}" placeholder leftovers from
     * vendor templates.
     */
    @JvmStatic
    fun requireNonBlankString(value: Any?, field: String) {
        require(value is String) {
            "$field must be a string (got ${value?.javaClass?.simpleName ?: "null"})"
        }
        require(value.isNotBlank()) { "$field must not be blank" }
        require(!(value.startsWith("{") && value.endsWith("}"))) {
            "$field still has a template placeholder: $value"
        }
    }

    /** Throw if [value] is not a UUID v4 string (case-insensitive). */
    @JvmStatic
    fun requireUuid(value: Any?, field: String) {
        requireNonBlankString(value, field)
        val str = value as String
        require(UUID_REGEX.matches(str)) { "$field is not a valid UUID: $str" }
    }

    /** Throw if [value] is not a member of [allowed]. */
    @JvmStatic
    fun requireEnum(value: Any?, field: String, allowed: Set<String>) {
        requireNonBlankString(value, field)
        require((value as String) in allowed) {
            "$field must be one of [${allowed.joinToString(", ")}] (got '$value')"
        }
    }

    /** Throw if [value] is not a list of strings. Empty list is allowed
     *  unless [requireNonEmpty]. */
    @JvmStatic
    fun requireStringList(value: Any?, field: String, requireNonEmpty: Boolean = false) {
        require(value is List<*>) {
            "$field must be a list (got ${value?.javaClass?.simpleName ?: "null"})"
        }
        if (requireNonEmpty) {
            require(value.isNotEmpty()) { "$field must not be empty" }
        }
        for ((i, item) in value.withIndex()) {
            require(item is String) { "$field[$i] must be a string" }
        }
    }

    /** Throw if [value] is not a parseable ISO-8601 instant string. */
    @JvmStatic
    fun requireIso8601(value: Any?, field: String) {
        requireNonBlankString(value, field)
        try {
            Instant.parse(value as String)
        } catch (e: Exception) {
            throw IllegalArgumentException(
                "$field is not a valid ISO-8601 timestamp: $value (${e.message})"
            )
        }
    }

    /**
     * Throw if [code] doesn't match [dirName]. Captures the universal
     * "filesystem identity matches metadata" invariant — every content
     * type we've surveyed has this property (the leaf directory name
     * equals the `code` field in metadata).
     */
    @JvmStatic
    fun requireCodeMatchesDir(code: String, dirName: String, field: String = "code") {
        require(code == dirName) {
            "$field='$code' must match leaf directory name '$dirName'"
        }
    }

    /**
     * Triangulate package.json against the directory layout: the npm
     * `name` field and the `zerobias.package` (or legacy
     * `auditmation.package`) field must each equal the values derived
     * from the directory path.
     *
     * The dataloader reads `zerobias.package` but never the npm `name`
     * field — a mismatched npm name publishes under the wrong package
     * and only surfaces in production. The dataloader also has no view
     * of the on-disk directory layout. Each content repo computes the
     * expected values from its own naming formula:
     *
     *   vendor : dir = {code}        → name = vendor-{code},     pkg = {code}
     *   suite  : dir = {v}/{s}       → name = suite-{v}-{s},     pkg = {v}.{s}
     *   tag    : dir = {scope}/{n}   → name = tag-{scope}-{n},   pkg = {scope}.{n}.tag
     *
     * — and calls this primitive with the formula's output.
     */
    @JvmStatic
    fun requirePackageIdentity(
        pkgDoc: Map<String, Any?>,
        expectedNpmName: String,
        expectedZerobiasPackage: String,
        field: String = "package.json",
    ) {
        require(pkgDoc["name"] == expectedNpmName) {
            "$field name='${pkgDoc["name"]}' must equal '$expectedNpmName' (derived from directory path)"
        }
        val zbPackage = getPath(pkgDoc, "zerobias.package")
            ?: getPath(pkgDoc, "auditmation.package")
        require(zbPackage == expectedZerobiasPackage) {
            "$field zerobias.package='$zbPackage' must equal '$expectedZerobiasPackage' (derived from directory path)"
        }
    }
}
