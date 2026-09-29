package com.zerobias.buildtools.content

import com.zerobias.buildtools.content.ElementContentRules.Outcome
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import java.io.File

class ElementContentRulesTest {

    private fun fields(doc: Map<String, Any?>) =
        ElementContentRules.checkElement("el", doc).map { it.field }

    private fun messages(doc: Map<String, Any?>) =
        ElementContentRules.checkElement("el", doc).map { it.message }

    // ── description ────────────────────────────────────────────────────

    @Test
    fun `plain short description passes`() {
        assertEquals(listOf<String>(), fields(mapOf("description" to "The hospital audits its medical records.")))
    }

    @Test
    fun `missing description passes`() {
        assertEquals(listOf<String>(), fields(mapOf("name" to "EC.01.01.01")))
    }

    @Test
    fun `description of 199 chars passes and 200 fails`() {
        assertEquals(listOf<String>(), fields(mapOf("description" to "a".repeat(199))))
        assertEquals(listOf("description"), fields(mapOf("description" to "a".repeat(200))))
    }

    @Test
    fun `trailing newline from a block scalar is not content`() {
        assertEquals(listOf<String>(), fields(mapOf("description" to "Plain statement.\n")))
    }

    @Test
    fun `embedded newline fails`() {
        assertTrue(messages(mapOf("description" to "First line.\nSecond line.")).contains("must not contain newlines"))
    }

    @Test
    fun `non-string description fails`() {
        assertEquals(listOf("description"), fields(mapOf("description" to 42)))
    }

    @Test
    fun `HTML tag fails`() {
        assertEquals(listOf("description"), fields(mapOf("description" to "Ensure <b>root</b> login is disabled")))
    }

    @Test
    fun `config placeholder in angle brackets is plain text`() {
        assertEquals(listOf<String>(), fields(mapOf("description" to "Set unlock_time=<n> in faillock.conf")))
    }

    @Test
    fun `markdown bold, link, code span and heading fail`() {
        listOf(
            "Ensure **root** login is disabled",
            "See [CIS](https://cisecurity.org) for details",
            "Run `sshd -T` to verify",
            "# Heading",
        ).forEach { assertEquals(listOf("description"), fields(mapOf("description" to it)), it) }
    }

    @Test
    fun `python dunder is plain text`() {
        assertEquals(listOf<String>(), fields(mapOf("description" to "Do not import from __init__ modules")))
    }

    // ── background ─────────────────────────────────────────────────────

    @Test
    fun `inline markdown background passes and non-string fails`() {
        assertEquals(listOf<String>(), fields(mapOf("background" to "## Rationale\n\n**Why** it matters")))
        assertEquals(listOf("background"), fields(mapOf("background" to listOf("x"))))
    }

    // ── links ──────────────────────────────────────────────────────────

    @Test
    fun `well-formed links pass`() {
        val links = mapOf(
            "demonstrates" to listOf("cis.controls.v8.framework/4.1"),
            "supports" to listOf("oss.postgresql"),
        )
        assertEquals(listOf<String>(), fields(mapOf("links" to links)))
    }

    @Test
    fun `links that are not a map fail`() {
        assertEquals(listOf("links"), fields(mapOf("links" to listOf("oss.postgresql"))))
    }

    @Test
    fun `predicate value that is not a list fails`() {
        assertEquals(listOf("links.supports"), fields(mapOf("links" to mapOf("supports" to "oss.postgresql"))))
    }

    @Test
    fun `blank or whitespace alias fails`() {
        val links = mapOf("supports" to listOf("", "oss postgresql", "oss.postgresql"))
        assertEquals(listOf("links.supports[0]", "links.supports[1]"), fields(mapOf("links" to links)))
    }

    @Test
    fun `non-string predicate fails`() {
        assertEquals(listOf("links"), fields(mapOf("links" to mapOf(true to listOf("oss.postgresql")))))
    }

    // ── exemptions ─────────────────────────────────────────────────────

    @Test
    fun `deprecated and skipped elements are exempt`() {
        val bad = "x".repeat(500)
        assertEquals(listOf<String>(), fields(mapOf("description" to bad, "deprecate" to true)))
        assertEquals(listOf<String>(), fields(mapOf("description" to bad, "skip" to true)))
        assertEquals(listOf("description"), fields(mapOf("description" to bad, "deprecate" to false)))
    }

    // ── checkPackage ───────────────────────────────────────────────────

