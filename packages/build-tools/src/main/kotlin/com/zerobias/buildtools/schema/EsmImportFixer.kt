package com.zerobias.buildtools.schema

import java.io.File

/**
 * Re-implements the sed loop in the legacy `generate.sh`:
 *
 *   find src -name "*.ts" | while read -r f; do
 *     sed -E -i.bak \
 *       -e "s|from ['\"](\.\./[^'\"]+)['\"];|from '\1.js';|g" \
 *       -e "s|from ['\"](\./[^'\"]+)['\"];|from '\1.js';|g" \
 *       -e "s|\.js\.js|.js|g" \
 *       "$f"
 *     rm -f "$f.bak"
 *   done
 *
 * Background: schema-ts-generator emits NodeNext-incompatible imports
 * (no `.js` suffix). The Node.js NodeNext resolver requires an explicit
 * `.js` on every relative import, so we rewrite the emitted files in
 * place after generation.
 *
 * Only relative imports (starting with `./` or `../`) are touched —
 * bare specifiers like `@zerobias-org/types-core-js` stay untouched.
 *
 * Double-`.js.js` is collapsed to a single `.js` so re-running the
 * fixer is idempotent (also covers the case where the generator
 * already emits some suffixed paths).
 */
object EsmImportFixer {

    // Matches: from "./foo"  or  from '../bar/baz'  (no trailing .js)
    // Captures the path inside quotes. Optional trailing `;` not in pattern
    // so we keep the semicolon as-is.
    private val IMPORT_FROM = Regex(
        """from\s+(["'])(\.\.?/[^"']+)\1"""
    )

    // Matches: import "./side-effect"  (bare import for side effects)
    private val SIDE_EFFECT_IMPORT = Regex(
        """import\s+(["'])(\.\.?/[^"']+)\1"""
    )

    /** Rewrite a single line. Returns the line with relative imports suffixed. */
    @JvmStatic
    fun fixLine(line: String): String {
        var out = line
        out = IMPORT_FROM.replace(out) { mr ->
            val quote = mr.groupValues[1]
            val path = mr.groupValues[2]
            val suffixed = if (path.endsWith(".js")) path else "$path.js"
            "from $quote$suffixed$quote"
        }
        out = SIDE_EFFECT_IMPORT.replace(out) { mr ->
            val quote = mr.groupValues[1]
            val path = mr.groupValues[2]
            val suffixed = if (path.endsWith(".js")) path else "$path.js"
            "import $quote$suffixed$quote"
        }
        // Collapse any accidental double-suffix from re-runs.
        out = out.replace(".js.js", ".js")
        return out
    }

    /** Rewrite a file in place. Best-effort: read, transform, write only if changed. */
    @JvmStatic
    fun fixFile(file: File) {
        if (!file.isFile) return
        val original = file.readText()
        val transformed = original.lines().joinToString("\n") { fixLine(it) }
            .let { if (original.endsWith("\n") && !it.endsWith("\n")) "$it\n" else it }
        if (transformed != original) file.writeText(transformed)
    }

    /** Walk `dir` for *.ts files and run [fixFile] on each. */
    @JvmStatic
    fun fixDir(dir: File) {
        if (!dir.isDirectory) return
        dir.walkTopDown()
            .filter { it.isFile && it.extension == "ts" }
            .forEach { fixFile(it) }
    }
}
