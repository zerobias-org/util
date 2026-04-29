package com.zerobias.buildtools.module

import org.gradle.api.GradleException
import java.io.File

/**
 * Flattens `components.schemas.ConnectionProfile` allOf composition in a bundled OpenAPI spec.
 *
 * Redocly bundle inlines `$ref`s but leaves `allOf` composition intact. Downstream consumers
 * (notably the platform dataloader) read `description` and `x-oauth-providers` from the schema
 * root, so an unflattened allOf causes them to fall back to generic values. This flattener
 * deep-merges allOf subschemas left-to-right (later wins), then re-applies root-level keys
 * so source-authored annotations beat anything inherited from composed subschemas.
 *
 * Ports scripts/fixAllOfs/fixAllOfs.js from the auditlogic/module repo, including the
 * `$ref`-following behavior at fixAllOfs.js:79-82 that handles the msgraph-style
 * `ConnectionProfile → $ref → connectionProfile` alias produced by redocly bundle.
 */
object ConnectionProfileFlattener {

    /**
     * Flatten `components.schemas.<schemaName>` in the given spec file in place.
     * No-op if the schema is missing or (after alias resolution) has no `allOf`.
     */
    fun flatten(specFile: File, schemaName: String = "ConnectionProfile") {
        if (!specFile.exists()) return

        val yaml = MetadataSyncer.createYaml()
        @Suppress("UNCHECKED_CAST")
        val spec = yaml.load<Any>(specFile.readText()) as? MutableMap<String, Any?> ?: return

        val result = resolveSchema(spec, schemaName) ?: return
        if (!result.wasFlattened) return  // already flat — preserve byte-identical no-op

        @Suppress("UNCHECKED_CAST")
        val schemas = ((spec["components"] as MutableMap<String, Any?>)["schemas"]) as MutableMap<String, Any?>
        schemas[result.resolvedName] = result.schema

        specFile.writeText(yaml.dump(spec))
    }

    /**
     * Resolve `components.schemas.<schemaName>` in [specFile], flatten any `allOf`
     * composition, and write the bare schema (no `components/schemas` wrapper) to
     * [outputFile]. Mirrors the legacy `node fixAllOfs.js cp.yml > connectionProfile.yml`
     * prepublish step.
     *
     * This tolerates already-flattened schemas (since the upstream `copyDistributionSpec`
     * task may have already run `flatten(distYml)` on the bundled spec). It only throws
     * when the named schema can't be found at all.
     */
    fun flattenToStandaloneFile(
        specFile: File,
        outputFile: File,
        schemaName: String = "ConnectionProfile"
    ) {
        if (!specFile.exists()) {
            throw GradleException("Spec file not found: $specFile")
        }

        val yaml = MetadataSyncer.createYaml()
        @Suppress("UNCHECKED_CAST")
        val spec = yaml.load<Any>(specFile.readText()) as? MutableMap<String, Any?>
            ?: throw GradleException("$specFile is not a valid YAML mapping")

        val result = resolveSchema(spec, schemaName)
            ?: throw GradleException(
                "Schema '$schemaName' not found in $specFile"
            )

        outputFile.parentFile?.mkdirs()
        outputFile.writeText(yaml.dump(result.schema))
    }

    private data class ResolveResult(
        val resolvedName: String,
        val schema: MutableMap<String, Any?>,
        /** True if [schema] required `allOf` flattening; false if it was already flat. */
        val wasFlattened: Boolean,
    )

    /**
     * Locate `components.schemas[schemaName]`, follow internal `$ref` aliases of the
     * form `{$ref: '#/components/schemas/Other'}`, and run [mergeAllOf] on the target
     * if it has an `allOf`. Returns null only when the schema is missing.
     *
     * Alias-following ports fixAllOfs.js:79-82, which allowed `ConnectionProfile` to be
     * a thin pointer to the real schema — this is the shape redocly bundle produces for
     * msgraph (`ConnectionProfile: {$ref: '#/components/schemas/connectionProfile'}`).
     */
    private fun resolveSchema(
        spec: MutableMap<String, Any?>,
        schemaName: String
    ): ResolveResult? {
        @Suppress("UNCHECKED_CAST")
        val components = spec["components"] as? MutableMap<String, Any?> ?: return null
        @Suppress("UNCHECKED_CAST")
        val schemas = components["schemas"] as? MutableMap<String, Any?> ?: return null

        var currentName = schemaName
        val seen = mutableSetOf<String>()
        while (true) {
            if (!seen.add(currentName)) {
                throw GradleException("Cycle while resolving schema alias starting at '$schemaName'")
            }
            @Suppress("UNCHECKED_CAST")
            val entry = schemas[currentName] as? Map<String, Any?> ?: return null
            val ref = entry["\$ref"] as? String
            if (ref != null && ref.startsWith("#/components/schemas/") && entry.size == 1) {
                currentName = ref.substringAfterLast('/')
            } else {
                break
            }
        }

        @Suppress("UNCHECKED_CAST")
        val original = schemas[currentName] as? Map<String, Any?> ?: return null
        val hasAllOf = original.containsKey("allOf")
        val resolved = if (hasAllOf) {
            mergeAllOf(deepCopyMap(original), schemas)
        } else {
            deepCopyMap(original)
        }
        return ResolveResult(currentName, resolved, wasFlattened = hasAllOf)
    }

