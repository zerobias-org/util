package com.zerobias.buildtools.util

import org.gradle.api.GradleException
import java.io.File

/**
 * Regex-based extraction of values out of `package.json` (and other small
 * JSON payloads) plus the few JSON-adjacent helpers used by build-tools
 * tasks that talk to dataloader-service / dana / verdaccio.
 *
 * Why regex rather than a JSON parser:
 *   - Keeps build-tools' classpath minimal — no jackson / kotlinx-serialization
 *     pulled in just to fish out two top-level fields.
 *   - The existing in-tree consumers (NeonDataloaderTask, PublishOrgTask,
 *     and zb.content.gradle.kts) were each rolling their own regex
 *     extractor with the same patterns. Centralizing here eliminates
 *     three copies and gives those tasks a single seam to harden later
 *     if package.json shapes ever get fancier.
 *
 * NOT a general-purpose JSON library. The helpers assume top-level
 * fields, double-quoted string values, and that the source content
 * is well-formed JSON-shaped text. Callers needing nested-object or
 * array handling should bring their own parser.
 */
object PackageJsonReader {

    /**
     * Extract a top-level (or top-level-of-section) string field value
     * from a JSON-shaped string. Returns null when the field is missing
     * or its value isn't a string.
     */
    fun extractString(json: String, field: String): String? =
        Regex(""""$field"\s*:\s*"([^"]+)"""").find(json)?.groupValues?.get(1)

    /**
     * Extract a top-level boolean field value from a JSON-shaped string.
     * Returns null when the field is missing or its value isn't a literal
     * `true` / `false`.
     */
    fun extractBoolean(json: String, field: String): Boolean? {
        val m = Regex(""""$field"\s*:\s*(true|false)\b""").find(json) ?: return null
        return m.groupValues[1] == "true"
    }

    /**
     * Read `name` and `version` from a `package.json` file. Throws when
     * the file is missing or either required field can't be parsed —
     * these are load-bearing identifiers for every build-tools consumer,
     * so a silent null would just shift the failure to a confusing
     * downstream symptom.
     */
    fun readNameVersion(pkgJson: File): Pair<String, String> {
        require(pkgJson.isFile) { "package.json not found: ${pkgJson.absolutePath}" }
        val content = pkgJson.readText()
        val name = extractString(content, "name")
            ?: throw GradleException("Cannot find 'name' in ${pkgJson.absolutePath}")
        val version = extractString(content, "version")
            ?: throw GradleException("Cannot find 'version' in ${pkgJson.absolutePath}")
        return name to version
    }

    /**
     * Pull `zerobias.orgId` (preferred) or legacy `auditmation.orgId`
     * out of a package.json's raw text. Returns null when neither
     * section declares an orgId — meaning the artifact is catalog-owned
     * (no per-org isolation needed downstream).
     *
     * Matches any whitespace between the section name, the opening
     * brace, and the orgId field. Doesn't attempt to handle nested
     * objects inside the section (no zerobias/auditmation section in
     * the in-tree consumers contains one — keep it simple).
     */
    fun extractZerobiasOrgId(pkgRaw: String): String? {
        val zerobias = Regex(""""zerobias"\s*:\s*\{[^}]*?"orgId"\s*:\s*"([^"]+)"""")
        zerobias.find(pkgRaw)?.let { return it.groupValues[1] }
        val auditmation = Regex(""""auditmation"\s*:\s*\{[^}]*?"orgId"\s*:\s*"([^"]+)"""")
        return auditmation.find(pkgRaw)?.groupValues?.get(1)
    }

    /** File-overload convenience — reads + delegates to the string form. */
    fun extractZerobiasOrgId(pkgJson: File): String? {
        if (!pkgJson.isFile) return null
        return extractZerobiasOrgId(pkgJson.readText())
    }

    /**
     * JSON-escape a string value so it can be safely embedded as a
     * `"key": "<value>"` field in a hand-built JSON payload (e.g. the
     * dataloader-service `/branches` POST body). Only escapes the two
     * characters required by RFC 8259 for double-quoted strings —
     * backslash and double-quote. Callers that need full conformance
     * (control chars, unicode escapes) should use a real serializer.
     */
    fun jsonEscape(s: String): String =
        "\"${s.replace("\\", "\\\\").replace("\"", "\\\"")}\""

    /**
     * Strip all hyphens from a UUID-shaped string and lower-case it.
     * Centralized because the org-private version scheme
     * (`{semver}-rc.{orgIdNoHyphens}.{n}`) and the in-branch seed SQL
     * (`uuid_generate_v5(:'ns', 'Foo.' || '{orgId}')`) both depend on
     * this canonicalization, and historically rolled their own.
     */
    fun stripUuidHyphens(uuid: String): String =
        uuid.replace("-", "").lowercase()
}
