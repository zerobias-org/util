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
 * with an `elements/` directory and applies [judge]. The repo chooses the
 * mode with `zb.elementRules` in its root `gradle.properties`:
 *
 *   - `enforce` — every description/background violation fails the build.
 *     There is no exceptions list: a violating package is fixed, not recorded.
 *   - `warn` (default) — violations are reported, never fatal. The default
 *     stays non-fatal because consumers resolve build-tools as `1.+`.
 */
object ElementContentRules {

    const val MAX_DESCRIPTION = 200

    data class Violation(val element: String, val field: String, val message: String) {
        override fun toString() = "$element: $field $message"

        /**
         * Whether enforce mode fails the build on this violation. `links` are
         * only shape-checked here — whether an alias resolves needs the live
         * catalog — so enforce mode reports them without failing.
         */
        val blocking: Boolean
            get() = !this.field.startsWith("links")
    }

    /** Gradle property (root `gradle.properties`) that selects the mode. */
    const val MODE_PROPERTY = "zb.elementRules"

    enum class Mode { WARN, ENFORCE }

    /** `null`, empty or `warn` → [Mode.WARN]; `enforce` → [Mode.ENFORCE]. */
    @JvmStatic
    fun parseMode(value: Any?): Mode = when (value?.toString()?.trim()?.lowercase()) {
        null, "", "warn" -> Mode.WARN
        "enforce" -> Mode.ENFORCE
        else -> throw IllegalArgumentException(
            "$MODE_PROPERTY must be 'enforce' or 'warn' (got '$value')"
        )
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

    // ── Verdict ──────────────────────────────────────────────────────

    enum class Outcome(val fails: Boolean) {
        PASS(false),
        /** Warn mode: violations are reported, never fatal. */
        WARN_UNENFORCED(false),
        /** Enforce mode: only non-blocking (`links`) violations remain. */
        WARN_ADVISORY(false),
        /** Enforce mode: a description/background violation. */
        FAIL_ENFORCED(true),
    }

    data class Verdict(val outcome: Outcome, val message: String)

    /**
     * Decide a package's fate. In [Mode.ENFORCE] any blocking violation
     * fails; `links` shape problems are reported but never fail (see
     * [Violation.blocking]). In [Mode.WARN] nothing fails.
     */
    @JvmStatic
    fun judge(projectPath: String, violations: List<Violation>, mode: Mode): Verdict {
        val blocking = violations.count { it.blocking }
        val advisory = violations.size - blocking
        return when {
            violations.isEmpty() ->
                Verdict(Outcome.PASS, "$projectPath: element content rules passed")
            mode == Mode.WARN ->
                Verdict(Outcome.WARN_UNENFORCED, "$projectPath: ${violations.size} element content rule violation(s) — not enforced (set $MODE_PROPERTY=enforce in gradle.properties)")
            blocking > 0 ->
                Verdict(Outcome.FAIL_ENFORCED, "$projectPath: $blocking element content rule violation(s) — $MODE_PROPERTY=enforce fails on any; fix them (move long text to <code>-background.md)")
            else ->
                Verdict(Outcome.WARN_ADVISORY, "$projectPath: element content rules passed; $advisory link alias warning(s) (shape only — resolve aliases against the live catalog)")
        }
    }
}
