package com.zerobias.buildtools.module

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNotNull
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import java.io.File
import java.nio.file.Path

class ConnectionProfileFlattenerTest {

    // Mirrors the shape of a Redocly-bundled msgraph spec: the external $refs to
    // @zerobias-org/types-core have been inlined into components.schemas, and
    // ConnectionProfile composes them via internal #/components/schemas refs.
    private val bundledMsgraphLikeSpec = """
        openapi: 3.0.3
        info:
          title: msgraph
        components:
          schemas:
            OauthTokenProfile:
              type: object
              description: Profile for connecting to a remote system via an OAuth token.
              properties:
                url:
                  type: string
                  format: url
                tokenType:
                  type: string
                  default: bearer
                accessToken:
                  type: string
                  format: password
            OauthTokenState:
              type: object
              description: State object for connections leveraging the OAuth Authorization Code flow.
              allOf:
                - type: object
                  properties:
                    expiresIn:
                      type: number
                      format: int64
                - type: object
                  properties:
                    url:
                      type: string
                      format: url
                    scope:
                      type: string
                    tokenType:
                      type: string
                      default: bearer
                    accessToken:
                      type: string
                      format: password
                    refreshToken:
                      type: string
                      format: password
            ConnectionProfile:
              type: object
              allOf:
                - ${'$'}ref: '#/components/schemas/OauthTokenProfile'
                - ${'$'}ref: '#/components/schemas/OauthTokenState'
                - type: object
                  required:
                    - directoryId
                  description: Additional properties for an MSGraph Connection.
                  x-oauth-providers:
                    - microsoft.oauth
                  x-ui-required:
                    - directoryId
                    - clientId
                    - clientSecret
                  x-ui-hidden:
                    - tokenType
                    - accessToken
                    - refreshToken
                    - expiresIn
                    - scope
                    - url
                  properties:
                    directoryId:
                      type: string
                    clientId:
                      type: string
                    clientSecret:
                      type: string
                      format: password
    """.trimIndent()

    @Test
    fun `flatten hoists subschema description and x-oauth-providers to root`(@TempDir tmp: Path) {
        val spec = File(tmp.toFile(), "full.yml")
        spec.writeText(bundledMsgraphLikeSpec)

        ConnectionProfileFlattener.flatten(spec)

        val cp = loadConnectionProfile(spec)
        assertFalse(cp.containsKey("allOf"), "allOf must be removed after flatten")
        assertEquals("object", cp["type"])
        assertEquals(
            "Additional properties for an MSGraph Connection.",
            cp["description"]
        )
        assertEquals(listOf("microsoft.oauth"), cp["x-oauth-providers"])
        assertEquals(listOf("directoryId"), cp["required"])
        assertEquals(
            listOf("directoryId", "clientId", "clientSecret"),
            cp["x-ui-required"]
        )
    }

    @Test
    fun `flatten merges properties from all subschemas`(@TempDir tmp: Path) {
        val spec = File(tmp.toFile(), "full.yml")
        spec.writeText(bundledMsgraphLikeSpec)

        ConnectionProfileFlattener.flatten(spec)

        val cp = loadConnectionProfile(spec)
        @Suppress("UNCHECKED_CAST")
        val props = cp["properties"] as Map<String, Any?>
        val expected = setOf(
            "url", "scope", "tokenType", "accessToken", "refreshToken",
            "expiresIn", "directoryId", "clientId", "clientSecret"
        )
        assertEquals(expected, props.keys)
    }

    @Test
    fun `flatten is a no-op when schema has no allOf`(@TempDir tmp: Path) {
        val spec = File(tmp.toFile(), "full.yml")
        spec.writeText(
            """
            openapi: 3.0.3
            components:
              schemas:
                ConnectionProfile:
                  type: object
                  description: already flat
                  properties:
                    token:
                      type: string
            """.trimIndent()
        )
        val before = spec.readText()

        ConnectionProfileFlattener.flatten(spec)

        val cp = loadConnectionProfile(spec)
        assertEquals("already flat", cp["description"])
        assertFalse(cp.containsKey("allOf"))
        assertEquals(before.trim(), spec.readText().trim())
    }

