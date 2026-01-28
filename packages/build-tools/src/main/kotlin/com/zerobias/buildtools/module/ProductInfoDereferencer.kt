package com.zerobias.buildtools.module

import org.gradle.api.GradleException
import org.yaml.snakeyaml.Yaml
import java.io.File

/**
 * Resolves $ref entries in the x-product-infos array of an OpenAPI spec.
 *
 * Replaces: dereference-product-infos.sh
 *
 * The script reads full.yml, finds all $ref entries in .info.x-product-infos,
 * resolves each reference (file path + JSON pointer), and inlines the content.
 *
 * Reference format: "./node_modules/@zerobias-org/product-github-github/catalog.yml#/Product"
 *   - Before #: relative file path
 *   - After #: JSON pointer (RFC 6901) into the file
 */
object ProductInfoDereferencer {

    /**
     * Dereference all $ref entries in spec's info.x-product-infos array.
     * Writes result to outputFile. No-op if x-product-infos is absent or empty.
     *
     * @param inputFile The bundled spec file to read
     * @param outputFile The output file to write (can be same as input for in-place)
     * @param workingDir The directory for resolving relative $ref paths
     */
    fun dereference(inputFile: File, outputFile: File, workingDir: File) {
        if (!inputFile.exists()) return

        val yaml = MetadataSyncer.createYaml()
        @Suppress("UNCHECKED_CAST")
        val spec = yaml.load<Any>(inputFile.readText()) as? MutableMap<String, Any?> ?: return

        @Suppress("UNCHECKED_CAST")
        val info = spec["info"] as? MutableMap<String, Any?> ?: return

        @Suppress("UNCHECKED_CAST")
        val productInfos = info["x-product-infos"] as? MutableList<Any?> ?: return

        if (productInfos.isEmpty()) {
            // No refs to resolve, just copy if needed
            if (inputFile != outputFile) {
                outputFile.parentFile?.mkdirs()
                inputFile.copyTo(outputFile, overwrite = true)
            }
            return
        }

        val resolved = productInfos.map { entry ->
            if (entry is Map<*, *> && entry.containsKey("\$ref")) {
                val ref = entry["\$ref"] as? String
                    ?: throw GradleException("x-product-infos entry has null \$ref")
                resolveRef(ref, workingDir, yaml)
            } else {
                entry
            }
        }

        info["x-product-infos"] = resolved
        outputFile.parentFile?.mkdirs()
        outputFile.writeText(yaml.dump(spec))
    }

    private fun resolveRef(ref: String, workingDir: File, yaml: Yaml): Any {
        val parts = ref.split("#", limit = 2)
        val filePath = parts[0]
        val pointer = if (parts.size > 1) parts[1] else ""

        val refFile = workingDir.resolve(filePath)
        if (!refFile.exists()) {
            throw GradleException(
                "Referenced file not found: $filePath (resolved to ${refFile.absolutePath}). " +
                "Ensure npm install has been run."
            )
        }

        val data = yaml.load<Any>(refFile.readText())
            ?: throw GradleException("Referenced file is empty: $filePath")

        return if (pointer.isBlank() || pointer == "/") {
            data
        } else {
            navigatePointer(data, pointer, ref)
        }
    }

    private fun navigatePointer(data: Any, pointer: String, fullRef: String): Any {
        val segments = pointer.trimStart('/').split('/')
        var current: Any = data

        for (segment in segments) {
            current = when (current) {
                is Map<*, *> -> current[segment]
                    ?: throw GradleException("JSON pointer segment '$segment' not found in '$fullRef'")
                is List<*> -> {
                    val index = segment.toIntOrNull()
                        ?: throw GradleException("Expected array index but got '$segment' in '$fullRef'")
                    current.getOrNull(index)
                        ?: throw GradleException("Array index $index out of bounds in '$fullRef'")
                }
                else -> throw GradleException(
                    "Cannot navigate pointer segment '$segment' into ${current::class.simpleName} in '$fullRef'"
                )
            }
        }

        return current
    }
}
