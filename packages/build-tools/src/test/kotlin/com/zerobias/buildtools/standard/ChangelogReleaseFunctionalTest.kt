package com.zerobias.buildtools.standard

import com.fasterxml.jackson.databind.ObjectMapper
import com.sun.net.httpserver.HttpServer
import org.apache.commons.compress.archivers.tar.TarArchiveInputStream
import org.gradle.testkit.runner.GradleRunner
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Assumptions.assumeTrue
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import java.io.ByteArrayInputStream
import java.io.File
import java.net.InetSocketAddress
import java.net.URLDecoder
import java.util.Base64
import java.util.concurrent.ConcurrentHashMap
import java.util.zip.GZIPInputStream

/**
 * Runs the standard-mode release steps for real, through the zb.base, zb.workspace and zb.npm-only
 * plugins, on throwaway git repos: `versionStandardPackages -Ppush=false` for a multi-module repo,
 * `bumpVersion commitVersion` for a single module, `publishNpmExec` for the publish itself, and a
 * whole `publish` from a dev branch for the release event it sends. Nothing leaves the machine:
 * pushes are off, npm talks to a fake registry in this test, the `aws` CLI is a stand-in script,
 * and the builds get no AWS credentials.
 *
 * The release tests' packages list CHANGELOG.md in `files`, as a few real ones do through `*.md`,
 * so the notes are part of the gate stamp's source hash. Those tests check the release commit
 * carries the notes, and that the committed stamp still passes gateCheck afterwards.
 *
 * The fake registry (each package's `.npmrc`) reports 1.0.0 as published, so VersionBumper moves
 * to 1.0.1 and the previous release's tag is `<prefix>1.0.0`, without touching the network. It
 * also accepts a publish, keeps the tarball for the test to open, and from then on serves the
 * published version and the dist-tags that `npm dist-tag` moved.
 */
class ChangelogReleaseFunctionalTest {

    @TempDir
    lateinit var tmp: File

    private lateinit var registry: HttpServer

    private val json = ObjectMapper()

    /** The tarball of the last `npm publish` the fake registry received. */
    @Volatile
    private var publishedTarball: ByteArray? = null

    /** What the fake registry holds beyond `1.0.0` on `latest`, by package name: the versions published to it and the dist-tags set on it. */
    private val publishedVersions = ConcurrentHashMap<String, MutableSet<String>>()
    private val movedTags = ConcurrentHashMap<String, MutableMap<String, String>>()

    private fun distTags(name: String): Map<String, String> = mapOf("latest" to "1.0.0") + (movedTags[name] ?: emptyMap())

    /** A package's registry document: 1.0.0 and whatever was published since, under the current dist-tags. */
    private fun packument(name: String): String {
        val versions = listOf("1.0.0") + (publishedVersions[name] ?: emptySet())
        return json.writeValueAsString(mapOf(
            "_id" to name,
            "name" to name,
            "dist-tags" to distTags(name),
            "versions" to versions.associateWith { mapOf("name" to name, "version" to it, "dist" to mapOf("tarball" to "http://127.0.0.1/x.tgz", "shasum" to "0")) },
            "time" to mapOf("created" to "2026-01-01T00:00:00.000Z", "modified" to "2026-01-01T00:00:00.000Z") + versions.associateWith { "2026-01-01T00:00:00.000Z" },
        ))
    }

    /**
     * Serves every package as having 1.0.0 published and answers `npm whoami`. A publish (a PUT of
     * the package) adds its version and keeps its tarball, and `npm dist-tag add` and `rm` move the
     * package's dist-tags.
     */
    @BeforeEach
    fun startRegistry() {
        registry = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
        registry.createContext("/") { exchange ->
            val path = URLDecoder.decode(exchange.requestURI.rawPath.removePrefix("/"), "UTF-8")
            val method = exchange.requestMethod
            val tagRoute = Regex("^-/package/(.+)/dist-tags(?:/(.+))?$").find(path)
            val body = when {
                path == "-/whoami" -> """{"username":"zbtest"}"""
                tagRoute != null -> {
                    val (name, tag) = tagRoute.destructured
                    val tags = movedTags.getOrPut(name) { ConcurrentHashMap() }
                    if (method == "PUT") tags[tag] = json.readTree(exchange.requestBody.readBytes()).asText()
                    if (method == "DELETE") tags.remove(tag)
                    json.writeValueAsString(distTags(name))
                }
                method == "PUT" -> {
                    val publish = json.readTree(exchange.requestBody.readBytes())
                    publishedTarball = Base64.getDecoder().decode(publish["_attachments"].first()["data"].asText())
                    publish["versions"].fieldNames().forEach { publishedVersions.getOrPut(path) { ConcurrentHashMap.newKeySet() } += it }
                    publish["dist-tags"]?.fields()?.forEach { movedTags.getOrPut(path) { ConcurrentHashMap() }[it.key] = it.value.asText() }
                    """{"ok":true,"id":"$path"}"""
                }
                else -> packument(path)
            }
            val bytes = body.toByteArray()
            exchange.responseHeaders.add("Content-Type", "application/json")
            exchange.sendResponseHeaders(if (method == "PUT" && tagRoute == null) 201 else 200, bytes.size.toLong())
            exchange.responseBody.use { it.write(bytes) }
        }
        registry.start()
    }

