package com.zerobias.buildtools.schema

import com.fasterxml.jackson.databind.ObjectMapper
import com.fasterxml.jackson.module.kotlin.readValue
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNotEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

class TsTemplatePatcherTest {

    private val pkgTemplate = """
        {
          "name": "{ARTIFACT_NAME}-ts",
          "version": "{VERSION}",
          "description": "typescript interfaces for {ARTIFACT_NAME} schemas",
          "repository": {
            "type": "git",
            "url": "{REPO_URL}",
            "directory": "{REPO_DIR}"
          },
          "scripts": {
            "generate": "npx schema-ts-generator -p {PACKAGE_NAME} -o ./src"
          }
        }
    """.trimIndent()

    private val lockTemplate = """
        {
          "name": "{ARTIFACT_NAME}-ts",
          "version": "{VERSION}",
          "lockfileVersion": 3,
          "packages": {
            "": {
              "name": "{ARTIFACT_NAME}-ts",
              "version": "{VERSION}"
            },
            "node_modules/typescript": {
              "version": "5.9.3"
            }
          }
        }
    """.trimIndent()

    @Test
    fun `patchPackageJson replaces every placeholder`() {
        val out = TsTemplatePatcher.patchPackageJson(
            templateText = pkgTemplate,
            artifactName = "@auditlogic/schema-github-github",
            version = "2.0.0",
            repoUrl = "git@github.com:auditlogic/schema.git",
            repoDir = "package/github/github",
            packageName = "github.github.schema",
        )
        assertFalse(out.contains("{ARTIFACT_NAME}"), "ARTIFACT_NAME left unresolved: $out")
        assertFalse(out.contains("{VERSION}"))
        assertFalse(out.contains("{REPO_URL}"))
        assertFalse(out.contains("{REPO_DIR}"))
        assertFalse(out.contains("{PACKAGE_NAME}"))

        val mapper = ObjectMapper()
        val parsed: Map<String, Any?> = mapper.readValue(out)
        assertEquals("@auditlogic/schema-github-github-ts", parsed["name"])
        assertEquals("2.0.0", parsed["version"])
        @Suppress("UNCHECKED_CAST")
        val repo = parsed["repository"] as Map<String, Any?>
        assertEquals("git@github.com:auditlogic/schema.git", repo["url"])
        assertEquals("package/github/github", repo["directory"])
        @Suppress("UNCHECKED_CAST")
        val scripts = parsed["scripts"] as Map<String, Any?>
        assertTrue(
            (scripts["generate"] as String).contains("-p github.github.schema"),
            "PACKAGE_NAME not interpolated into scripts.generate: ${scripts["generate"]}"
        )
    }

    @Test
    fun `patchPackageLockJson updates name + version at top-level and packages_dot`() {
        val out = TsTemplatePatcher.patchPackageLockJson(
            templateText = lockTemplate,
            artifactName = "@auditlogic/schema-github-github",
            version = "2.0.0",
        )
        val mapper = ObjectMapper()
        val parsed: Map<String, Any?> = mapper.readValue(out)
        assertEquals("@auditlogic/schema-github-github-ts", parsed["name"])
        assertEquals("2.0.0", parsed["version"])

        @Suppress("UNCHECKED_CAST")
        val packages = parsed["packages"] as Map<String, Any?>
        @Suppress("UNCHECKED_CAST")
        val self = packages[""] as Map<String, Any?>
        assertEquals("@auditlogic/schema-github-github-ts", self["name"])
        assertEquals("2.0.0", self["version"])

        // Nested deps must be untouched
        @Suppress("UNCHECKED_CAST")
        val typescript = packages["node_modules/typescript"] as Map<String, Any?>
        assertEquals("5.9.3", typescript["version"])
    }

    @Test
    fun `patchPackageLockVersion leaves name alone but bumps version everywhere needed`() {
        val withNameSet = """
            {
              "name": "@x/y-ts",
              "version": "1.0.0",
              "packages": {
                "": { "name": "@x/y-ts", "version": "1.0.0" },
                "node_modules/foo": { "version": "9.9.9" }
              }
            }
        """.trimIndent()

        val out = TsTemplatePatcher.patchPackageLockVersion(withNameSet, "2.5.1")
        val mapper = ObjectMapper()
        val parsed: Map<String, Any?> = mapper.readValue(out)
        assertEquals("@x/y-ts", parsed["name"], "name should be preserved by version-only patch")
        assertEquals("2.5.1", parsed["version"])

        @Suppress("UNCHECKED_CAST")
        val packages = parsed["packages"] as Map<String, Any?>
        @Suppress("UNCHECKED_CAST")
        val self = packages[""] as Map<String, Any?>
        assertEquals("@x/y-ts", self["name"])
        assertEquals("2.5.1", self["version"])

        @Suppress("UNCHECKED_CAST")
        val foo = packages["node_modules/foo"] as Map<String, Any?>
        assertEquals("9.9.9", foo["version"], "nested dependency versions must NOT be touched")
    }

    @Test
    fun `readPackageName prefers zerobias_package, falls back to auditmation_package`() {
        val zb = mapOf("zerobias" to mapOf("package" to "github.github.schema"))
        assertEquals("github.github.schema", TsTemplatePatcher.readPackageName(zb))

        val legacy = mapOf("auditmation" to mapOf("package" to "github.github.schema"))
        assertEquals("github.github.schema", TsTemplatePatcher.readPackageName(legacy))

        val both = mapOf(
            "zerobias" to mapOf("package" to "new.canonical"),
            "auditmation" to mapOf("package" to "old.legacy"),
        )
        assertEquals("new.canonical", TsTemplatePatcher.readPackageName(both),
            "zerobias should win over auditmation when both present")
    }

    @Test
    fun `isDeprecated reads either config key`() {
        assertTrue(TsTemplatePatcher.isDeprecated(mapOf("zerobias" to mapOf("deprecated" to true))))
        assertTrue(TsTemplatePatcher.isDeprecated(mapOf("auditmation" to mapOf("deprecated" to true))))
        assertFalse(TsTemplatePatcher.isDeprecated(mapOf("zerobias" to mapOf("deprecated" to false))))
        assertFalse(TsTemplatePatcher.isDeprecated(mapOf("zerobias" to mapOf<String, Any?>())))
        assertFalse(TsTemplatePatcher.isDeprecated(mapOf<String, Any?>()))
    }

    @Test
    fun `readPackageName throws on missing config`() {
        try {
            TsTemplatePatcher.readPackageName(mapOf("name" to "@x/y"))
            error("Expected IllegalStateException")
        } catch (e: IllegalStateException) {
            assertTrue(e.message!!.contains("zerobias.package"))
        }
    }

    @Test
    fun `patched template re-parses as valid JSON`() {
        val out = TsTemplatePatcher.patchPackageJson(
            templateText = pkgTemplate,
            artifactName = "@scope/name",
            version = "1.0.0",
            repoUrl = "git@github.com:scope/repo.git",
            repoDir = "package/x",
            packageName = "x.schema",
        )
        // Should be valid JSON; mapper would throw otherwise.
        val mapper = ObjectMapper()
        val parsed: Map<String, Any?> = mapper.readValue(out)
        assertNotEquals(0, parsed.size)
    }
}
