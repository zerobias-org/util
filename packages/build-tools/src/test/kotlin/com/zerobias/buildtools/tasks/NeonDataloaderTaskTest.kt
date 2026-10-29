package com.zerobias.buildtools.tasks

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

/**
 * What [NeonDataloaderTask] does when `ZB_TOKEN` is missing ([dataloaderTokenCheck]).
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

}
