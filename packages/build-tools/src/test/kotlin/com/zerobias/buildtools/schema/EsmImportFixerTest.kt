package com.zerobias.buildtools.schema

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import java.nio.file.Path

class EsmImportFixerTest {

    @Test
    fun `appends _js to relative imports without suffix`() {
        assertEquals(
            "import { Foo } from './foo.js';",
            EsmImportFixer.fixLine("import { Foo } from './foo';")
        )
        assertEquals(
            "import Foo from '../models/Foo.js';",
            EsmImportFixer.fixLine("import Foo from '../models/Foo';")
        )
        assertEquals(
            "import * as ns from './namespace.js';",
            EsmImportFixer.fixLine("import * as ns from './namespace';")
        )
        assertEquals(
            "export { Foo } from './foo.js';",
            EsmImportFixer.fixLine("export { Foo } from './foo';")
        )
    }

    @Test
    fun `handles double-quoted imports`() {
        assertEquals(
            """import { Foo } from "./foo.js";""",
            EsmImportFixer.fixLine("""import { Foo } from "./foo";""")
        )
    }

    @Test
    fun `is idempotent — does not double-suffix when run twice`() {
        val original = "import { Foo } from './foo';"
        val once = EsmImportFixer.fixLine(original)
        val twice = EsmImportFixer.fixLine(once)
        assertEquals(once, twice, "running the fixer twice must produce the same output")
        assertEquals("import { Foo } from './foo.js';", twice)
        assertTrue(!twice.contains(".js.js"), "must collapse double-.js")
    }

    @Test
    fun `collapses pre-existing _js_js double suffix`() {
        assertEquals(
            "import x from './a.js';",
            EsmImportFixer.fixLine("import x from './a.js.js';")
        )
    }

    @Test
    fun `leaves bare specifier imports untouched`() {
        val line = "import { Logger } from '@zerobias-org/types-core-js';"
        assertEquals(line, EsmImportFixer.fixLine(line))

        val line2 = "import express from 'express';"
        assertEquals(line2, EsmImportFixer.fixLine(line2))
    }

    @Test
    fun `handles side-effect imports — import bare relative path`() {
        assertEquals(
            "import './polyfills.js';",
            EsmImportFixer.fixLine("import './polyfills';")
        )
        assertEquals(
            "import '../setup.js';",
            EsmImportFixer.fixLine("import '../setup';")
        )
    }

    @Test
    fun `leaves bare-package side-effect imports untouched`() {
        val line = "import 'reflect-metadata';"
        assertEquals(line, EsmImportFixer.fixLine(line))
    }

    @Test
    fun `multiple imports on the same line all get rewritten`() {
        // Rare but possible in generated code.
        val line = "export { A } from './a'; export { B } from './b';"
        val expected = "export { A } from './a.js'; export { B } from './b.js';"
        assertEquals(expected, EsmImportFixer.fixLine(line))
    }

    @Test
    fun `preserves non-import lines verbatim`() {
        val code = "const x = 42; // ./foo not an import"
        assertEquals(code, EsmImportFixer.fixLine(code))
    }

    @Test
    fun `fixFile rewrites in place and preserves trailing newline`(@TempDir tmp: Path) {
        val f = tmp.resolve("x.ts").toFile()
        f.writeText("""
            import { Foo } from './foo';
            export const y = 1;
        """.trimIndent() + "\n")

        EsmImportFixer.fixFile(f)
        val out = f.readText()
        assertTrue(out.contains("from './foo.js'"))
        assertTrue(out.endsWith("\n"), "trailing newline must be preserved")
    }

    @Test
    fun `fixFile leaves untouched files unchanged on disk`(@TempDir tmp: Path) {
        val f = tmp.resolve("clean.ts").toFile()
        val content = "import x from 'some-package';\nconst y = 1;\n"
        f.writeText(content)
        val mtimeBefore = f.lastModified()
        // Sleep briefly so a write would change mtime
        Thread.sleep(50)
        EsmImportFixer.fixFile(f)
        assertEquals(content, f.readText())
        assertEquals(mtimeBefore, f.lastModified(), "should not rewrite when content unchanged")
    }

    @Test
    fun `fixDir walks recursively`(@TempDir tmp: Path) {
        val src = tmp.resolve("src").toFile()
        src.mkdirs()
        val nested = src.resolve("models")
        nested.mkdirs()
        val a = src.resolve("index.ts")
        val b = nested.resolve("Foo.ts")
        a.writeText("export * from './models/Foo';\n")
        b.writeText("import { Bar } from '../shared/Bar';\n")

        // Non-ts file should be ignored
        src.resolve("README.md").writeText("# nothing\n")

        EsmImportFixer.fixDir(src)
        assertTrue(a.readText().contains("'./models/Foo.js'"))
        assertTrue(b.readText().contains("'../shared/Bar.js'"))
    }
}
