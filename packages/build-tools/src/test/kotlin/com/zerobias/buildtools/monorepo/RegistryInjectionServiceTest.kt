package com.zerobias.buildtools.monorepo

import org.gradle.testfixtures.ProjectBuilder
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.io.TempDir
import java.io.File
import java.nio.file.Path

/**
 * Tests for RegistryInjectionService trigger detection, apply/restore, the
 * needsApply short-circuit, and the forcePublic gate-side override.
 *
 * The service reads from $HOME/.zbb/slots/<slot>/stacks/registry/{state.yaml,
 * .env, publishes.json}, so trigger-positive paths are exercised via a
 * TestRegistryInjectionService subclass that bypasses env-var lookup with a
 * synthetic trigger.
 */
class RegistryInjectionServiceTest {

    /**
     * Build a real BuildService instance via Gradle's ProjectBuilder.
     */
    private fun newService(repoRoot: File): RegistryInjectionService {
        val project = ProjectBuilder.builder().withProjectDir(repoRoot).build()
        val provider = project.gradle.sharedServices.registerIfAbsent(
            "registryInjection-test-${System.nanoTime()}",
            RegistryInjectionService::class.java,
        ) {
            parameters.repoRoot.set(project.layout.projectDirectory)
        }
        return provider.get()
    }

    /**
     * Build a TestRegistryInjectionService with a hand-rolled trigger,
     * bypassing env-var detection.
     */
    private fun newServiceWithTrigger(
        repoRoot: File,
        slot: String = "test-slot",
        registryUrl: String = "http://localhost:15016",
        publishes: List<RegistryInjectionService.PublishedPackage>,
    ): RegistryInjectionService {
        val project = ProjectBuilder.builder().withProjectDir(repoRoot).build()
        val provider = project.gradle.sharedServices.registerIfAbsent(
            "registryInjection-test-${System.nanoTime()}",
            TestRegistryInjectionService::class.java,
        ) {
            parameters.repoRoot.set(project.layout.projectDirectory)
        }
        val service = provider.get()
        service.fakeTrigger = RegistryInjectionService.TriggerInfo(slot, registryUrl, publishes)
        return service
    }

    /**
     * Test double that returns a settable [fakeTrigger] from
     * [detectTrigger], bypassing env-var lookup.
     */
    abstract class TestRegistryInjectionService : RegistryInjectionService() {
        @Volatile
        var fakeTrigger: RegistryInjectionService.TriggerInfo? = null
        override fun detectTrigger(): RegistryInjectionService.TriggerInfo? = fakeTrigger
    }

    @Test
    fun `isActive returns false when ZB_SLOT is unset`(@TempDir tmp: Path) {
        val previous = System.getenv("ZB_SLOT")
        if (previous != null) return  // skip — can't reliably test in this env

        val service = newService(tmp.toFile())
        assertFalse(service.isActive, "isActive should be false without ZB_SLOT")
        assertNull(service.trigger)
        assertEquals(emptyMap<String, String>(), service.npmEnvOverrides())
    }

    @Test
    fun `apply with no trigger is a no-op`(@TempDir tmp: Path) {
        val previous = System.getenv("ZB_SLOT")
        if (previous != null) return

        val repoRoot = tmp.toFile()
        // Create a fake lockfile + node_modules so we can verify they're untouched.
        val lockfile = File(repoRoot, "package-lock.json")
        lockfile.writeText("""{"lockfileVersion": 3}""")
        File(repoRoot, "node_modules").mkdirs()

        val service = newService(repoRoot)
        val overrides = service.apply()
        assertEquals(emptyMap<String, String>(), overrides)

        // Lockfile MUST NOT be touched — local dev's lockfile carries
        // localhost URLs as legitimate working state.
        assertTrue(lockfile.exists())
        assertEquals("""{"lockfileVersion": 3}""", lockfile.readText())
        // No tarballs dir.
        assertFalse(File(repoRoot, ".zbb-local-deps").exists())
    }

    @Test
    fun `restore with no prior apply is a no-op`(@TempDir tmp: Path) {
        val previous = System.getenv("ZB_SLOT")
        if (previous != null) return

        val service = newService(tmp.toFile())
        service.restore()  // should not throw
    }

    @Test
    fun `npmEnvOverrides empty without trigger`(@TempDir tmp: Path) {
        val previous = System.getenv("ZB_SLOT")
        if (previous != null) return
        val service = newService(tmp.toFile())
        assertEquals(emptyMap<String, String>(), service.npmEnvOverrides())
    }

    // ── needsApply ────────────────────────────────────────────────

    @Test
    fun `needsApply returns false without trigger`(@TempDir tmp: Path) {
        val previous = System.getenv("ZB_SLOT")
        if (previous != null) return
        val service = newService(tmp.toFile())
        assertFalse(service.needsApply(tmp.toFile()))
    }

