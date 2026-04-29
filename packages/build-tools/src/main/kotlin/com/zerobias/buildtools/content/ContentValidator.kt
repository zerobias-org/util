package com.zerobias.buildtools.content

import com.fasterxml.jackson.databind.ObjectMapper
import com.fasterxml.jackson.module.kotlin.readValue
import org.yaml.snakeyaml.Yaml
import java.io.File

/**
 * Schema validator for content-catalog packages (vendor, suite, product).
 *
 * Ports the behavior of org/vendor/scripts/validate.ts into Kotlin so the
 * gradle `validate` task doesn't need a tsx/Node subprocess. Checks:
 *   - Required files: index.yml, package.json, .npmrc
 *   - index.yml schema: id (UUID), code, name, description, url, status (enum), aliases[]
 *   - package.json: name matches @zerobias-org/{artifact}-{derived-from-code},
 *                   description is set (not the {name} placeholder),
 *                   zerobias metadata block has import-artifact / package / dataloader-version
 *                   (falls back to auditmation key for transitional packages)
 */
object ContentValidator {

    private val VALID_STATUSES = setOf("active", "verified", "inactive", "deprecated")
    private val UUID_REGEX = Regex(
        "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$",
        RegexOption.IGNORE_CASE
    )

    data class Result(val code: String)

    fun validate(projectDir: File): Result {
        val indexYml = projectDir.resolve("index.yml")
        require(indexYml.isFile) { "index.yml not found in ${projectDir.path}" }

        val packageJson = projectDir.resolve("package.json")
        require(packageJson.isFile) { "package.json not found in ${projectDir.path}" }

        val npmrc = projectDir.resolve(".npmrc")
        require(npmrc.isFile) { ".npmrc not found in ${projectDir.path}" }

        val indexDoc = parseYaml(indexYml)
        val code = validateIndex(indexDoc)

        val pkgDoc = parseJson(packageJson)
        validatePackageJson(pkgDoc, code)

        return Result(code)
    }

    private fun parseYaml(file: File): Map<String, Any?> {
        @Suppress("UNCHECKED_CAST")
        return (Yaml().load(file.readText()) as? Map<String, Any?>)
            ?: throw IllegalArgumentException("Unable to parse ${file.name}")
    }

    private fun parseJson(file: File): Map<String, Any?> {
        return ObjectMapper().readValue(file.readText())
    }

    private fun validateIndex(doc: Map<String, Any?>): String {
        val code = requireStringField(doc, "code", "{code}")

        val id = requireStringField(doc, "id", "{id}")
        require(UUID_REGEX.matches(id)) { "id in index.yml is not a valid UUID: $id" }

        requireStringField(doc, "name", "{name}")
        requireStringField(doc, "description", "{description}")
        requireStringField(doc, "url", "{url}")

        val imageUrl = doc["imageUrl"]
        if (imageUrl != null) {
            require(imageUrl is String && imageUrl.isNotBlank()) {
                "imageUrl in index.yml must be a non-empty string when present"
            }
        }

        val status = doc["status"]
            ?: throw IllegalArgumentException("status not found in index.yml")
        require(status is String) { "status in index.yml must be a string" }
        require(VALID_STATUSES.contains(status)) {
            "Invalid status in index.yml: $status. Valid values: ${VALID_STATUSES.joinToString(", ")}"
        }

        val aliases = doc["aliases"]
        if (aliases != null) {
            require(aliases is List<*>) { "aliases in index.yml must be a list" }
            for (alias in aliases) {
                require(alias is String) { "aliases in index.yml must be a string[]" }
            }
        }

        return code
    }

    private fun validatePackageJson(doc: Map<String, Any?>, code: String) {
        val name = doc["name"] as? String
            ?: throw IllegalArgumentException("package.json missing name")

        // Derive artifact type from the zerobias/auditmation metadata block.
        val meta = (doc["zerobias"] as? Map<*, *>)
            ?: (doc["auditmation"] as? Map<*, *>)
            ?: throw IllegalArgumentException("package.json missing zerobias metadata section")

        val artifact = meta["import-artifact"] as? String
            ?: throw IllegalArgumentException("zerobias.import-artifact not set in package.json")
        require(artifact.isNotBlank()) { "zerobias.import-artifact is empty" }

        // npm name = @zerobias-org/{artifact}-{code with dots replaced by dashes}
        val expectedName = "@zerobias-org/${artifact}-${code.replace('.', '-')}"
        require(name == expectedName) {
            "package.json name is '$name' but expected '$expectedName' (derived from import-artifact=$artifact, code=$code)"
        }

        val description = doc["description"] as? String
        require(!description.isNullOrBlank() && description != "{name}") {
            "package.json description missing or still a placeholder"
        }

        val pkg = meta["package"] as? String
            ?: throw IllegalArgumentException("zerobias.package not set in package.json")
        require(pkg == code) {
            "zerobias.package is '$pkg' but expected '$code' (to match index.yml code)"
        }

        val dataloaderVersion = meta["dataloader-version"] as? String
        require(!dataloaderVersion.isNullOrBlank()) {
            "zerobias.dataloader-version not set in package.json"
        }
    }

    private fun requireStringField(doc: Map<String, Any?>, field: String, placeholder: String): String {
        val value = doc[field]
            ?: throw IllegalArgumentException("$field not found in index.yml")
        require(value is String) { "$field in index.yml must be a string" }
        require(value != placeholder) { "$field in index.yml needs replacement from $placeholder" }
        require(value.isNotBlank()) { "$field in index.yml must not be blank" }
        return value
    }
}
