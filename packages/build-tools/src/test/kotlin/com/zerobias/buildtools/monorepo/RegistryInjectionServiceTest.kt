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
import java.time.Instant

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

    /**
     * Write a minimal root `package.json` declaring [name] as a dependency
     * with constraint [constraint]. Required so [RegistryInjectionService.applicablePublishes]
     * doesn't filter the package out before [RegistryInjectionService.needsApply] runs.
     */
    private fun writeRootPackageJson(repoRoot: File, name: String, constraint: String = "*") {
        File(repoRoot, "package.json").writeText(
            """{"name":"test","dependencies":{"$name":"$constraint"}}"""
        )
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
        writeRootPackageJson(repoRoot, pkg.name)

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
        writeRootPackageJson(repoRoot, pkg.name)
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
        writeRootPackageJson(repoRoot, pkg.name)
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
        writeRootPackageJson(repoRoot, pkg.name)
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
    fun `needsApply returns true when same-version republish is newer than installed`(
        @TempDir tmp: Path,
    ) {
        val previous = System.getenv("ZB_SLOT")
        if (previous != null) return

        val repoRoot = tmp.toFile()
        // publishedAt is in the future relative to the file mtime that
        // gets stamped when we write the package.json below.
        val publishedAt = Instant.now().plusSeconds(3600)
        val pkg = RegistryInjectionService.PublishedPackage(
            "@zerobias-org/foo",
            "1.2.3",
            publishedAt,
        )
        writeRootPackageJson(repoRoot, pkg.name)

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
        // Same version on disk — checks 1-5 pass — but the file mtime is
        // older than publishedAt, so check 6 forces a refetch.
        File(installed, "package.json").writeText("""{"name":"@zerobias-org/foo","version":"1.2.3"}""")

        val service = newServiceWithTrigger(repoRoot, publishes = listOf(pkg))
        assertTrue(
            service.needsApply(repoRoot),
            "publishedAt newer than installed mtime → refetch required",
        )
    }

    @Test
    fun `needsApply returns false when publishedAt predates the install`(
        @TempDir tmp: Path,
    ) {
        val previous = System.getenv("ZB_SLOT")
        if (previous != null) return

        val repoRoot = tmp.toFile()
        // publishedAt in the past — install is fresh enough.
        val publishedAt = Instant.now().minusSeconds(3600)
        val pkg = RegistryInjectionService.PublishedPackage(
            "@zerobias-org/foo",
            "1.2.3",
            publishedAt,
        )
        writeRootPackageJson(repoRoot, pkg.name)

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
        File(installed, "package.json").writeText("""{"name":"@zerobias-org/foo","version":"1.2.3"}""")

        val service = newServiceWithTrigger(repoRoot, publishes = listOf(pkg))
        assertFalse(
            service.needsApply(repoRoot),
            "publishedAt older than install → no refetch",
        )
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

    // ── Stale-localhost cleanup ────────────────────────────────────

    @Test
    fun `findStaleLocalhostEntries detects localhost entries not in publishes`(@TempDir tmp: Path) {
        val previous = System.getenv("ZB_SLOT")
        if (previous != null) return

        val repoRoot = tmp.toFile()
        // Lockfile with a localhost-resolved entry (simulates post-clear state)
        File(repoRoot, "package-lock.json").writeText("""
        {
            "lockfileVersion": 3,
            "packages": {
                "node_modules/@zerobias-org/logger": {
                    "version": "3.0.9",
                    "resolved": "http://localhost:15016/@zerobias-org/logger/-/logger-3.0.9.tgz",
                    "integrity": "sha512-abc123"
                },
                "node_modules/lodash": {
                    "version": "4.17.21",
                    "resolved": "https://registry.npmjs.org/lodash/-/lodash-4.17.21.tgz",
                    "integrity": "sha512-xyz789"
                }
            }
        }
        """.trimIndent())

        val service = newService(repoRoot)
        // ZB_SLOT is unset, so publishedNames is empty → the localhost entry is stale
        val stale = service.findStaleLocalhostEntries(repoRoot)
        assertEquals(1, stale.size)
        assertEquals("@zerobias-org/logger", stale[0].pkgName)
        assertEquals("node_modules/@zerobias-org/logger", stale[0].lockKey)
        assertTrue(stale[0].resolved.contains("localhost"))
    }

    @Test
    fun `findStaleLocalhostEntries returns empty when no localhost entries`(@TempDir tmp: Path) {
        val repoRoot = tmp.toFile()
        File(repoRoot, "package-lock.json").writeText("""
        {
            "lockfileVersion": 3,
            "packages": {
                "node_modules/lodash": {
                    "version": "4.17.21",
                    "resolved": "https://registry.npmjs.org/lodash/-/lodash-4.17.21.tgz",
                    "integrity": "sha512-xyz789"
                }
            }
        }
        """.trimIndent())

        val service = newService(repoRoot)
        val stale = service.findStaleLocalhostEntries(repoRoot)
        assertTrue(stale.isEmpty())
    }

    @Test
    fun `findStaleLocalhostEntries returns empty when no lockfile`(@TempDir tmp: Path) {
        val service = newService(tmp.toFile())
        val stale = service.findStaleLocalhostEntries(tmp.toFile())
        assertTrue(stale.isEmpty())
    }

    @Test
    fun `cleanupStale removes node_modules and clears lockfile entries`(@TempDir tmp: Path) {
        val previous = System.getenv("ZB_SLOT")
        if (previous != null) return

        val repoRoot = tmp.toFile()

        // Create a stale node_modules dir
        val staleModDir = File(repoRoot, "node_modules/@zerobias-org/logger")
        staleModDir.mkdirs()
        File(staleModDir, "index.js").writeText("module.exports = {}")

        // Lockfile with localhost entry
        File(repoRoot, "package-lock.json").writeText("""
        {
            "lockfileVersion": 3,
            "packages": {
                "node_modules/@zerobias-org/logger": {
                    "version": "3.0.9",
                    "resolved": "http://localhost:15016/@zerobias-org/logger/-/logger-3.0.9.tgz",
                    "integrity": "sha512-abc123"
                }
            }
        }
        """.trimIndent())

        val service = newService(repoRoot)
        val stale = service.findStaleLocalhostEntries(repoRoot)
        assertEquals(1, stale.size)

        val logs = mutableListOf<String>()
        service.cleanupStale(repoRoot, stale) { logs.add(it) }

        // node_modules entry should be deleted
        assertFalse(staleModDir.exists(), "stale node_modules dir should be removed")

        // Lockfile entry should be entirely removed (not just resolved/integrity)
        // because the pinned version is local-only and doesn't exist on the
        // public registry — npm needs to re-resolve from package.json's range.
        val lockJson = com.fasterxml.jackson.databind.ObjectMapper()
            .readValue(File(repoRoot, "package-lock.json"), Map::class.java) as Map<String, Any?>
        val packages = lockJson["packages"] as Map<String, Any?>
        assertNull(packages["node_modules/@zerobias-org/logger"], "stale entry should be removed entirely")

        assertTrue(logs.any { it.contains("tainted") }, "should log tainting")
        assertTrue(logs.any { it.contains("removed stale lockfile") }, "should log lockfile removal")
    }

    @Test
    fun `cleanupStale is a no-op for empty list`(@TempDir tmp: Path) {
        val service = newService(tmp.toFile())
        assertFalse(service.cleanupStale(tmp.toFile(), emptyList()))
    }

    // ── apply: same-version republish taint ──────────────────────

    @Test
    fun `apply taints node_modules when publishedAt is newer than installed mtime`(
        @TempDir tmp: Path,
    ) {
        val previous = System.getenv("ZB_SLOT")
        if (previous != null) return

        val repoRoot = tmp.toFile()
        val publishedAt = Instant.now().plusSeconds(3600)
        val pkg = RegistryInjectionService.PublishedPackage(
            "@zerobias-org/foo",
            "1.2.3",
            publishedAt,
        )
        writeRootPackageJson(repoRoot, pkg.name)

        // Lockfile entry already correct — won't be rewritten by apply().
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

        // Installed copy with the right version but stale mtime.
        val installed = File(repoRoot, "node_modules/@zerobias-org/foo")
        installed.mkdirs()
        File(installed, "package.json").writeText("""{"name":"@zerobias-org/foo","version":"1.2.3"}""")
        File(installed, "stale-marker.txt").writeText("from previous publish")

        val service = newServiceWithTrigger(repoRoot, publishes = listOf(pkg))
        val logs = mutableListOf<String>()
        service.apply { logs.add(it) }

        assertFalse(
            installed.exists(),
            "installed dir should be deleted when publishedAt is newer than its mtime",
        )
        assertTrue(
            logs.any { it.contains("tainted @zerobias-org/foo") && it.contains("publishedAt") },
            "should log taint with publishedAt reason; got: $logs",
        )
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
