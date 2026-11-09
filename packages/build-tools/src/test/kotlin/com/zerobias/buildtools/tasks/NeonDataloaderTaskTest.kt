package com.zerobias.buildtools.tasks

import com.zerobias.buildtools.util.ZbEnv
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

/**
 * The environment decisions around [NeonDataloaderTask]'s load: what a missing `ZB_TOKEN` does
 * ([dataloaderTokenCheck]), which force flag the loader gets ([dataloaderForceMode]), which
 * dataloader-service it talks to ([NeonDataloaderTask.serviceBaseUrl]) and which environment the
 * gate stamp records its check as ([checkedDataloaderEnv]). GateStampDataloaderFunctionalTest
 * runs the task itself through a gate.
 */
class NeonDataloaderTaskTest {

    // ── ZB_TOKEN ───────────────────────────────────────────────────────

    @Test
    fun `a token loads, in CI or not`() {
        for (ci in listOf("true", "false", null)) {
            assertEquals(DataloaderTokenCheck.LOAD, dataloaderTokenCheck("zb-api-key", ci), "CI=$ci")
        }
    }

    @Test
    fun `no token under CI=true fails, whether unset or blank`() {
        for (token in listOf(null, "", "   ")) {
            assertEquals(DataloaderTokenCheck.FAIL, dataloaderTokenCheck(token, "true"), "token='$token'")
        }
    }

    @Test
    fun `no token outside CI skips`() {
        for (ci in listOf(null, "", "false", "1")) {
            for (token in listOf(null, "", "   ")) {
                assertEquals(DataloaderTokenCheck.SKIP, dataloaderTokenCheck(token, ci), "token='$token' CI=$ci")
            }
        }
    }

    @Test
    fun `the CI failure names the task, ZB_TOKEN and why it does not skip`() {
        val message = missingTokenMessage(DATALOADER_TASK_NAME)
        assertTrue(message.startsWith("dataloaderExec: ZB_TOKEN is not set"), message)
        assertTrue(message.contains("CI=true"), message)
        assertTrue(message.contains("skipped load would let the gate pass"), message)
    }

    // ── Force mode, as (force, forceDirect) ────────────────────────────

    @Test
    fun `CI defaults to -f, local runs to --force-direct`() {
        assertEquals(true to false, dataloaderForceMode(force = false, forceDirect = false, ci = true))
        assertEquals(false to true, dataloaderForceMode(force = false, forceDirect = false, ci = false))
    }

    @Test
    fun `forceDirect (zbb gate --force-direct) selects --force-direct even under CI`() {
        assertEquals(false to true, dataloaderForceMode(force = false, forceDirect = true, ci = true))
        assertEquals(false to true, dataloaderForceMode(force = false, forceDirect = true, ci = false))
    }

    @Test
    fun `force wins over forceDirect`() {
        for (ci in listOf(true, false)) {
            assertEquals(true to false, dataloaderForceMode(force = true, forceDirect = true, ci = ci), "CI=$ci")
            assertEquals(true to false, dataloaderForceMode(force = true, forceDirect = false, ci = ci), "CI=$ci")
        }
    }

    // ── Dataloader-service URL (DATALOADER_SERVICE_URL, ZB_ENV) ─────────

    @Test
    fun `the service is prod's without DATALOADER_SERVICE_URL or ZB_ENV`() {
        assertEquals("https://app.zerobias.com/api/dataloader", NeonDataloaderTask.serviceBaseUrl(null, null))
        assertEquals(ZbEnv.PROD.dataloaderServiceUrl, NeonDataloaderTask.serviceBaseUrl(null, null))
    }

    @Test
    fun `the service follows ZB_ENV when DATALOADER_SERVICE_URL is unset or blank`() {
        for (env in ZbEnv.values()) {
            for (override in listOf(null, "", "  ")) {
                assertEquals(
                    env.dataloaderServiceUrl, NeonDataloaderTask.serviceBaseUrl(override, env), "$env override='$override'",
                )
            }
        }
        assertEquals("https://ci.zerobias.com/api/dataloader", NeonDataloaderTask.serviceBaseUrl(null, ZbEnv.CI))
    }

    @Test
    fun `DATALOADER_SERVICE_URL wins over ZB_ENV`() {
        for (env in listOf<ZbEnv?>(null) + ZbEnv.values()) {
            assertEquals("http://127.0.0.1:9", NeonDataloaderTask.serviceBaseUrl("http://127.0.0.1:9", env), "$env")
        }
    }

    // ── The check a gate stamp records (checkedDataloaderEnv) ──────────

    @Test
    fun `a prod or unrecognised service records the check DATALOADER_ENV asked for`() {
        val services = listOf(ZbEnv.PROD.dataloaderServiceUrl, "http://localhost:8080/api/dataloader", "http://127.0.0.1:9")
        for (service in services) {
            for (requested in listOf(null, "dev", "qa")) {
                assertEquals(requested, checkedDataloaderEnv(requested, service), "requested=$requested service=$service")
            }
        }
    }

    @Test
    fun `a non-prod service records its environment, ci's as dev`() {
        assertEquals("uat", checkedDataloaderEnv(null, ZbEnv.UAT.dataloaderServiceUrl))
        assertEquals("qa", checkedDataloaderEnv(null, ZbEnv.QA.dataloaderServiceUrl))
        assertEquals("dev", checkedDataloaderEnv(null, ZbEnv.CI.dataloaderServiceUrl))
    }

    @Test
    fun `DATALOADER_ENV and a non-prod service record the more restrictive - dev, then qa, then uat`() {
        val recorded = mapOf(
            ("dev" to ZbEnv.UAT) to "dev",
            ("dev" to ZbEnv.QA) to "dev",
            ("dev" to ZbEnv.CI) to "dev",
            ("qa" to ZbEnv.UAT) to "qa",
            ("qa" to ZbEnv.QA) to "qa",
            ("qa" to ZbEnv.CI) to "dev",
        )
        for ((check, expected) in recorded) {
            val (requested, service) = check
            assertEquals(
                expected, checkedDataloaderEnv(requested, service.dataloaderServiceUrl), "requested=$requested service=$service",
            )
        }
    }

    /**
     * DATALOADER_SERVICE_URL wins over ZB_ENV, so a local service under `ZB_ENV=uat` is not a uat
     * check, and a uat service picked by hand is one without ZB_ENV.
     */
    @Test
    fun `the stamp follows the service the check talks to, not ZB_ENV itself`() {
        val local = "http://localhost:8080/api/dataloader"
        val uat = "https://uat.zerobias.com/api/dataloader"
        assertEquals("uat", checkedDataloaderEnv(null, NeonDataloaderTask.serviceBaseUrl(null, ZbEnv.UAT)))
        assertNull(checkedDataloaderEnv(null, NeonDataloaderTask.serviceBaseUrl(local, ZbEnv.UAT)))
        assertEquals("uat", checkedDataloaderEnv(null, NeonDataloaderTask.serviceBaseUrl(uat, null)))
    }

    @Test
    fun `a value outside the known order counts as the most restrictive`() {
        assertEquals("staging", checkedDataloaderEnv("staging", ZbEnv.CI.dataloaderServiceUrl))
    }
}
