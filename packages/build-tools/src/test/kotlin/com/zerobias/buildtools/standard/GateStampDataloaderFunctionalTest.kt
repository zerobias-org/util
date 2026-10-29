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
 * unaffected by either; and a gate whose load doesn't run keeps a passing load recorded for the
 * same source. The builds get no ZB_TOKEN and point DATALOADER_SERVICE_URL at a closed local port,
 * so nothing can reach the dataloader-service.
 */
class GateStampDataloaderFunctionalTest {

    @TempDir
    lateinit var tmp: File

    /**
     * A committed one-project git repo applying [plugin], since zb.base reads the branch and hashes
     * git-tracked files. [packageJsonExtra] and [files] give it a source the hash can see.
     */
    private fun pkg(
        name: String,
        plugin: String,
        buildScriptExtra: String = "",
        packageJsonExtra: String = "",
        files: Map<String, String> = emptyMap(),
    ): File {
        val dir = File(tmp, name).apply { mkdirs() }
        File(dir, "settings.gradle.kts").writeText("rootProject.name = \"$name\"\n")
        File(dir, "build.gradle.kts").writeText("plugins { id(\"$plugin\") }\n$buildScriptExtra")
        File(dir, "package.json").writeText("""{ "name": "@zbtest/$name", "version": "1.0.0"$packageJsonExtra }""" + "\n")
        File(dir, ".gitignore").writeText(".gradle/\nbuild/\n.zbb-gradle/\n")
        files.forEach { (path, text) -> File(dir, path).apply { parentFile.mkdirs() }.writeText(text) }
        git(dir, "init", "-q", "-b", "main")
        commitAll(dir)
        return dir
    }

    private fun contentPkg(): File = pkg(
        "content-pkg", "zb.content",
        buildScriptExtra = "extra[\"contentValidator\"] = { _: org.gradle.api.Project -> }\n",
        packageJsonExtra = """, "files": ["index.yml"]""",
        files = mapOf("index.yml" to "name: content-pkg\n"),
    )

    private fun commitAll(dir: File) {
        git(dir, "add", "-A")
        git(dir, "-c", "user.email=test@zerobias.com", "-c", "user.name=test", "commit", "-q", "-m", "commit")
    }

    private fun git(dir: File, vararg args: String) {
        val process = ProcessBuilder(listOf("git") + args).directory(dir).redirectErrorStream(true).start()
        val output = process.inputStream.bufferedReader().readText()
        check(process.waitFor() == 0) { "git ${args.joinToString(" ")} failed: $output" }
    }

    /** The test JVM's environment without ZB_TOKEN or any dataloader/CI setting, plus CI=true when [ci] and [extra]. */
    private fun env(ci: Boolean, extra: Map<String, String>): Map<String, String> =
        System.getenv()
            .filterKeys { it !in setOf("ZB_TOKEN", "CI", "ZBB_MONOREPO_EVENT_FILE") && !it.startsWith("DATALOADER_") }
            .plus("DATALOADER_SERVICE_URL" to "http://127.0.0.1:9")
            .plus(if (ci) mapOf("CI" to "true") else emptyMap())
            .plus(extra)

    private fun gradle(dir: File, ci: Boolean, vararg args: String, extraEnv: Map<String, String> = emptyMap()): GradleRunner =
        GradleRunner.create()
            .withProjectDir(dir)
            .withPluginClasspath()
            .withEnvironment(env(ci, extraEnv))
            .withArguments(*args, "--stacktrace")

    private fun stamp(dir: File): File = File(dir, "gate-stamp.json")

    /** Records the stamp's load as passed, as a gate with ZB_TOKEN writes it; no build here can run a real load. */
    private fun passLoad(dir: File) {
        val text = stamp(dir).readText()
        check(text.contains("\"dataloaderExec\": \"skipped\"")) { text }
        stamp(dir).writeText(text.replace("\"dataloaderExec\": \"skipped\"", "\"dataloaderExec\": \"passed\""))
    }

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

