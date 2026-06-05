package com.zerobias.buildtools.util

import org.junit.jupiter.api.Test
import org.junit.jupiter.api.Assertions.assertEquals

class VersionBumperTest {

    // ── firstUnpublishedPatch ────────────────────────────────────────

    /**
     * Still iterating pre-releases of an UNRELEASED patch: the base release is
     * not on the registry, so the patch must NOT advance.
     */
    @Test
    fun `firstUnpublishedPatch keeps the base when the release is not published`() {
        val published = setOf("2.0.1", "2.0.2-dev.0")
        assertEquals("2.0.2", VersionBumper.firstUnpublishedPatch("2.0.2") { it in published })
    }

    /**
     * The original bug: main shipped 2.0.2, so a dev push off base 2.0.2 must
     * advance to 2.0.3 — otherwise 2.0.2-dev.0 sorts BELOW 2.0.2 and drags the
     * `dev` dist-tag backwards.
     */
    @Test
    fun `firstUnpublishedPatch advances past a released base`() {
        val published = setOf("2.0.1", "2.0.2")
        assertEquals("2.0.3", VersionBumper.firstUnpublishedPatch("2.0.2") { it in published })
    }

    /** Walk over an orphaned patch left above the current one by a rollback. */
    @Test
    fun `firstUnpublishedPatch walks over orphaned patches`() {
        val published = setOf("2.0.2", "2.0.3")
        assertEquals("2.0.4", VersionBumper.firstUnpublishedPatch("2.0.2") { it in published })
    }

    /** A published pre-release is NOT the release — base must hold. */
    @Test
    fun `firstUnpublishedPatch ignores published pre-releases`() {
        val published = setOf("2.0.2-dev.0", "2.0.2-dev.1")
        assertEquals("2.0.2", VersionBumper.firstUnpublishedPatch("2.0.2") { it in published })
    }

    /** Bounded so a permanently "published" registry can't spin forever. */
    @Test
    fun `firstUnpublishedPatch is bounded`() {
        assertEquals("2.0.102", VersionBumper.firstUnpublishedPatch("2.0.2") { true })
    }

    // ── resolvePreRelease ────────────────────────────────────────────

    /** Brand-new base, nothing published → counter starts at 0. */
    @Test
    fun `resolvePreRelease cuts dev_0 for a fresh unreleased base`() {
        assertEquals("2.0.2-dev.0", VersionBumper.resolvePreRelease("2.0.2", "dev", 0) { false })
    }

    /** Another dev push on an unreleased base bumps the counter, not the patch. */
    @Test
    fun `resolvePreRelease increments the counter on an unreleased base`() {
        val published = setOf("2.0.2-dev.0")
        assertEquals("2.0.2-dev.1", VersionBumper.resolvePreRelease("2.0.2", "dev", 0) { it in published })
    }

    @Test
    fun `resolvePreRelease keeps walking the counter past multiple collisions`() {
        val published = setOf("2.0.2-dev.0", "2.0.2-dev.1", "2.0.2-dev.2")
        assertEquals("2.0.2-dev.3", VersionBumper.resolvePreRelease("2.0.2", "dev", 0) { it in published })
    }

    /**
     * The bug case end-to-end: 2.0.2 is released, so a dev push must produce
     * 2.0.3-dev.0 — strictly greater than the 2.0.2 release.
     */
    @Test
    fun `resolvePreRelease bumps the patch once the release is published`() {
        val published = setOf("2.0.1", "2.0.2")
        assertEquals("2.0.3-dev.0", VersionBumper.resolvePreRelease("2.0.2", "dev", 0) { it in published })
    }

    /**
     * Promotion dev→qa: the patch is preserved, the suffix swaps, and the
     * counter restarts at 0 — 2.0.2-dev.2 becomes 2.0.2-qa.0.
     */
    @Test
    fun `resolvePreRelease swaps suffix and resets counter on promotion`() {
        val published = setOf("2.0.2-dev.0", "2.0.2-dev.1", "2.0.2-dev.2")
        assertEquals("2.0.2-qa.0", VersionBumper.resolvePreRelease("2.0.2", "qa", 0) { it in published })
    }

    /** Promotion still bumps the patch if the release already shipped. */
    @Test
    fun `resolvePreRelease bumps patch on promotion when release is published`() {
        val published = setOf("2.0.2", "2.0.2-dev.0", "2.0.2-dev.1")
        assertEquals("2.0.3-qa.0", VersionBumper.resolvePreRelease("2.0.2", "qa", 0) { it in published })
    }
}
