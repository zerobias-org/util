package com.zerobias.buildtools.module

import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

/**
 * The generated wire-protocol route had no coverage at all, which is how it went years
 * disagreeing with the REST controllers generated beside it: those deserialize their params
 * before calling the impl, this one passed raw JSON straight through. Production only ever uses
 * this route, so a model field typed as a wrapper (DateTime since codegen 3.x, UUID, an enum)
 * reached the impl as a bare string and threw on the first `.toDate()`.
 */
class ServerEntryPointGeneratorTest {

    private val generated = ServerEntryPointGenerator.generate("Costexplorer")

    @Test
    fun `execute route deserializes its arguments`() {
        assertTrue(
            generated.contains("ObjectSerializer.deserialize(value, declared.type, declared.format || '')"),
            "the wire-protocol route must deserialize each arg, not hand raw JSON to the impl"
        )
        assertTrue(
            generated.contains("const { ObjectSerializer } = await import('./model/index.js');"),
            "ObjectSerializer must be imported dynamically, like every other generated-model import here"
        )
    }

    @Test
    fun `raw positional mapping is gone`() {
        assertTrue(
            !generated.contains("const args = paramNames.map(name => argMap?.[name]);"),
            "the raw pass-through is the bug; it must not survive alongside the fix"
        )
    }

    @Test
    fun `param types are read from the manifest and tolerate an older one`() {
        assertTrue(
            generated.contains("manifest.operationParamTypes || {}"),
            "a module built before operationParamTypes existed must still resolve names and skip deserialization"
        )
        assertTrue(
            generated.contains("paramTypes.find(p => p.name === name)"),
            "params are matched by name so operationParams and operationParamTypes cannot drift"
        )
    }

    @Test
    fun `an empty string is passed through rather than deserialized away`() {
        // ObjectSerializer.deserialize returns undefined for '' and does not throw, so the
        // fallback cannot catch it. Without this guard every empty optional filter, search term,
        // cursor and name param silently became undefined on the way to the impl.
        assertTrue(
            generated.contains("value === undefined || value === null || value === '' || !declared?.type"),
            "an empty-string argument must skip deserialization, not be turned into undefined"
        )
    }

    @Test
    fun `a value that will not deserialize falls back rather than failing the call`() {
        assertTrue(
            generated.contains("passing the raw value through"),
            "an undeserializable type must degrade to the previous behaviour, not 500 a working operation"
        )
    }

    @Test
    fun `the module name is interpolated rather than left as a template hole`() {
        assertTrue(generated.contains("CostexplorerImpl"), "module impl import must be interpolated")
        assertTrue(!generated.contains("\${pascal}"), "no unresolved Kotlin template markers may reach the output")
    }
}