    @Test
    fun `flatten is a no-op when schema is missing`(@TempDir tmp: Path) {
        val spec = File(tmp.toFile(), "full.yml")
        spec.writeText(
            """
            openapi: 3.0.3
            components:
              schemas:
                SomethingElse:
                  type: object
            """.trimIndent()
        )
        val before = spec.readText()

        ConnectionProfileFlattener.flatten(spec)
        assertEquals(before, spec.readText())
    }

    @Test
    fun `flatten uses array-replace semantics so later subschema required wins`(@TempDir tmp: Path) {
        // Preserves fixAllOfs.js behavior: later subschemas replace earlier arrays,
        // matching the npm `deepmerge` arrayMerge override used at publish time.
        val spec = File(tmp.toFile(), "full.yml")
        spec.writeText(
            """
            openapi: 3.0.3
            components:
              schemas:
                ConnectionProfile:
                  type: object
                  allOf:
                    - type: object
                      required: [a, b]
                      properties:
                        a: { type: string }
                        b: { type: string }
                    - type: object
                      required: [b, c]
                      properties:
                        c: { type: string }
            """.trimIndent()
        )

        ConnectionProfileFlattener.flatten(spec)

        val cp = loadConnectionProfile(spec)
        @Suppress("UNCHECKED_CAST")
        val required = cp["required"] as List<String>
        assertEquals(listOf("b", "c"), required)
    }

    @Test
    fun `flatten dedupes within-array duplicates in required`(@TempDir tmp: Path) {
        val spec = File(tmp.toFile(), "full.yml")
        spec.writeText(
            """
            openapi: 3.0.3
            components:
              schemas:
                ConnectionProfile:
                  type: object
                  allOf:
                    - type: object
                      required: [a, b, a]
                      properties:
                        a: { type: string }
                        b: { type: string }
            """.trimIndent()
        )

        ConnectionProfileFlattener.flatten(spec)

        val cp = loadConnectionProfile(spec)
        @Suppress("UNCHECKED_CAST")
        val required = cp["required"] as List<String>
        assertEquals(listOf("a", "b"), required)
    }

    @Test
    fun `flatten respects root-level overrides of subschema values`(@TempDir tmp: Path) {
        val spec = File(tmp.toFile(), "full.yml")
        spec.writeText(
            """
            openapi: 3.0.3
            components:
              schemas:
                ConnectionProfile:
                  type: object
                  description: root wins
                  allOf:
                    - type: object
                      description: subschema loses
                      properties:
                        a: { type: string }
            """.trimIndent()
        )

        ConnectionProfileFlattener.flatten(spec)

        val cp = loadConnectionProfile(spec)
        assertEquals("root wins", cp["description"])
    }

    // Mirrors the actual redocly-bundled msgraph dist yml shape: ConnectionProfile is a
    // thin $ref pointer to the real `connectionProfile` schema that owns the allOf.
    private val bundledMsgraphAliasedSpec = """
        openapi: 3.0.3
        info:
          title: msgraph
        components:
          schemas:
            oauthTokenProfile:
              type: object
              properties:
                url:
                  type: string
                accessToken:
                  type: string
            oauthTokenState:
              type: object
              properties:
                refreshToken:
                  type: string
                expiresIn:
                  type: number
            connectionProfile:
              type: object
              allOf:
                - ${'$'}ref: '#/components/schemas/oauthTokenProfile'
                - ${'$'}ref: '#/components/schemas/oauthTokenState'
                - type: object
                  description: Additional properties for an MSGraph Connection.
                  required:
                    - directoryId
                  x-oauth-providers:
                    - microsoft.oauth
                  properties:
                    directoryId:
                      type: string
                    clientId:
                      type: string
            ConnectionProfile:
              ${'$'}ref: '#/components/schemas/connectionProfile'
    """.trimIndent()