    private fun mergeAllOf(
        schema: MutableMap<String, Any?>,
        rootSchemas: Map<String, Any?>
    ): MutableMap<String, Any?> {
        @Suppress("UNCHECKED_CAST")
        val allOf = schema["allOf"] as? List<Any?>
        if (allOf != null) {
            val rootProps: MutableMap<String, Any?> =
                schema.filterKeys { it != "allOf" }.toMutableMap()

            val processed = allOf.map { entry ->
                mergeAllOf(resolveRef(entry, rootSchemas), rootSchemas)
            }

            var merged: MutableMap<String, Any?> = LinkedHashMap()
            for (sub in processed) {
                merged = deepMerge(merged, sub)
            }
            merged = deepMerge(merged, rootProps)

            if (merged.containsKey("allOf")) {
                merged = mergeAllOf(merged, rootSchemas)
            }

            schema.clear()
            schema.putAll(merged)
        }

        (schema["required"] as? List<*>)?.let { schema["required"] = it.distinct().toMutableList() }
        (schema["enum"] as? List<*>)?.let { schema["enum"] = it.distinct().toMutableList() }

        @Suppress("UNCHECKED_CAST")
        (schema["properties"] as? MutableMap<String, Any?>)?.let { props ->
            for ((key, value) in props.entries.toList()) {
                if (value is Map<*, *>) {
                    @Suppress("UNCHECKED_CAST")
                    props[key] = mergeAllOf(deepCopyMap(value as Map<String, Any?>), rootSchemas)
                }
            }
        }

        schema.remove("allOf")
        return schema
    }

    @Suppress("UNCHECKED_CAST")
    private fun resolveRef(entry: Any?, rootSchemas: Map<String, Any?>): MutableMap<String, Any?> {
        if (entry !is Map<*, *>) {
            throw GradleException("allOf entry is not a mapping: $entry")
        }
        val ref = entry["\$ref"] as? String
        if (ref != null && ref.startsWith("#/components/schemas/")) {
            val refName = ref.substringAfterLast('/')
            val target = rootSchemas[refName]
                ?: throw GradleException("Unresolved schema ref: $ref")
            if (target !is Map<*, *>) {
                throw GradleException("Schema ref target is not a mapping: $ref")
            }
            return deepCopyMap(target as Map<String, Any?>)
        }
        return deepCopyMap(entry as Map<String, Any?>)
    }

    private fun deepMerge(
        left: MutableMap<String, Any?>,
        right: Map<String, Any?>
    ): MutableMap<String, Any?> {
        val out: MutableMap<String, Any?> = LinkedHashMap(left)
        for ((key, rValue) in right) {
            val lValue = out[key]
            out[key] = if (lValue is Map<*, *> && rValue is Map<*, *>) {
                @Suppress("UNCHECKED_CAST")
                deepMerge(
                    deepCopyMap(lValue as Map<String, Any?>),
                    rValue as Map<String, Any?>
                )
            } else {
                deepCopyValue(rValue)
            }
        }
        return out
    }

    private fun deepCopyMap(src: Map<String, Any?>): MutableMap<String, Any?> {
        val out: MutableMap<String, Any?> = LinkedHashMap()
        for ((k, v) in src) {
            out[k] = deepCopyValue(v)
        }
        return out
    }

    @Suppress("UNCHECKED_CAST")
    private fun deepCopyValue(v: Any?): Any? = when (v) {
        is Map<*, *> -> deepCopyMap(v as Map<String, Any?>)
        is List<*> -> v.map { deepCopyValue(it) }.toMutableList()
        else -> v
    }
}