    @Test
    fun `needsApply returns false when every published package is fully installed`(
        @TempDir tmp: Path,
    ) {
        val previous = System.getenv("ZB_SLOT")
        if (previous != null) return

        val repoRoot = tmp.toFile()
        val pkg = RegistryInjectionService.PublishedPackage("@zerobias-org/foo", "1.2.3")

        // Lockfile entry resolved through localhost — passes checks 3-5.
        File(repoRoot, "package-lock.json").writeText(
            """
            {
              "lockfileVersion": 3,
              "packages": {
                "node_modules/@zerobias-org/foo": {
                  "version": "1.2.3",
                  "resolved": "http://localhost:15016/@zerobias-org/foo/-/foo-1.2.3.tgz"
                }
              }
            }
            """.trimIndent()
        )
        // node_modules entry with matching version — passes checks 1-2.
        val installed = File(repoRoot, "node_modules/@zerobias-org/foo")
        installed.mkdirs()
        File(installed, "package.json").writeText("""{"name":"@zerobias-org/foo","version":"1.2.3"}""")

        val service = newServiceWithTrigger(repoRoot, publishes = listOf(pkg))
        assertFalse(service.needsApply(repoRoot), "all 5 checks pass → no apply needed")
    }

    @Test
    fun `needsApply returns true when node_modules entry is missing`(@TempDir tmp: Path) {
        val previous = System.getenv("ZB_SLOT")
        if (previous != null) return

        val repoRoot = tmp.toFile()
        val pkg = RegistryInjectionService.PublishedPackage("@zerobias-org/foo", "1.2.3")
        File(repoRoot, "package-lock.json").writeText(
            """
            {
              "lockfileVersion": 3,
              "packages": {
                "node_modules/@zerobias-org/foo": {
                  "version": "1.2.3",
                  "resolved": "http://localhost:15016/@zerobias-org/foo/-/foo-1.2.3.tgz"
                }
              }
            }
            """.trimIndent()
        )
        // node_modules absent — check 1 fails.

        val service = newServiceWithTrigger(repoRoot, publishes = listOf(pkg))
        assertTrue(service.needsApply(repoRoot))
    }

    @Test
    fun `needsApply returns true when installed version mismatches`(@TempDir tmp: Path) {
        val previous = System.getenv("ZB_SLOT")
        if (previous != null) return

        val repoRoot = tmp.toFile()
        val pkg = RegistryInjectionService.PublishedPackage("@zerobias-org/foo", "1.2.3")
        File(repoRoot, "package-lock.json").writeText(
            """
            {
              "lockfileVersion": 3,
              "packages": {
                "node_modules/@zerobias-org/foo": {
                  "version": "1.2.3",
                  "resolved": "http://localhost:15016/@zerobias-org/foo/-/foo-1.2.3.tgz"
                }
              }
            }
            """.trimIndent()
        )
        val installed = File(repoRoot, "node_modules/@zerobias-org/foo")
        installed.mkdirs()
        // Wrong version on disk — check 2 fails.
        File(installed, "package.json").writeText("""{"name":"@zerobias-org/foo","version":"1.0.0"}""")

        val service = newServiceWithTrigger(repoRoot, publishes = listOf(pkg))
        assertTrue(service.needsApply(repoRoot))
    }

    @Test
    fun `needsApply returns true when lockfile resolves via GHCR`(@TempDir tmp: Path) {
        val previous = System.getenv("ZB_SLOT")
        if (previous != null) return

        val repoRoot = tmp.toFile()
        val pkg = RegistryInjectionService.PublishedPackage("@zerobias-org/foo", "1.2.3")
        // Public-registry-resolved URL — check 5 fails (no "localhost" substring).
        File(repoRoot, "package-lock.json").writeText(
            """
            {
              "lockfileVersion": 3,
              "packages": {
                "node_modules/@zerobias-org/foo": {
                  "version": "1.2.3",
                  "resolved": "https://npm.pkg.github.com/download/@zerobias-org/foo/1.2.3/abc"
                }
              }
            }
            """.trimIndent()
        )
        val installed = File(repoRoot, "node_modules/@zerobias-org/foo")
        installed.mkdirs()
        File(installed, "package.json").writeText("""{"name":"@zerobias-org/foo","version":"1.2.3"}""")

        val service = newServiceWithTrigger(repoRoot, publishes = listOf(pkg))
        assertTrue(service.needsApply(repoRoot))
    }

    @Test
    fun `needsApply skips packages that are not in the lockfile at all`(@TempDir tmp: Path) {
        val previous = System.getenv("ZB_SLOT")
        if (previous != null) return

        val repoRoot = tmp.toFile()
        val pkg = RegistryInjectionService.PublishedPackage("@zerobias-org/unused", "1.0.0")
        // Package isn't a dep of this workspace — should be skipped silently.
        File(repoRoot, "package-lock.json").writeText("""{"lockfileVersion": 3, "packages": {}}""")

        val service = newServiceWithTrigger(repoRoot, publishes = listOf(pkg))
        assertFalse(service.needsApply(repoRoot))
    }

    // ── forcePublic ──────────────────────────────────────────────

    @Test
    fun `forcePublic suppresses apply even with active trigger`(@TempDir tmp: Path) {
        val previous = System.getenv("ZB_SLOT")
        if (previous != null) return

        val repoRoot = tmp.toFile()
        val pkg = RegistryInjectionService.PublishedPackage("@zerobias-org/foo", "1.2.3")
        File(repoRoot, "package-lock.json").writeText("""{"lockfileVersion": 3, "packages": {}}""")

        val service = newServiceWithTrigger(repoRoot, publishes = listOf(pkg))
        service.forcePublic = true

        val overrides = service.apply()
        // forcePublic short-circuits — no env vars, no taint, no tarballs.
        assertEquals(emptyMap<String, String>(), overrides)
        assertFalse(File(repoRoot, ".zbb-local-deps").exists())
    }
}
