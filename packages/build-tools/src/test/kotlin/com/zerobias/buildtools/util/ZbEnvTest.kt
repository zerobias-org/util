package com.zerobias.buildtools.util

import org.gradle.api.GradleException
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Test

/**
 * `ZB_ENV` parsing and the endpoints each environment supplies ([ZbEnv]). The precedence of those
 * endpoints against the explicit variables is tested where each is used: OrgPublishTest and
 * NeonDataloaderTaskTest.
 */
class ZbEnvTest {

    // ── parse ──────────────────────────────────────────────────────────

    @Test
    fun `each environment parses from its name, ignoring case and surrounding whitespace`() {
        val expected = mapOf("prod" to ZbEnv.PROD, "uat" to ZbEnv.UAT, "qa" to ZbEnv.QA, "ci" to ZbEnv.CI)
        for ((name, env) in expected) {
            for (raw in listOf(name, name.uppercase(), name.replaceFirstChar { it.uppercase() }, "  $name\t", "\n$name ")) {
                assertEquals(env, ZbEnv.parse(raw), "ZB_ENV='$raw'")
            }
        }
    }

    @Test
    fun `dev is an alias for ci`() {
        for (raw in listOf("dev", "DEV", "Dev", " dev ")) {
            assertEquals(ZbEnv.CI, ZbEnv.parse(raw), "ZB_ENV='$raw'")
        }
    }

    @Test
    fun `unset or blank selects no environment`() {
        for (raw in listOf(null, "", " ", "\t\n")) {
            assertNull(ZbEnv.parse(raw), "ZB_ENV='$raw'")
        }
    }

    @Test
    fun `any other value fails, naming the value as given`() {
        for (raw in listOf("staging", "production", "app", "local", "ci2", "prod,uat", " Staging ")) {
            val e = assertThrows(GradleException::class.java) { ZbEnv.parse(raw) }
            assertEquals("ZB_ENV must be prod, uat, qa or ci (dev = ci), not '$raw'", e.message)
        }
    }

    // ── Endpoints ──────────────────────────────────────────────────────

    @Test
    fun `each environment's platform, dataloader-service and registry URLs`() {
        val expected = mapOf(
            ZbEnv.PROD to listOf("https://app.zerobias.com", "https://pkg.zerobias.org"),
            ZbEnv.UAT to listOf("https://uat.zerobias.com", "https://uat.pkg.zerobias.org"),
            ZbEnv.QA to listOf("https://qa.zerobias.com", "https://qa.pkg.zerobias.org"),
            ZbEnv.CI to listOf("https://ci.zerobias.com", "https://ci.pkg.zerobias.org"),
        )
        assertEquals(ZbEnv.values().toSet(), expected.keys)
        for ((env, urls) in expected) {
            val (base, registry) = urls
            assertEquals(base, env.platformBaseUrl, "$env")
            assertEquals("$base/api", env.platformApiUrl, "$env")
            assertEquals("$base/api/dataloader", env.dataloaderServiceUrl, "$env")
            assertEquals(registry, env.registryUrl, "$env")
        }
    }

    @Test
    fun `gate-stamp channels - none for prod, dev for ci`() {
        assertNull(ZbEnv.PROD.channel)
        assertEquals("uat", ZbEnv.UAT.channel)
        assertEquals("qa", ZbEnv.QA.channel)
        assertEquals("dev", ZbEnv.CI.channel)
    }

    // ── forPlatformUrl ─────────────────────────────────────────────────

    @Test
    fun `a URL on an environment's app host maps to that environment`() {
        for (env in ZbEnv.values()) {
            val host = env.platformBaseUrl.removePrefix("https://")
            for (url in listOf(
                env.platformBaseUrl, env.platformApiUrl, env.dataloaderServiceUrl, "${env.dataloaderServiceUrl}/",
                "http://$host/api", "https://$host:443/api/dataloader", "https://${host.uppercase()}/API",
                "  ${env.dataloaderServiceUrl}  ", "$host/api/dataloader",
            )) {
                assertEquals(env, ZbEnv.forPlatformUrl(url), url)
            }
        }
    }

    @Test
    fun `any other host maps to no environment`() {
        for (url in listOf(
            "http://127.0.0.1:9", "http://localhost:8080/api/dataloader", "localhost:3000",
            "https://pkg.zerobias.org", "https://uat.pkg.zerobias.org", "https://dev.zerobias.com/api",
            "https://zerobias.com/api", "https://api.uat.zerobias.com/api", "https://uat.zerobias.com.example.com/api",
            "https://example.com/uat.zerobias.com", "", "   ", "not a url", "https://",
        )) {
            assertNull(ZbEnv.forPlatformUrl(url), url)
        }
    }
}
