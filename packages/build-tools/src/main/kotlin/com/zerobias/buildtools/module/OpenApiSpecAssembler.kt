package com.zerobias.buildtools.module

import org.gradle.api.GradleException
import java.io.File

/**
 * Assembles the full OpenAPI spec from api.yml plus optional ConnectionProfile/State refs.
 *
 * Replaces the generate:full npm script:
 *   cp api.yml full.yml
 *   if test -f connectionProfile.yml; then
 *     yq e -i '.components.schemas.ConnectionProfile.$ref'=\"./connectionProfile.yml\" full.yml
 *   fi
 *   if test -f connectionState.yml; then
 *     yq e -i '.components.schemas.ConnectionState.$ref'=\"./connectionState.yml\" full.yml
 *   fi
 */
object OpenApiSpecAssembler {

    /**
     * Assemble spec from api.yml, injecting ConnectionProfile and ConnectionState
     * $ref entries if the corresponding files exist in the project directory.
     *
     * @param projectDir The module project directory containing api.yml
     * @param outputFile The output file to write (e.g., build/spec/full-assembled.yml)
     */
    fun assemble(projectDir: File, outputFile: File) {
        val apiYml = projectDir.resolve("api.yml")

        if (!apiYml.exists()) throw GradleException("api.yml not found in $projectDir")

        // Ensure output directory exists
        outputFile.parentFile?.mkdirs()

        // Copy api.yml → output
        apiYml.copyTo(outputFile, overwrite = true)

        // Parse output file
        val yaml = MetadataSyncer.createYaml()
        @Suppress("UNCHECKED_CAST")
        val spec = yaml.load<Any>(outputFile.readText()) as? MutableMap<String, Any?>
            ?: throw GradleException("${outputFile.name} is not a valid YAML mapping")

        // Ensure components.schemas exists
        @Suppress("UNCHECKED_CAST")
        val components = spec.getOrPut("components") { LinkedHashMap<String, Any?>() } as MutableMap<String, Any?>
        @Suppress("UNCHECKED_CAST")
        val schemas = components.getOrPut("schemas") { LinkedHashMap<String, Any?>() } as MutableMap<String, Any?>

        // Inject ConnectionProfile $ref if file exists
        if (projectDir.resolve("connectionProfile.yml").exists()) {
            schemas["ConnectionProfile"] = LinkedHashMap<String, Any?>().apply {
                put("\$ref", "./connectionProfile.yml")
            }
        }

        // Inject ConnectionState $ref if file exists
        if (projectDir.resolve("connectionState.yml").exists()) {
            schemas["ConnectionState"] = LinkedHashMap<String, Any?>().apply {
                put("\$ref", "./connectionState.yml")
            }
        }

        outputFile.writeText(yaml.dump(spec))
    }

    /**
     * Copy a spec file, stripping ConnectionProfile and ConnectionState schemas.
     * Used to produce the distribution spec (module-{name}.yml) which describes
     * "what the module does" without connection details.
     */
    fun copyWithoutConnectionSchemas(source: File, dest: File) {
        val yaml = MetadataSyncer.createYaml()
        @Suppress("UNCHECKED_CAST")
        val spec = yaml.load<Any>(source.readText()) as? MutableMap<String, Any?>
            ?: throw GradleException("${source.name} is not a valid YAML mapping")

        @Suppress("UNCHECKED_CAST")
        val components = spec["components"] as? MutableMap<String, Any?>
        @Suppress("UNCHECKED_CAST")
        val schemas = components?.get("schemas") as? MutableMap<String, Any?>

        schemas?.remove("ConnectionProfile")
        schemas?.remove("ConnectionState")

        dest.parentFile?.mkdirs()
        dest.writeText(yaml.dump(spec))
    }

    /**
     * Derive the module name from package.json (strips npm scope).
     * E.g., "@auditlogic/module-github-github" → "module-github-github"
     */
    fun resolveModuleName(projectDir: File): String {
        val packageJson = projectDir.resolve("package.json")
        if (packageJson.exists()) {
            val text = packageJson.readText()
            val match = Regex(""""name"\s*:\s*"([^"]*?)"""").find(text)
            val name = match?.groupValues?.get(1) ?: ""
            if (name.contains("/")) {
                return name.substringAfter("/")
            }
            if (name.isNotBlank()) return name
        }
        // Fallback: directory-based name
        return "module-${projectDir.parentFile.name}-${projectDir.name}"
    }
}
