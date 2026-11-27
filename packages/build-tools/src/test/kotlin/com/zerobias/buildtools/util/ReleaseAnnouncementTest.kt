package com.zerobias.buildtools.util

import com.fasterxml.jackson.databind.ObjectMapper
import com.zerobias.buildtools.util.ReleaseAnnouncement.PublishedPackage
import org.gradle.api.logging.Logging
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import java.io.File

/**
 * The packages file zbb hands to the publish workflow, and the rule for marking a package in it
 * as already announced. The workflow's announcement step sends a release event for every
 * unmarked package, so a wrong mark would mean no event at all.
 */
class ReleaseAnnouncementTest {

    @TempDir
    lateinit var tmp: File

    private val logger = Logging.getLogger(ReleaseAnnouncementTest::class.java)
    private val packages = listOf(
        PublishedPackage("@acme/widget", "1.0.1-dev.0", "package/acme/widget"),
        PublishedPackage("@acme/widget-sdk", "1.0.1-dev.0", "package/acme/widget/sdk"),
    )

    private fun written(eventSent: Set<String>?) = File(tmp, "published-packages.json").let { file ->
        if (eventSent == null) ReleaseAnnouncement.writePackagesFile(packages, tmp, file, logger)
        else ReleaseAnnouncement.writePackagesFile(packages, tmp, file, logger, eventSent)
        ObjectMapper().readTree(file)
    }

    @Test
    fun `the packages file carries the published name and version and an absolute location`() {
        val records = written(null)

        assertEquals(listOf("@acme/widget", "@acme/widget-sdk"), records.map { it["name"].asText() })
        assertEquals(listOf("1.0.1-dev.0", "1.0.1-dev.0"), records.map { it["version"].asText() })
        assertEquals(File(tmp, "package/acme/widget").absolutePath, records[0]["location"].asText())
        assertTrue(records.none { it.has("releaseEventSent") }, records.toString())
    }

    @Test
    fun `only the packages whose release event was sent are marked`() {
        val records = written(setOf("@acme/widget"))

        assertTrue(records[0]["releaseEventSent"].asBoolean(), records.toString())
        assertFalse(records[1].has("releaseEventSent"), records.toString())
    }

    @Test
    fun `dist-tags name a version once one of them points at it`() {
        assertTrue(ReleaseAnnouncement.namesVersion(mapOf("latest" to "1.0.0", "dev" to "1.0.1-dev.0"), "1.0.1-dev.0"))
        assertTrue(ReleaseAnnouncement.namesVersion(mapOf("latest" to "1.0.1"), "1.0.1"))
    }

    @Test
    fun `dist-tags read too early, or not at all, do not name the version`() {
        assertFalse(ReleaseAnnouncement.namesVersion(mapOf("latest" to "1.0.0", "dev" to "1.0.0-dev.4"), "1.0.1-dev.0"))
        assertFalse(ReleaseAnnouncement.namesVersion(emptyMap<String, Any>(), "1.0.1-dev.0"))
    }
}
