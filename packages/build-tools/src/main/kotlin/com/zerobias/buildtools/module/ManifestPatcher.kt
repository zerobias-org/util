package com.zerobias.buildtools.module

import org.gradle.api.GradleException
import java.io.File

/**
 * Patches generated manifest.json files.
 * Reads JSON, adds/updates a string field, writes back.
 */
object ManifestPatcher {

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
            // Insert field before the final closing brace.
            // Find the last '}' and insert before it with proper comma.
            val lastBrace = content.lastIndexOf('}')
            if (lastBrace < 0) throw GradleException("Invalid JSON in ${manifestFile.name}")

            val before = content.substring(0, lastBrace).trimEnd()
            // Add comma after previous content if needed
            val comma = if (before.endsWith(",") || before.endsWith("{")) "" else ","
            "$before$comma\n  \"$field\": \"$value\"\n}\n"
        }

        manifestFile.writeText(patched)
    }
}
