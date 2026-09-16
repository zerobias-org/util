package com.zerobias.buildtools.content

import org.yaml.snakeyaml.Yaml
import java.io.File

/**
 * Content rules every `Element` follows, whichever artifact type ships it
 * (framework, standard, benchmark):
 *
 *   description — plain text: no markdown, HTML or newlines, under 200 chars
 *   background  — the same material as markdown, any length. The dataloader
 *                 prefers `elements/<code>-background.md`, then a shared
 *                 `elements/background.md`, then an inline `background:`
 *   links       — Record<predicate, alias[]>
 *
 * These are not schema checks, so they don't belong to the dataloader: it
 * loads a 2,000-character markdown description without complaint, and its
 * ResourceLinker drops an alias it cannot resolve silently. Aliases are only
 * shape-checked here — resolving one needs the live catalog.
 *
 * `zb.content` runs [checkPackage] from `validateContent` for every package
 * with an `elements/` directory, and applies the repo's ratchet via [judge].
 */
object ElementContentRules {

    const val MAX_DESCRIPTION = 200

    /** Ratchet file at the consumer repo's root. */
    const val BASELINE_FILE = "element-rules-baseline.txt"

    data class Violation(val element: String, val field: String, val message: String) {
        override fun toString() = "$element: $field $message"
    }

    // Allow-listed tag names only: a bare `<[^>]+>` flags config placeholders
    // such as `unlock_time=<n>`, which are legitimate plain text.
    private val HTML_TAG = Regex(
        "</?(?:a|b|br|code|div|em|h[1-6]|i|li|ol|p|pre|s|span|strong|sub|sup|table|tbody|td|th|thead|tr|ul)(?:\\s[^>]*)?/?>",
        RegexOption.IGNORE_CASE,
    )

    // `__bold__` is deliberately absent: it matches Python dunders (`__init__`)
    // that benchmark descriptions quote as plain text.
    private val MARKDOWN = listOf(
        Regex("\\*\\*[^*]+\\*\\*") to "bold",
        Regex("\\[[^\\]]+]\\([^)]*\\)") to "link",
        Regex("`[^`]+`") to "code span",
        Regex("^#{1,6}\\s") to "heading",
    )

    // ── Rules ────────────────────────────────────────────────────────

    /**
     * Violations for one element document. Elements the dataloader never
     * loads (`deprecate: true`, `skip: true`) are exempt.
     */
    @JvmStatic
    fun checkElement(element: String, doc: Map<String, Any?>): List<Violation> {
        if (doc["deprecate"] == true || doc["skip"] == true) return emptyList()

        val violations = mutableListOf<Violation>()
        fun violation(field: String, message: String) {
            violations += Violation(element, field, message)
        }

        when (val description = doc["description"]) {
            null -> {}
            !is String -> violation("description", "must be a string (got ${description.javaClass.simpleName})")
            else -> {
                // Block scalars (`>` / `|`) end in a newline; that is YAML, not content.
                val text = description.trim()
                if (text.length >= MAX_DESCRIPTION) {
                    violation("description", "is ${text.length} chars; must be under $MAX_DESCRIPTION")
                }
                if (text.contains('\n') || text.contains('\r')) {
                    violation("description", "must not contain newlines")
                }
                HTML_TAG.find(text)?.let { violation("description", "must not contain HTML (${it.value})") }
                MARKDOWN.firstOrNull { (regex, _) -> regex.containsMatchIn(text) }
                    ?.let { (_, kind) -> violation("description", "must not contain markdown ($kind)") }
            }
        }

        doc["background"]?.let { background ->
            if (background !is String) {
                violation("background", "must be a markdown string (got ${background.javaClass.simpleName})")
            }
        }

        when (val links = doc["links"]) {
            null -> {}
            !is Map<*, *> -> violation("links", "must be a map of predicate to alias list")
            else -> for ((predicate, aliases) in links) {
                if (predicate !is String || predicate.isBlank()) {
                    violation("links", "has a blank or non-string predicate ($predicate)")
                    continue
                }
                if (aliases !is List<*>) {
                    violation("links.$predicate", "must be a list of aliases")
                    continue
                }
                aliases.forEachIndexed { i, alias ->
                    if (alias !is String || alias.isBlank() || alias.any { it.isWhitespace() }) {
                        violation("links.$predicate[$i]", "must be a non-blank alias without whitespace (got '$alias')")
                    }
                }
            }
        }

        return violations
    }