    /** The paths inside a published npm tarball. */
    private fun tarEntries(tarball: ByteArray): List<String> {
        val names = mutableListOf<String>()
        TarArchiveInputStream(GZIPInputStream(ByteArrayInputStream(tarball))).use { tar ->
            while (true) names += (tar.nextEntry ?: break).name
        }
        return names
    }

    @AfterEach
    fun stopRegistry() = registry.stop(0)

    private val registryUrl get() = "http://127.0.0.1:${registry.address.port}/"

    /** A package directory with CHANGELOG.md in `files`, an empty tracked CHANGELOG.md and the fake registry. */
    private fun writePackage(dir: File, name: String, buildScript: String) {
        dir.mkdirs()
        File(dir, "build.gradle.kts").writeText(buildScript)
        File(dir, "package.json").writeText("""{ "name": "@zbtest/$name", "version": "1.0.0", "files": ["dist", "CHANGELOG.md"] }""" + "\n")
        File(dir, ".npmrc").writeText("registry=$registryUrl\n")
        File(dir, "src").mkdirs()
        File(dir, "src/index.ts").writeText("export const $name = 1\n")
        File(dir, "CHANGELOG.md").writeText("")
    }

    private fun git(dir: File, vararg args: String): String {
        val process = ProcessBuilder(listOf("git", "-c", "user.email=test@zerobias.com", "-c", "user.name=test") + args)
            .directory(dir).redirectErrorStream(true).start()
        val output = process.inputStream.bufferedReader().readText()
        check(process.waitFor() == 0) { "git ${args.joinToString(" ")} failed: $output" }
        return output.trim()
    }

    /** Starts a repo on `main` with its own identity: the builds under test commit through plain `git commit`. */
    private fun initRepo(dir: File) {
        git(dir, "init", "-q", "-b", "main")
        git(dir, "config", "user.email", "test@zerobias.com")
        git(dir, "config", "user.name", "test")
        git(dir, "config", "commit.gpgsign", "false")
        git(dir, "config", "tag.gpgsign", "false")
    }

    private fun commitAll(dir: File, message: String) {
        git(dir, "add", "-A")
        git(dir, "commit", "-q", "-m", message)
    }

    /**
     * The environment of the builds under test: only what java, git, node and npm need to run,
     * an empty home directory, and a few fixed settings. Nothing else of the test JVM's
     * environment gets through.
     *
     * That is deliberate. zbb's `publish` announces a release wherever its environment lets it:
     * to Slack through a webhook, to AWS, to GitHub with a token. A developer's shell holds all
     * of those, and a build under test that inherited them posted real announcements. With this
     * environment it can reach the fake registry and nothing else: no webhook, no token, no AWS
     * credentials or config, and no `~/.npmrc` pointing at a real registry.
     *
     * The global git config is empty too, so the builds' own `git commit` works from the repo's
     * identity alone, as on a runner that has none.
     */
    private fun env(): Map<String, String> {
        val kept = setOf("PATH", "USER", "LOGNAME", "SHELL", "LANG", "TZ", "TERM", "TMPDIR", "TMP", "TEMP", "JAVA_HOME")
        val empty = File(tmp, "empty-config").apply { if (!exists()) writeText("") }.absolutePath
        return System.getenv().filterKeys { it in kept || it.startsWith("LC_") } + mapOf(
            "HOME" to File(tmp, "home").apply { mkdirs() }.absolutePath,
            "GIT_CONFIG_GLOBAL" to empty,
            "GIT_CONFIG_NOSYSTEM" to "1",
            "NPM_TOKEN" to "test-token",
            "AWS_CONFIG_FILE" to empty,
            "AWS_SHARED_CREDENTIALS_FILE" to empty,
            "AWS_EC2_METADATA_DISABLED" to "true",
        )
    }

