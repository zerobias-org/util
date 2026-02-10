package com.zerobias.buildtools.module

import org.gradle.api.GradleException
import org.yaml.snakeyaml.DumperOptions
import org.yaml.snakeyaml.LoaderOptions
import org.yaml.snakeyaml.Yaml
import org.yaml.snakeyaml.constructor.Constructor
import org.yaml.snakeyaml.representer.Representer
import java.io.File

/**
 * Syncs metadata from package.json into api.yml's info block.
 * Replaces: yq e -i '.info.version=strenv(VERSION) | .info.title=strenv(NAME) | .info.description=strenv(DESC)' api.yml
 */
object MetadataSyncer {

    /**
     * Read version, name, and description from package.json and write them
     * into api.yml info.version, info.title, and info.description.
     */
    fun sync(projectDir: File) {
        val packageJson = projectDir.resolve("package.json")
        val apiYml = projectDir.resolve("api.yml")

        if (!packageJson.exists()) throw GradleException("package.json not found in $projectDir")
        if (!apiYml.exists()) throw GradleException("api.yml not found in $projectDir")

        // Parse package.json (using regex to avoid heavy JSON library dependency)
        val pkgText = packageJson.readText()
        val version = extractJsonField(pkgText, "version")
            ?: throw GradleException("No 'version' field in package.json")
        val name = extractJsonField(pkgText, "name")
            ?: throw GradleException("No 'name' field in package.json")
        val description = extractJsonField(pkgText, "description") ?: ""

        // Parse and update api.yml
        val yaml = createYaml()
        @Suppress("UNCHECKED_CAST")
        val spec = yaml.load<Any>(apiYml.readText()) as? MutableMap<String, Any?>
            ?: throw GradleException("api.yml is not a valid YAML mapping")

        @Suppress("UNCHECKED_CAST")
        val info = spec.getOrPut("info") { LinkedHashMap<String, Any?>() } as MutableMap<String, Any?>
        info["version"] = version
        info["title"] = name
        info["description"] = description

        apiYml.writeText(yaml.dump(spec))
    }

    private fun extractJsonField(json: String, field: String): String? {
        val pattern = Regex(""""$field"\s*:\s*"([^"]*?)"""")
        return pattern.find(json)?.groupValues?.get(1)
    }

    internal fun createYaml(): Yaml {
        val loaderOptions = LoaderOptions().apply {
            codePointLimit = 64 * 1024 * 1024 // 64 MB — bundled OpenAPI specs can be large
        }
        val dumperOptions = DumperOptions().apply {
            defaultFlowStyle = DumperOptions.FlowStyle.BLOCK
            isPrettyFlow = true
            width = 120
            indent = 2
        }
        return Yaml(Constructor(loaderOptions), Representer(dumperOptions), dumperOptions, loaderOptions)
    }
}
