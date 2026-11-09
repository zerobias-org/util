package com.zerobias.buildtools.tasks

import com.zerobias.buildtools.util.ZbEnv
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Test

/**
 * Where an org publish sends its requests: the explicit variable (`ZB_PLATFORM_URL`,
 * `PUBLISH_ORG_REGISTRY_URL`) when set, else the environment `ZB_ENV` selects, else prod.
 */
class OrgPublishTest {

    private val nonProd = listOf(ZbEnv.UAT, ZbEnv.QA, ZbEnv.CI)

    // ── Platform API (ZB_PLATFORM_URL) ─────────────────────────────────

    @Test
    fun `platform API is prod's without ZB_PLATFORM_URL or ZB_ENV`() {
        assertEquals(OrgPublish.DEFAULT_PLATFORM_URL, OrgPublish.platformUrl(null, null))
        assertEquals(ZbEnv.PROD.platformApiUrl, OrgPublish.platformUrl(null, null))
    }

    @Test
    fun `platform API follows ZB_ENV when ZB_PLATFORM_URL is unset or blank`() {
        for (env in ZbEnv.values()) {
            for (override in listOf(null, "", "  ")) {
                assertEquals(env.platformApiUrl, OrgPublish.platformUrl(override, env), "$env override='$override'")
            }
        }
        assertEquals("https://uat.zerobias.com/api", OrgPublish.platformUrl(null, ZbEnv.UAT))
    }

    @Test
    fun `ZB_PLATFORM_URL wins over ZB_ENV, without its trailing slash`() {
        for (env in listOf<ZbEnv?>(null) + ZbEnv.values()) {
            assertEquals("http://localhost:8080/api", OrgPublish.platformUrl("http://localhost:8080/api/", env), "$env")
        }
    }

    // ── Registry (PUBLISH_ORG_REGISTRY_URL) ────────────────────────────

    @Test
    fun `registry is prod verdaccio without PUBLISH_ORG_REGISTRY_URL or ZB_ENV`() {
        assertEquals(OrgPublish.DEFAULT_REGISTRY_URL, OrgPublish.registryUrl(null, null))
        assertEquals(ZbEnv.PROD.registryUrl, OrgPublish.registryUrl(null, null))
    }

    @Test
    fun `registry follows ZB_ENV when PUBLISH_ORG_REGISTRY_URL is unset or blank`() {
        for (env in ZbEnv.values()) {
            for (override in listOf(null, "", "  ")) {
                assertEquals(env.registryUrl, OrgPublish.registryUrl(override, env), "$env override='$override'")
            }
        }
        assertEquals("https://qa.pkg.zerobias.org", OrgPublish.registryUrl(null, ZbEnv.QA))
    }

    @Test
    fun `PUBLISH_ORG_REGISTRY_URL wins over ZB_ENV, without its trailing slash`() {
        for (env in listOf<ZbEnv?>(null) + ZbEnv.values()) {
            assertEquals("http://localhost:4873", OrgPublish.registryUrl("http://localhost:4873/", env), "$env")
        }
    }

    // ── npm publish --registry ─────────────────────────────────────────

    @Test
    fun `a catalog publish stages on next whatever the env`() {
        assertEquals(listOf("--tag", "next"), OrgPublish.npmPublishArgs(isOrgPublish = false))
    }

    @Test
    fun `an org publish to prod passes no --registry, leaving it to the repo's npm config`() {
        for (override in listOf(null, "", "  ")) {
            assertNull(OrgPublish.npmPublishRegistry(override, null), "override='$override'")
            assertNull(OrgPublish.npmPublishRegistry(override, ZbEnv.PROD), "override='$override'")
        }
    }

    @Test
    fun `an org publish to a non-prod ZB_ENV targets that environment's registry`() {
        for (env in nonProd) {
            assertEquals(env.registryUrl, OrgPublish.npmPublishRegistry(null, env), "$env")
            assertEquals(env.registryUrl, OrgPublish.npmPublishRegistry(" ", env), "$env")
        }
        assertEquals("https://ci.pkg.zerobias.org", OrgPublish.npmPublishRegistry(null, ZbEnv.CI))
    }

    @Test
    fun `PUBLISH_ORG_REGISTRY_URL is the org publish's target whatever ZB_ENV selects`() {
        for (env in listOf<ZbEnv?>(null) + ZbEnv.values()) {
            assertEquals("http://localhost:4873", OrgPublish.npmPublishRegistry("http://localhost:4873/", env), "$env")
        }
    }
}