    /** Violations across `<packageDir>/elements/<code>.yml`, in file-name order. */
    @JvmStatic
    fun checkPackage(packageDir: File): List<Violation> {
        val elementsDir = packageDir.resolve("elements")
        if (!elementsDir.isDirectory) return emptyList()

        return elementsDir.listFiles { f -> f.isFile && f.name.endsWith(".yml") }
            .orEmpty()
            .sortedBy { it.name }
            .flatMap { file ->
                val element = file.name.removeSuffix(".yml")
                val doc = try {
                    Yaml().load<Any?>(file.readText())
                } catch (e: Exception) {
                    return@flatMap listOf(
                        Violation(element, "yaml", "is unparseable: ${e.message?.lineSequence()?.firstOrNull()}")
                    )
                }
                @Suppress("UNCHECKED_CAST")
                (doc as? Map<String, Any?>)?.let { checkElement(element, it) }
                    ?: listOf(Violation(element, "yaml", "is not a map"))
            }
    }

    // ── Ratchet ──────────────────────────────────────────────────────

    enum class Outcome(val fails: Boolean) {
        PASS(false),
        /** Repo has no baseline file yet: violations are reported, never fatal. */
        WARN_UNENFORCED(false),
        /** Fewer violations than the baseline allows — the count should be lowered. */
        WARN_TIGHTEN(false),
        /** Package not in the baseline has violations. */
        FAIL_NEW(true),
        /** Package has more violations than the baseline allows. */
        FAIL_REGRESSED(true),
        /** Package is clean but still listed. */
        FAIL_STALE(true),
    }

    data class Verdict(val outcome: Outcome, val message: String)

    /**
     * Decide a package's fate from its violation count and the repo's
     * baseline (`null` when the repo has no [BASELINE_FILE]).
     *
     * Consumers resolve build-tools as `1.+`, so a repo without a baseline
     * only warns: enforcement starts when the repo commits one.
     */
    @JvmStatic
    fun judge(projectPath: String, violations: Int, baseline: Map<String, Int>?): Verdict {
        val allowed = baseline?.get(projectPath)
        return when {
            violations == 0 && allowed == null ->
                Verdict(Outcome.PASS, "$projectPath: element content rules passed")
            baseline == null ->
                Verdict(Outcome.WARN_UNENFORCED, "$projectPath: $violations element content rule violation(s) — not enforced until this repo commits $BASELINE_FILE")
            allowed == null ->
                Verdict(Outcome.FAIL_NEW, "$projectPath: $violations element content rule violation(s) in a package not listed in $BASELINE_FILE — packages outside the baseline must be clean")
            violations > allowed ->
                Verdict(Outcome.FAIL_REGRESSED, "$projectPath: $violations element content rule violation(s), $BASELINE_FILE allows $allowed — fix the new ones")
            violations == 0 ->
                Verdict(Outcome.FAIL_STALE, "$projectPath: element content rules now pass — remove it from $BASELINE_FILE")
            violations < allowed ->
                Verdict(Outcome.WARN_TIGHTEN, "$projectPath: $violations element content rule violation(s), $BASELINE_FILE allows $allowed — lower its count to $violations")
            else ->
                Verdict(Outcome.PASS, "$projectPath: $violations element content rule violation(s), at its baseline")
        }
    }

    /** Parse `:project:path=<count>` lines; `#` starts a comment. */
    @JvmStatic
    fun parseBaseline(text: String): Map<String, Int> {
        val counts = linkedMapOf<String, Int>()
        for (raw in text.lineSequence()) {
            val line = raw.substringBefore('#').trim()
            if (line.isEmpty()) continue
            val path = line.substringBeforeLast('=', "").trim()
            val count = line.substringAfterLast('=', "").trim().toIntOrNull()
            require(path.startsWith(":") && count != null && count > 0) {
                "$BASELINE_FILE: malformed line '$raw' (expected :project:path=<count> with count > 0)"
            }
            require(counts.put(path, count) == null) { "$BASELINE_FILE: $path is listed twice" }
        }
        return counts
    }

    /** Render a baseline file, packages sorted by path. */
    @JvmStatic
    fun formatBaseline(counts: Map<String, Int>): String = buildString {
        appendLine("# Element content rule violations allowed per package (ratchet).")
        appendLine("# A package not listed here must have none; a listed package may not exceed its count.")
        appendLine("# Lower a count as violations are fixed, and remove a package once it reaches zero.")
        appendLine("# Bootstrap: ./gradlew writeElementRulesBaseline")
        counts.filterValues { it > 0 }.toSortedMap().forEach { (path, count) -> appendLine("$path=$count") }
    }
}
