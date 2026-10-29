package com.zerobias.buildtools.tasks

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

/**
 * The environment decisions [NeonDataloaderTask] makes before it loads: what a missing `ZB_TOKEN`
 * does ([dataloaderTokenCheck]) and which force flag the loader gets ([dataloaderForceMode]).
 * GateStampDataloaderFunctionalTest runs the task itself through a gate.
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
}
