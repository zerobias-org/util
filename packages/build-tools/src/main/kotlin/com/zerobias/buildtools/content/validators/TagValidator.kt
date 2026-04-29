package com.zerobias.buildtools.content.validators

import com.fasterxml.jackson.databind.ObjectMapper
import com.fasterxml.jackson.module.kotlin.readValue
import org.gradle.api.Project
import java.io.File

/**
 * Tag-shaped content validator — opt in from the consumer repo:
 *
 *     extra["contentValidator"] = TagValidator::validate
 *
 * Tag packages don't have an `index.yml`. Their payload is directories
 * keyed by tag-type subdirectories (env-type/, product-segment/,
 * service-segment/, query-folder/, other/, marketplace/, etc.) each
 * containing one or more YAML files that the dataloader's
 * TagArtifactLoader processes.
 *
 * Checks:
 *   - Required files: package.json
 *   - package.json:
 *       zerobias.import-artifact == "tag"
 *       zerobias.dataloader-version is non-empty
 *   - At least one of the known tag-type subdirectories is present
 *     (env-type, product-segment, service-segment, query-folder, other,
 *      marketplace).  Catches the "empty migration" case where a package
 *     has no tag definitions at all.
 *
 * Used by zerobias-com/tag.
 */
object TagValidator {

    /** Tag-type subdirectories the platform dataloader recognizes. At
     *  least one must be present in the package; absence likely means
     *  the package was created from a template and the payload was
     *  never filled in. */
    private val KNOWN_PAYLOAD_DIRS = listOf(
        "env-type",
        "product-segment",
        "service-segment",
        "query-folder",
        "other",
        "marketplace",
    )

    @JvmStatic
    fun validate(project: Project) {
        val projectDir = project.projectDir

        val packageJson = projectDir.resolve("package.json")
        require(packageJson.isFile) { "[TagValidator] package.json not found in ${projectDir.path}" }

        val pkgDoc = parseJson(packageJson)
        val meta = (pkgDoc["zerobias"] as? Map<*, *>)
            ?: (pkgDoc["auditmation"] as? Map<*, *>)
            ?: throw IllegalArgumentException("[TagValidator] package.json missing zerobias metadata section in ${projectDir.path}")

        val artifact = meta["import-artifact"] as? String
        require(artifact == "tag") {
            "[TagValidator] expected zerobias.import-artifact='tag', got '$artifact' in ${projectDir.path}"
        }

        val dataloaderVersion = meta["dataloader-version"] as? String
        require(!dataloaderVersion.isNullOrBlank()) {
            "[TagValidator] zerobias.dataloader-version not set in ${projectDir.path}"
        }

        val present = KNOWN_PAYLOAD_DIRS.filter { projectDir.resolve(it).isDirectory }
        require(present.isNotEmpty()) {
            "[TagValidator] tag package ${project.path} must contain at least one of $KNOWN_PAYLOAD_DIRS"
        }

        project.logger.lifecycle("[TagValidator] ${project.path}: payload=${present.joinToString()}")
    }

    private fun parseJson(file: File): Map<String, Any?> {
        return ObjectMapper().readValue(file.readText())
    }
}