    @Test
    fun `checkPackage reads elements yml only, in file order`(@TempDir dir: File) {
        val elements = dir.resolve("elements").apply { mkdirs() }
        elements.resolve("b.yml").writeText("description: \"${"b".repeat(250)}\"\n")
        elements.resolve("a.yml").writeText("description: \"Line one\\nline two\"\n")
        elements.resolve("c.yml").writeText("description: fine\ndeprecate: true\n")
        elements.resolve("a-background.md").writeText("# **markdown** is fine here\n")
        elements.resolve("notes.txt").writeText("ignored")

        val violations = ElementContentRules.checkPackage(dir)
        assertEquals(listOf("a", "b"), violations.map { it.element })
    }

    @Test
    fun `checkPackage reports unparseable and non-map yaml`(@TempDir dir: File) {
        val elements = dir.resolve("elements").apply { mkdirs() }
        elements.resolve("broken.yml").writeText("description: [unclosed\n")
        elements.resolve("list.yml").writeText("- just\n- a list\n")

        val violations = ElementContentRules.checkPackage(dir)
        assertEquals(listOf("broken" to "yaml", "list" to "yaml"), violations.map { it.element to it.field })
    }

    @Test
    fun `checkPackage without elements dir is empty`(@TempDir dir: File) {
        assertEquals(0, ElementContentRules.checkPackage(dir).size)
    }

    // ── enforce mode ───────────────────────────────────────────────────

    private fun v(field: String) = ElementContentRules.Violation("el", field, "x")

    @Test
    fun `parseMode defaults to warn and accepts enforce`() {
        assertEquals(ElementContentRules.Mode.WARN, ElementContentRules.parseMode(null))
        assertEquals(ElementContentRules.Mode.WARN, ElementContentRules.parseMode(""))
        assertEquals(ElementContentRules.Mode.WARN, ElementContentRules.parseMode("warn"))
        assertEquals(ElementContentRules.Mode.ENFORCE, ElementContentRules.parseMode("enforce"))
        assertEquals(ElementContentRules.Mode.ENFORCE, ElementContentRules.parseMode(" Enforce "))
    }

    @Test
    fun `parseMode rejects an unknown value instead of silently not enforcing`() {
        assertThrows(IllegalArgumentException::class.java) { ElementContentRules.parseMode("strict") }
    }

    @Test
    fun `enforce passes a clean package`() {
        assertEquals(Outcome.PASS, ElementContentRules.judge(":acme:fw:v1", emptyList(), ElementContentRules.Mode.ENFORCE).outcome)
    }

    @Test
    fun `enforce fails on any description or background violation`() {
        assertEquals(Outcome.FAIL_ENFORCED, ElementContentRules.judge(":acme:fw:v1", listOf(v("description")), ElementContentRules.Mode.ENFORCE).outcome)
        assertEquals(Outcome.FAIL_ENFORCED, ElementContentRules.judge(":acme:fw:v1", listOf(v("background")), ElementContentRules.Mode.ENFORCE).outcome)
        assertEquals(Outcome.FAIL_ENFORCED, ElementContentRules.judge(":acme:fw:v1", listOf(v("links.demonstrates[0]"), v("description")), ElementContentRules.Mode.ENFORCE).outcome)
    }

    @Test
    fun `enforce only warns on link shape problems`() {
        val verdict = ElementContentRules.judge(":acme:fw:v1", listOf(v("links.demonstrates[0]"), v("links")), ElementContentRules.Mode.ENFORCE)
        assertEquals(Outcome.WARN_ADVISORY, verdict.outcome)
        assertTrue(!verdict.outcome.fails)
    }

    @Test
    fun `yaml errors block in enforce mode`() {
        assertEquals(Outcome.FAIL_ENFORCED, ElementContentRules.judge(":acme:fw:v1", listOf(v("yaml")), ElementContentRules.Mode.ENFORCE).outcome)
    }

    @Test
    fun `warn mode never fails`() {
        val verdict = ElementContentRules.judge(":acme:fw:v1", listOf(v("description"), v("links")), ElementContentRules.Mode.WARN)
        assertEquals(Outcome.WARN_UNENFORCED, verdict.outcome)
        assertTrue(!verdict.outcome.fails)
        assertEquals(Outcome.PASS, ElementContentRules.judge(":acme:fw:v1", emptyList(), ElementContentRules.Mode.WARN).outcome)
    }

    @Test
    fun `only enforce violations fail`() {
        assertEquals(setOf(Outcome.FAIL_ENFORCED), Outcome.values().filter { it.fails }.toSet())
    }

    @Test
    fun `the old ratchet value is rejected rather than silently ignored`() {
        assertThrows(IllegalArgumentException::class.java) { ElementContentRules.parseMode("ratchet") }
    }
}