    @Test
    fun `flatten follows $ref aliases from capitalized schema to real target`(@TempDir tmp: Path) {
        val spec = File(tmp.toFile(), "dist.yml")
        spec.writeText(bundledMsgraphAliasedSpec)

        ConnectionProfileFlattener.flatten(spec)

        // The alias's target schema (lowercase `connectionProfile`) should be flattened
        // in place; the `ConnectionProfile` $ref alias is left alone so both lookups work.
        @Suppress("UNCHECKED_CAST")
        val yaml = MetadataSyncer.createYaml()
        val parsed = yaml.load<Any>(spec.readText()) as Map<String, Any?>
        val schemas = (parsed["components"] as Map<String, Any?>)["schemas"] as Map<String, Any?>
        val flat = schemas["connectionProfile"] as Map<String, Any?>

        assertFalse(flat.containsKey("allOf"), "connectionProfile.allOf must be removed")
        assertEquals("Additional properties for an MSGraph Connection.", flat["description"])
        assertEquals(listOf("microsoft.oauth"), flat["x-oauth-providers"])
        assertEquals(listOf("directoryId"), flat["required"])

        @Suppress("UNCHECKED_CAST")
        val props = flat["properties"] as Map<String, Any?>
        assertTrue(props.containsKey("url"), "merged props must include oauthTokenProfile.url")
        assertTrue(props.containsKey("refreshToken"), "merged props must include oauthTokenState.refreshToken")
        assertTrue(props.containsKey("directoryId"))
        assertTrue(props.containsKey("clientId"))

        // The alias entry itself is untouched.
        @Suppress("UNCHECKED_CAST")
        val alias = schemas["ConnectionProfile"] as Map<String, Any?>
        assertEquals("#/components/schemas/connectionProfile", alias["\$ref"])
    }

    @Test
    fun `flattenToStandaloneFile writes bare flattened schema without components wrapper`(@TempDir tmp: Path) {
        val spec = File(tmp.toFile(), "dist.yml")
        spec.writeText(bundledMsgraphAliasedSpec)
        val out = File(tmp.toFile(), "connectionProfile.yml")

        ConnectionProfileFlattener.flattenToStandaloneFile(spec, out)

        assertTrue(out.exists())
        val yaml = MetadataSyncer.createYaml()
        @Suppress("UNCHECKED_CAST")
        val parsed = yaml.load<Any>(out.readText()) as Map<String, Any?>

        // Bare schema — no components/schemas wrapper.
        assertFalse(parsed.containsKey("components"))
        assertFalse(parsed.containsKey("allOf"))
        assertEquals("object", parsed["type"])
        assertEquals("Additional properties for an MSGraph Connection.", parsed["description"])
        assertEquals(listOf("microsoft.oauth"), parsed["x-oauth-providers"])
        assertEquals(listOf("directoryId"), parsed["required"])

        @Suppress("UNCHECKED_CAST")
        val props = parsed["properties"] as Map<String, Any?>
        assertEquals(
            setOf("url", "accessToken", "refreshToken", "expiresIn", "directoryId", "clientId"),
            props.keys
        )
    }

    @Test
    fun `flattenToStandaloneFile works against non-aliased schema`(@TempDir tmp: Path) {
        // When ConnectionProfile owns the allOf directly (no $ref alias), the standalone
        // output must still be the bare flattened schema.
        val spec = File(tmp.toFile(), "full.yml")
        spec.writeText(bundledMsgraphLikeSpec)
        val out = File(tmp.toFile(), "connectionProfile.yml")

        ConnectionProfileFlattener.flattenToStandaloneFile(spec, out)

        val yaml = MetadataSyncer.createYaml()
        @Suppress("UNCHECKED_CAST")
        val parsed = yaml.load<Any>(out.readText()) as Map<String, Any?>
        assertFalse(parsed.containsKey("allOf"))
        assertEquals("Additional properties for an MSGraph Connection.", parsed["description"])
        assertEquals(listOf("microsoft.oauth"), parsed["x-oauth-providers"])
    }

    @Suppress("UNCHECKED_CAST")
    private fun loadConnectionProfile(specFile: File): Map<String, Any?> {
        val yaml = MetadataSyncer.createYaml()
        val spec = yaml.load<Any>(specFile.readText()) as Map<String, Any?>
        val components = spec["components"] as Map<String, Any?>
        val schemas = components["schemas"] as Map<String, Any?>
        val cp = schemas["ConnectionProfile"]
        assertNotNull(cp, "ConnectionProfile schema should exist")
        return cp as Map<String, Any?>
    }
}