    /** Re-running gate without ZB_TOKEN, or with `-x dataloaderExec`, keeps the load until the source changes. */
    @Test
    fun `a re-run gate whose load does not run keeps the passing load until the source changes`() {
        val dir = contentPkg()
        gradle(dir, ci = false, "gate").build()
        passLoad(dir)

        val rerun = gradle(dir, ci = false, "gate").build()
        assertEquals(TaskOutcome.SKIPPED, rerun.task(":dataloaderExec")?.outcome)
        assertTrue(rerun.output.contains("keeping the passing load the previous stamp recorded"), rerun.output)
        assertTrue(stamp(dir).readText().contains("\"dataloaderExec\": \"passed\""), stamp(dir).readText())

        val excluded = gradle(dir, ci = false, "gate", "-x", "dataloaderExec").build()
        assertEquals(null, excluded.task(":dataloaderExec"))
        assertTrue(stamp(dir).readText().contains("\"dataloaderExec\": \"passed\""), stamp(dir).readText())
        gradle(dir, ci = false, "gateCheck").build()

        File(dir, "index.yml").appendText("description: changed\n")
        gradle(dir, ci = false, "gate", "-x", "dataloaderExec").build()
        assertTrue(stamp(dir).readText().contains("\"dataloaderExec\": \"unknown\""), stamp(dir).readText())
        gradle(dir, ci = false, "gate").build()
        assertTrue(stamp(dir).readText().contains("\"dataloaderExec\": \"skipped\""), stamp(dir).readText())
        val refused = gradle(dir, ci = false, "gateCheck").buildAndFail()
        assertTrue(refused.output.contains("Gate stamp invalid — dataloader-load-skipped"), refused.output)
    }

    /** A local publish whose stamp is TESTS_CHANGED re-runs the gate's tests; without ZB_TOKEN the load keeps its result. */
    @Test
    fun `a TESTS_CHANGED publish whose load does not run keeps the passing load`() {
        val dir = contentPkg()
        gradle(dir, ci = false, "gate").build()
        passLoad(dir)
        File(dir, "test").mkdirs()
        File(dir, "test/fixture.txt").writeText("tests only\n")
        commitAll(dir)

        val publish = gradle(dir, ci = false, "publish", "-PdryRun=true").build()
        assertTrue(publish.output.contains("Gate stamp: test-hash-changed — rerunning tests"), publish.output)
        assertEquals(TaskOutcome.SKIPPED, publish.task(":dataloaderExec")?.outcome)
        assertEquals(TaskOutcome.SUCCESS, publish.task(":writeGateStamp")?.outcome)
        assertTrue(stamp(dir).readText().contains("\"dataloaderExec\": \"passed\""), stamp(dir).readText())

        gradle(dir, ci = false, "gateCheck").build()
    }

    /** A kept load keeps the DATALOADER_ENV it was checked against, not the one this gate asked for. */
    @Test
    fun `a kept load keeps its own dataloaderEnv`() {
        val dir = contentPkg()
        gradle(dir, ci = false, "gate").build()
        passLoad(dir)
        val prodChecked = stamp(dir).readText()
        stamp(dir).writeText(prodChecked.replace("\"tasks\": {", "\"dataloaderEnv\": \"dev\",\n  \"tasks\": {"))

        gradle(dir, ci = false, "gate").build()
        val devKept = stamp(dir).readText()
        assertTrue(devKept.contains("\"dataloaderExec\": \"passed\""), devKept)
        assertTrue(devKept.contains("\"dataloaderEnv\": \"dev\""), devKept)
        val refusedOnMain = gradle(dir, ci = false, "gateCheck").buildAndFail()
        assertTrue(refusedOnMain.output.contains("dataloader-env-dev-not-accepted-on-latest"), refusedOnMain.output)

        stamp(dir).writeText(prodChecked)
        gradle(dir, ci = false, "gate", extraEnv = mapOf("DATALOADER_ENV" to "dev")).build()
        val prodKept = stamp(dir).readText()
        assertTrue(prodKept.contains("\"dataloaderExec\": \"passed\""), prodKept)
        assertFalse(prodKept.contains("dataloaderEnv"), prodKept)
    }
}