    private fun gradle(dir: File, vararg args: String, extraEnv: Map<String, String> = emptyMap()): GradleRunner =
        GradleRunner.create()
            .withProjectDir(dir)
            .withPluginClasspath()
            .withEnvironment(env() + extraEnv)
            .withArguments(*args, "--stacktrace")

    /**
     * Puts a stand-in for the `aws` CLI first on the build's PATH and sets a region, which is what
     * makes zbb send release events. The stand-in answers `--version`, appends every other call's
     * arguments to the returned file, one per line, and exits with [exitCode].
     */
    private fun fakeAws(exitCode: Int): Pair<Map<String, String>, File> {
        val calls = File(tmp, "aws-calls.txt")
        val bin = File(tmp, "fakebin").apply { mkdirs() }
        File(bin, "aws").apply {
            writeText("#!/bin/sh\nif [ \"\$1\" = \"--version\" ]; then echo aws-cli/fake; exit 0; fi\nprintf '%s\\n' \"\$@\" >> '${calls.absolutePath}'\nexit $exitCode\n")
            setExecutable(true)
        }
        return mapOf("PATH" to bin.absolutePath + File.pathSeparator + System.getenv("PATH"), "AWS_REGION" to "us-east-1") to calls
    }

    private fun sourceHash(packageDir: File): String =
        Regex(""""sourceHash"\s*:\s*"([^"]+)"""").find(File(packageDir, "gate-stamp.json").readText())!!.groupValues[1]

    private fun npmAvailable(): Boolean = try {
        ProcessBuilder("npm", "--version").redirectErrorStream(true).start().waitFor() == 0
    } catch (_: Exception) {
        false
    }

    /**
     * A multi-module repo: the release commit names every bumped module, widget's CHANGELOG.md
     * lists its feature (and not the stamp commit), gadget gets no notes, and both stamps still
     * pass gateCheck, widget's because its sourceHash moved with the notes. `plain`, a directory
     * that is no Gradle project, is still bumped and simply gets no notes.
     */
    @Test
    fun `versionStandardPackages writes the notes into the release commit and keeps the stamps valid`() {
        assumeTrue(npmAvailable(), "npm is needed for VersionBumper's registry check")
        val root = File(tmp, "modules").apply { mkdirs() }
        File(root, "settings.gradle.kts").writeText(
            "rootProject.name = \"modules\"\n" +
                "include(\":widget\", \":gadget\")\n" +
                "project(\":widget\").projectDir = file(\"package/acme/widget\")\n" +
                "project(\":gadget\").projectDir = file(\"package/acme/gadget\")\n",
        )
        File(root, "build.gradle.kts").writeText("plugins { id(\"zb.workspace\") }\n")
        File(root, ".gitignore").writeText(".gradle/\nbuild/\n.zbb-gradle/\n")
        val widget = File(root, "package/acme/widget")
        val gadget = File(root, "package/acme/gadget")
        writePackage(widget, "widget", "plugins { id(\"zb.base\") }\n")
        writePackage(gadget, "gadget", "plugins { id(\"zb.base\") }\n")
        val plain = File(root, "package/acme/plain").apply { mkdirs() }
        File(plain, "package.json").writeText("""{ "name": "@zbtest/plain", "version": "1.0.0" }""" + "\n")
        File(plain, ".npmrc").writeText("registry=$registryUrl\n")
        initRepo(root)
        commitAll(root, "chore: initial")
        git(root, "tag", "-a", "acme-widget-v1.0.0", "-m", "Release acme-widget v1.0.0")
        git(root, "tag", "-a", "acme-gadget-v1.0.0", "-m", "Release acme-gadget v1.0.0")

        File(widget, "src/search.ts").writeText("export const search = 1\n")
        commitAll(root, "feat(widget): add search (#10)")
        gradle(root, ":widget:gate", ":gadget:gate").build()
        commitAll(root, "chore: update gate-stamp.json")
        val widgetHashBefore = sourceHash(widget)
        val gadgetHashBefore = sourceHash(gadget)

        val result = gradle(root, "versionStandardPackages", "-PmodulesToVersion=acme/widget,acme/gadget,acme/plain", "-Ppush=false").build()

        assertEquals(
            "chore(release): @zbtest/widget@1.0.1, @zbtest/gadget@1.0.1, @zbtest/plain@1.0.1",
            git(root, "log", "-1", "--format=%s"), result.output,
        )
        assertTrue(result.output.contains("package/acme/plain: no zb.base project for this directory"), result.output)
        assertTrue(result.output.contains("package/acme/widget: gate stamp's sourceHash updated for CHANGELOG.md"), result.output)
        assertTrue(sourceHash(widget) != widgetHashBefore, "widget's stamp kept the hash from before its notes")
        assertEquals(gadgetHashBefore, sourceHash(gadget))
        val committed = git(root, "show", "--name-only", "--format=", "HEAD").lines().toSet()
        assertTrue("package/acme/widget/CHANGELOG.md" in committed, committed.toString())
        assertTrue("package/acme/widget/gate-stamp.json" in committed, committed.toString())
        assertFalse("package/acme/gadget/CHANGELOG.md" in committed, committed.toString())
        val notes = File(widget, "CHANGELOG.md").readText()
        assertTrue(notes.contains("## [1.0.1]"), notes)
        assertTrue(notes.contains("### Features\n\n* **widget:** add search (#10)"), notes)
        assertFalse(notes.contains("gate-stamp"), notes)
        assertEquals("", git(root, "status", "--porcelain"), "the release commit left changes behind")

        gradle(root, ":widget:gateCheck", ":gadget:gateCheck").build()
    }

    /**
     * A module whose gate stamp isn't current (source changed after its gate) gets no notes: its
     * stamp covers CHANGELOG.md, and writing notes must not make a stamp any staler than it is.
     * The module is still bumped.
     */
    @Test
    fun `versionStandardPackages leaves the changelog alone when the stamp is not current`() {
        assumeTrue(npmAvailable(), "npm is needed for VersionBumper's registry check")
        val root = File(tmp, "stale").apply { mkdirs() }
        File(root, "settings.gradle.kts").writeText(
            "rootProject.name = \"stale\"\ninclude(\":widget\")\nproject(\":widget\").projectDir = file(\"package/acme/widget\")\n",
        )
        File(root, "build.gradle.kts").writeText("plugins { id(\"zb.workspace\") }\n")
        File(root, ".gitignore").writeText(".gradle/\nbuild/\n.zbb-gradle/\n")
        val widget = File(root, "package/acme/widget")
        writePackage(widget, "widget", "plugins { id(\"zb.base\") }\n")
        initRepo(root)
        commitAll(root, "chore: initial")
        git(root, "tag", "-a", "acme-widget-v1.0.0", "-m", "Release acme-widget v1.0.0")
        gradle(root, ":widget:gate").build()
        commitAll(root, "chore: update gate-stamp.json")
        File(widget, "src/search.ts").writeText("export const search = 1\n")
        commitAll(root, "feat(widget): add search without gating it (#10)")
        val hashBefore = sourceHash(widget)

        val result = gradle(root, "versionStandardPackages", "-PmodulesToVersion=acme/widget", "-Ppush=false").build()

        assertEquals("chore(release): @zbtest/widget v1.0.1", git(root, "log", "-1", "--format=%s"), result.output)
        assertTrue(result.output.contains("package/acme/widget: its gate stamp isn't current"), result.output)
        assertEquals("", File(widget, "CHANGELOG.md").readText())
        assertEquals(hashBefore, sourceHash(widget))
        assertEquals(
            setOf("package/acme/widget/gate-stamp.json", "package/acme/widget/package.json"),
            git(root, "show", "--name-only", "--format=", "HEAD").lines().toSet(),
        )
        assertEquals("", git(root, "status", "--porcelain"), "the release commit left changes behind")
    }

    /**
     * A single module: `bumpVersion commitVersion` commits the version, the refreshed stamp and the
     * notes together under `chore(release): <vendor>-<product> v<version>`, and the stamp still
     * passes gateCheck.
     */
    @Test
    fun `commitVersion writes the notes into the release commit and keeps the stamp valid`() {
        assumeTrue(npmAvailable(), "npm is needed for VersionBumper's registry check")
        val dir = singleModule()
        val hashBefore = sourceHash(dir)

        val result = gradle(dir, "bumpVersion", "commitVersion").build()

        assertEquals("chore(release): acme-single v1.0.1", git(dir, "log", "-1", "--format=%s"), result.output)
        assertTrue(sourceHash(dir) != hashBefore, "the stamp's hash doesn't cover the notes")
        val committed = git(dir, "show", "--name-only", "--format=", "HEAD").lines().toSet()
        assertEquals(setOf("CHANGELOG.md", "gate-stamp.json", "package.json"), committed)
        val notes = File(dir, "CHANGELOG.md").readText()
        assertTrue(notes.contains("## [1.0.1]"), notes)
        assertTrue(notes.contains("### Bug Fixes\n\n* handle empty input"), notes)
        assertEquals("", git(dir, "status", "--porcelain"), "the release commit left changes behind")

        gradle(dir, "gateCheck").build()
    }

    /** `-Pzb.changelog=false` releases as before the notes existed: the commit holds the version and the stamp only. */
    @Test
    fun `commitVersion writes no notes when they are turned off`() {
        assumeTrue(npmAvailable(), "npm is needed for VersionBumper's registry check")
        val dir = singleModule()

        gradle(dir, "bumpVersion", "commitVersion", "-Pzb.changelog=false").build()

        assertEquals("chore(release): acme-single v1.0.1", git(dir, "log", "-1", "--format=%s"))
        assertEquals(setOf("gate-stamp.json", "package.json"), git(dir, "show", "--name-only", "--format=", "HEAD").lines().toSet())
        assertEquals("", File(dir, "CHANGELOG.md").readText())
        gradle(dir, "gateCheck").build()
    }

    /**
     * The publish itself, through zb.npm-only: `files` doesn't list the changelog, yet the tarball
     * the registry receives contains CHANGELOG.md, and package.json is back to its committed text
     * once the build ends.
     */
    @Test
    fun `publishNpmExec ships the changelog and leaves package json as committed`() {
        assumeTrue(npmAvailable(), "npm is needed to publish")
        val dir = File(tmp, "acme/pack").apply { mkdirs() }
        File(dir, "settings.gradle.kts").writeText("rootProject.name = \"pack\"\n")
        File(dir, "build.gradle.kts").writeText("plugins { id(\"zb.npm-only\") }\nextra[\"npmOnlyValidator\"] = { _: org.gradle.api.Project -> }\n")
        File(dir, "package.json").writeText("""{ "name": "@zbtest/pack", "version": "1.0.1", "files": ["tsconfig.json"] }""" + "\n")
        File(dir, "tsconfig.json").writeText("{}\n")
        File(dir, "CHANGELOG.md").writeText("# Changelog\n\n## [1.0.1] (2026-11-26)\n\n### Features\n\n* a pack\n")
        File(dir, ".npmrc").writeText("registry=$registryUrl\n//127.0.0.1:${registry.address.port}/:_authToken=test-token\n")
        File(dir, ".gitignore").writeText(".gradle/\nbuild/\n.zbb-gradle/\n")
        initRepo(dir)
        commitAll(dir, "feat: a pack")
        val committed = File(dir, "package.json").readText()

        val result = gradle(dir, "publishNpmExec").build()

        val tarball = publishedTarball
        assertTrue(tarball != null, "nothing was published:\n${result.output}")
        val entries = tarEntries(tarball!!)
        assertTrue("package/CHANGELOG.md" in entries, entries.toString())
        assertTrue("package/tsconfig.json" in entries, entries.toString())
        assertEquals(committed, File(dir, "package.json").readText())
    }

    /** An npm-only package at `acme/pack`, version 1.0.1 in package.json, committed on a `dev` branch. */
    private fun packOnDev(): File {
        val dir = File(tmp, "acme/pack").apply { mkdirs() }
        File(dir, "settings.gradle.kts").writeText("rootProject.name = \"pack\"\n")
        File(dir, "build.gradle.kts").writeText("plugins { id(\"zb.npm-only\") }\nextra[\"npmOnlyValidator\"] = { _: org.gradle.api.Project -> }\n")
        File(dir, "package.json").writeText("""{ "name": "@zbtest/pack", "version": "1.0.1", "files": ["tsconfig.json"] }""" + "\n")
        File(dir, "tsconfig.json").writeText("{}\n")
        File(dir, ".npmrc").writeText("registry=$registryUrl\n//127.0.0.1:${registry.address.port}/:_authToken=test-token\n")
        File(dir, ".gitignore").writeText(".gradle/\nbuild/\n.zbb-gradle/\n")
        initRepo(dir)
        git(dir, "checkout", "-q", "-b", "dev")
        commitAll(dir, "feat: a pack")
        return dir
    }

    /**
     * Runs `publish` in [dir] as CI's publish job does, and returns the build output and the one
     * record of the packages file it wrote. It also checks the build found no Slack webhook.
     */
    private fun publishFromBranch(dir: File, awsEnv: Map<String, String>): Pair<String, com.fasterxml.jackson.databind.JsonNode> {
        val packagesFile = File(tmp, "published-packages.json")
        val result = gradle(dir, "publish", "-PversionAlreadyCommitted=true", "-Pzb.publishedPackagesFile=${packagesFile.absolutePath}", extraEnv = awsEnv).build()
        assertTrue("SLACK_RELEASES_WEBHOOK not set" in result.output && "Slack notification sent" !in result.output, "the build could reach Slack:\n${result.output}")
        assertTrue(packagesFile.isFile, "no packages file was written:\n${result.output}")
        return result.output to json.readTree(packagesFile).single()
    }

    /**
     * A whole `publish` from a dev branch. package.json keeps saying 1.0.1 while `1.0.1-dev.0` is
     * what goes to npm, and the release event zbb sends carries that published version and the
     * dist-tags that name it. The packages file then marks the package, which is how the
     * workflow's announcement step knows not to send a second event.
     */
    @Test
    fun `a branch publish marks the package whose release event it sent`() {
        assumeTrue(npmAvailable(), "npm is needed to publish")
        val dir = packOnDev()
        val (awsEnv, awsCalls) = fakeAws(exitCode = 0)

        val (output, record) = publishFromBranch(dir, awsEnv)

        val call = if (awsCalls.isFile) awsCalls.readLines() else emptyList()
        assertEquals(listOf("lambda", "invoke"), call.take(2), "no release event was sent:\n$output")
        val event = json.readTree(call[call.indexOf("--payload") + 1])["body"]
        assertEquals("@zbtest/pack", event["name"].asText())
        assertEquals("1.0.1-dev.0", event["version"].asText())
        assertEquals("1.0.1-dev.0", event["distTags"]["dev"]?.asText(), "$event\n$output")

        assertEquals("@zbtest/pack", record["name"].asText())
        assertEquals("1.0.1-dev.0", record["version"].asText())
        assertEquals(dir.canonicalFile, File(record["location"].asText()).canonicalFile)
        assertTrue(record["releaseEventSent"]?.asBoolean() == true, "$record\n$output")
        assertTrue("\"version\": \"1.0.1\"" in File(dir, "package.json").readText())
    }

    /** When the event can't be sent, the package stays unmarked, so the workflow's step still announces it. */
    @Test
    fun `a branch publish leaves the package unmarked when its release event was not sent`() {
        assumeTrue(npmAvailable(), "npm is needed to publish")
        val dir = packOnDev()
        val (awsEnv, awsCalls) = fakeAws(exitCode = 1)

        val (output, record) = publishFromBranch(dir, awsEnv)

        assertTrue(awsCalls.isFile && "invoke" in awsCalls.readLines(), "the send was never tried:\n$output")
        assertEquals("1.0.1-dev.0", record["version"].asText())
        assertFalse(record.has("releaseEventSent"), record.toString())
    }

    /** A single-module repo at `acme/single`, released as 1.0.0, with one fix since and a current, committed gate stamp. */
    private fun singleModule(): File {
        val dir = File(tmp, "acme/single")
        writePackage(dir, "single", "plugins { id(\"zb.base\") }\n")
        File(dir, "settings.gradle.kts").writeText("rootProject.name = \"single\"\n")
        File(dir, ".gitignore").writeText(".gradle/\nbuild/\n.zbb-gradle/\n")
        initRepo(dir)
        commitAll(dir, "chore: initial")
        git(dir, "tag", "-a", "acme-single-v1.0.0", "-m", "Release acme-single v1.0.0")

        File(dir, "src/index.ts").writeText("export const single = 2\n")
        commitAll(dir, "fix: handle empty input")
        gradle(dir, "gate").build()
        commitAll(dir, "chore: update gate-stamp.json")
        return dir
    }
}
