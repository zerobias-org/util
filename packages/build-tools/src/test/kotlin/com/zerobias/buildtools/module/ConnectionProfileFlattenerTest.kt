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
