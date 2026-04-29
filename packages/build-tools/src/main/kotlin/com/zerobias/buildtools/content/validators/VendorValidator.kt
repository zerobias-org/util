package com.zerobias.buildtools.content.validators

import com.fasterxml.jackson.databind.ObjectMapper
import com.fasterxml.jackson.module.kotlin.readValue
import org.gradle.api.Project
import org.yaml.snakeyaml.Yaml
import java.io.File

/**
 * Vendor-shaped content validator — opt in from the consumer repo:
 *
 *     extra["contentValidator"] = VendorValidator::validate
 *
 * Applies to repos that ship single-package metadata under
 * `package/<code>/index.yml` plus a logo: vendor, suite, product,
 * framework, standard, crosswalk, benchmark, etc.
 *
 * Checks:
 *   - Required files: index.yml, package.json, .npmrc
 *   - index.yml schema: id (UUID), code, name, description, url,
 *                       status (enum), aliases[]
 *   - package.json: name == @zerobias-org/{import-artifact}-{code-w-dashes},
 *                   description not the {name} placeholder,
 *                   zerobias metadata block has import-artifact / package /
 *                   dataloader-version (also accepts legacy auditmation key)
 */
object VendorValidator {

    private val VALID_STATUSES = setOf("active", "verified", "inactive", "deprecated")
    private val UUID_REGEX = Regex(
        "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$",
        RegexOption.IGNORE_CASE
    )

    /** Public entry point invoked through the `extra["contentValidator"]`
     *  slot in `zb.content`. Logs progress on the project's logger. */
    @JvmStatic
    fun validate(project: Project) {
        val code = validateProjectDir(project.projectDir)
        project.logger.lifecycle("[VendorValidator] ${project.path}: code=$code")
    }

    /** Project-less entry point. Used by the deprecated `ContentValidator`
     *  shim and by any tooling that wants to validate without a gradle
     *  Project handle. Returns the index.yml `code` for callers that
     *  need it. */
    @JvmStatic
    fun validateProjectDir(projectDir: File): String {
        val indexYml = projectDir.resolve("index.yml")
        require(indexYml.isFile) { "[VendorValidator] index.yml not found in ${projectDir.path}" }

        val packageJson = projectDir.resolve("package.json")
        require(packageJson.isFile) { "[VendorValidator] package.json not found in ${projectDir.path}" }

        val npmrc = projectDir.resolve(".npmrc")
        require(npmrc.isFile) { "[VendorValidator] .npmrc not found in ${projectDir.path}" }

        val indexDoc = parseYaml(indexYml)
        val code = validateIndex(indexDoc)

        val pkgDoc = parseJson(packageJson)
        validatePackageJson(pkgDoc, code)

        return code
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
