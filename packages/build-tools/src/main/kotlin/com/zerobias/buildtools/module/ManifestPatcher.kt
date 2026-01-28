package com.zerobias.buildtools.module

import org.gradle.api.GradleException
import java.io.File

/**
 * Patches generated manifest.json files.
 *
 * Replaces the java-http generate:manifest npm script:
 *   node -e "const fs=require('fs');
 *     const m=JSON.parse(fs.readFileSync('generated/api/manifest.json'));
 *     m.implementationType='java-http';
 *     fs.writeFileSync('generated/api/manifest.json', JSON.stringify(m, null, 2));"
 */
object ManifestPatcher {

    /**
     * Add or update a field in a JSON file.
     * Uses simple string manipulation to avoid heavy JSON library dependency.
     * The manifest.json is a small, flat JSON object.
     */
    fun patchField(manifestFile: File, field: String, value: String) {
        if (!manifestFile.exists()) {
            throw GradleException("Manifest file not found: ${manifestFile.absolutePath}")
        }

        val content = manifestFile.readText()
        val fieldPattern = Regex(""""$field"\s*:\s*"[^"]*"""")

        val patched = if (fieldPattern.containsMatchIn(content)) {
            // Update existing field
            fieldPattern.replace(content) { """"$field": "$value"""" }
        } else {
            // Add field before closing brace
            content.replaceLast("}", """  "$field": "$value"\n}""")
        }

        manifestFile.writeText(patched)
    }

    private fun String.replaceLast(old: String, new: String): String {
        val index = lastIndexOf(old)
        if (index < 0) return this
        // Ensure trailing comma on previous line
        val beforeBrace = substring(0, index).trimEnd()
        val needsComma = beforeBrace.isNotEmpty() &&
            !beforeBrace.endsWith(",") &&
            !beforeBrace.endsWith("{")
        val comma = if (needsComma) "," else ""
        return beforeBrace + comma + "\n" + new + substring(index + old.length)
    }
}
