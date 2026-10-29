package com.zerobias.buildtools.standard

import org.gradle.testkit.runner.GradleRunner
import org.gradle.testkit.runner.TaskOutcome
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import java.io.File

/**
 * Runs real gates on throwaway packages through the zb.content and zb.base plugins, without
 * ZB_TOKEN: a local gate skips the load and its stamp records `"dataloaderExec": "skipped"`, which
 * gateCheck refuses; under CI=true the gate fails instead; a package without a dataloader step is
 * unaffected by either. The builds get no ZB_TOKEN and point DATALOADER_SERVICE_URL at a closed
 * local port, so nothing can reach the dataloader-service.
 */
class GateStampDataloaderFunctionalTest {

    @TempDir
    lateinit var tmp: File

    /** A committed one-project git repo applying [plugin], since zb.base reads the branch and hashes git-tracked files. */
    private fun pkg(name: String, plugin: String, buildScriptExtra: String = ""): File {
        val dir = File(tmp, name).apply { mkdirs() }
        File(dir, "settings.gradle.kts").writeText("rootProject.name = \"$name\"\n")
        File(dir, "build.gradle.kts").writeText("plugins { id(\"$plugin\") }\n$buildScriptExtra")
        File(dir, "package.json").writeText("""{ "name": "@zbtest/$name", "version": "1.0.0" }""" + "\n")
        File(dir, ".gitignore").writeText(".gradle/\nbuild/\n.zbb-gradle/\n")
        git(dir, "init", "-q", "-b", "main")
        git(dir, "add", "-A")
        git(dir, "-c", "user.email=test@zerobias.com", "-c", "user.name=test", "commit", "-q", "-m", "init")
        return dir
    }

    private fun contentPkg(): File =
        pkg("content-pkg", "zb.content", "extra[\"contentValidator\"] = { _: org.gradle.api.Project -> }\n")

    private fun git(dir: File, vararg args: String) {
        val process = ProcessBuilder(listOf("git") + args).directory(dir).redirectErrorStream(true).start()
        val output = process.inputStream.bufferedReader().readText()
        check(process.waitFor() == 0) { "git ${args.joinToString(" ")} failed: $output" }
    }

    /** The test JVM's environment without ZB_TOKEN or any dataloader/CI setting, plus CI=true when [ci]. */
    private fun env(ci: Boolean): Map<String, String> =
        System.getenv()
            .filterKeys { it !in setOf("ZB_TOKEN", "CI", "ZBB_MONOREPO_EVENT_FILE") && !it.startsWith("DATALOADER_") }
            .plus("DATALOADER_SERVICE_URL" to "http://127.0.0.1:9")
            .plus(if (ci) mapOf("CI" to "true") else emptyMap())

    private fun gradle(dir: File, ci: Boolean, vararg tasks: String): GradleRunner =
        GradleRunner.create()
            .withProjectDir(dir)
            .withPluginClasspath()
            .withEnvironment(env(ci))
            .withArguments(*tasks, "--stacktrace")

    private fun stamp(dir: File): File = File(dir, "gate-stamp.json")

    /**
     * The same stamp then passes gateCheck once its load reads "passed", so the load entry alone
     * refused it, and without the entry at all, as a stamp written before the entry existed.
     */
    @Test
    fun `a local gate without ZB_TOKEN records the skipped load, and gateCheck refuses the stamp`() {
        val dir = contentPkg()

        val gate = gradle(dir, ci = false, "gate").build()
        assertEquals(TaskOutcome.SKIPPED, gate.task(":dataloaderExec")?.outcome)
        assertTrue(gate.output.contains("dataloaderExec: ZB_TOKEN not set — skipping"), gate.output)
        val written = stamp(dir).readText()
        assertTrue(written.contains("\"testDataloader\": \"passed\""), written)
        assertTrue(written.contains("\"dataloaderExec\": \"skipped\""), written)

        val refused = gradle(dir, ci = false, "gateCheck").buildAndFail()
        assertTrue(refused.output.contains("Gate stamp invalid — dataloader-load-skipped"), refused.output)

        val loadPassed = written.replace("\"dataloaderExec\": \"skipped\"", "\"dataloaderExec\": \"passed\"")
        stamp(dir).writeText(loadPassed)
        gradle(dir, ci = false, "gateCheck").build()

        val writtenBeforeTheEntry = written.replace(Regex(""",\s*"dataloaderExec"\s*:\s*"[^"]+""""), "")
        assertFalse(writtenBeforeTheEntry.contains("dataloaderExec"), writtenBeforeTheEntry)
        stamp(dir).writeText(writtenBeforeTheEntry)
        gradle(dir, ci = false, "gateCheck").build()
    }

    @Test
    fun `a CI gate without ZB_TOKEN fails the load instead of skipping it, and writes no stamp`() {
        val dir = contentPkg()

        val gate = gradle(dir, ci = true, "gate").buildAndFail()
        assertEquals(TaskOutcome.FAILED, gate.task(":dataloaderExec")?.outcome)
        assertTrue(gate.output.contains("dataloaderExec: ZB_TOKEN is not set"), gate.output)
        assertTrue(gate.output.contains("Under CI=true the dataloader check fails rather than skip the load"), gate.output)
        assertFalse(stamp(dir).exists(), "a failed gate must not write a stamp")
    }

    @Test
    fun `a package without a dataloader step gates under CI without ZB_TOKEN and records no load`() {
        val dir = pkg("base-pkg", "zb.base")

        val gate = gradle(dir, ci = true, "gate").build()
        assertEquals(null, gate.task(":dataloaderExec"))
        val written = stamp(dir).readText()
        assertFalse(written.contains("dataloaderExec"), written)
        assertTrue(written.contains("\"testDataloader\":"), written)

        gradle(dir, ci = false, "gateCheck").build()
    }
}
