package com.zerobias.buildtools.monorepo

import org.junit.jupiter.api.Test
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.io.TempDir
import java.io.File
import java.nio.file.Path

class PrepublishTest {

    // ── isValidPackageName ───────────────────────────────────────────

    @Test
    fun `isValidPackageName accepts unscoped packages`() {
        assertTrue(Prepublish.isValidPackageName("lodash"))
        assertTrue(Prepublish.isValidPackageName("react-dom"))
        assertTrue(Prepublish.isValidPackageName("foo.bar"))
        assertTrue(Prepublish.isValidPackageName("foo_bar"))
    }

    @Test
    fun `isValidPackageName accepts scoped packages`() {
        assertTrue(Prepublish.isValidPackageName("@scope/pkg"))
        assertTrue(Prepublish.isValidPackageName("@zerobias-com/util-core"))
        assertTrue(Prepublish.isValidPackageName("@types/node"))
    }

    @Test
    fun `isValidPackageName rejects invalid names`() {
        assertFalse(Prepublish.isValidPackageName(""))
        assertFalse(Prepublish.isValidPackageName(".rc"))
        assertFalse(Prepublish.isValidPackageName("-flag"))
        assertFalse(Prepublish.isValidPackageName("\$VAR"))
        assertFalse(Prepublish.isValidPackageName("foo;bar"))
        assertFalse(Prepublish.isValidPackageName("foo|bar"))
        assertFalse(Prepublish.isValidPackageName("@scope"))  // missing pkg
        assertFalse(Prepublish.isValidPackageName("@/pkg"))  // empty scope
        assertFalse(Prepublish.isValidPackageName("Foo"))  // uppercase
    }

    // ── scanImports ──────────────────────────────────────────────────

    @Test
    fun `scanImports extracts ES6 from clauses`(@TempDir tmp: Path) {
        val pkg = tmp.toFile()
        File(pkg, "src").mkdirs()
        File(pkg, "src/index.ts").writeText("""
            import { foo } from 'lodash';
            import bar from '@scope/pkg';
            import { multi } from 'multi-line/sub';
        """.trimIndent())

        val imports = Prepublish.scanImports(pkg)
        assertTrue(imports.contains("lodash"))
        assertTrue(imports.contains("@scope/pkg"))
        assertTrue(imports.contains("multi-line"))
    }

    @Test
    fun `scanImports handles multi-line imports`(@TempDir tmp: Path) {
        val pkg = tmp.toFile()
        File(pkg, "src").mkdirs()
        File(pkg, "src/a.ts").writeText("""
            import {
              one,
              two,
              three,
            } from '@multi/line-pkg';
        """.trimIndent())

        val imports = Prepublish.scanImports(pkg)
        assertTrue(imports.contains("@multi/line-pkg"))
    }

    @Test
    fun `scanImports extracts CommonJS require`(@TempDir tmp: Path) {
        val pkg = tmp.toFile()
        File(pkg, "src").mkdirs()
        File(pkg, "src/legacy.js").writeText("""
            const fs = require('fs');
            const { x } = require('@scope/legacy-pkg');
            const helper = require('helper-pkg/sub/path');
        """.trimIndent())

        val imports = Prepublish.scanImports(pkg)
        assertTrue(imports.contains("fs"))
        assertTrue(imports.contains("@scope/legacy-pkg"))
        assertTrue(imports.contains("helper-pkg"))
    }

    @Test
    fun `scanImports extracts side-effect imports`(@TempDir tmp: Path) {
        val pkg = tmp.toFile()
        File(pkg, "src").mkdirs()
        File(pkg, "src/init.ts").writeText("""
            import 'reflect-metadata';
            import '@scope/polyfills';
        """.trimIndent())

        val imports = Prepublish.scanImports(pkg)
        assertTrue(imports.contains("reflect-metadata"))
        assertTrue(imports.contains("@scope/polyfills"))
    }

    @Test
    fun `scanImports skips relative paths and node protocol`(@TempDir tmp: Path) {
        val pkg = tmp.toFile()
        File(pkg, "src").mkdirs()
        File(pkg, "src/a.ts").writeText("""
            import { x } from './local-file';
            import { y } from '../sibling';
            import { readFileSync } from 'node:fs';
            import http from 'node:http';
            import { real } from 'real-pkg';
        """.trimIndent())

        val imports = Prepublish.scanImports(pkg)
        assertFalse(imports.contains("./local-file"))
        assertFalse(imports.contains("node:fs"))
        assertFalse(imports.contains("node:http"))
        assertTrue(imports.contains("real-pkg"))
    }

    @Test
    fun `scanImports skips test directories`(@TempDir tmp: Path) {
        val pkg = tmp.toFile()
        File(pkg, "src").mkdirs()
        File(pkg, "test").mkdirs()
        File(pkg, "src/index.ts").writeText("import { x } from 'real-dep';")
        File(pkg, "test/index.test.ts").writeText("import { y } from 'test-only-dep';")

        val imports = Prepublish.scanImports(pkg)
        assertTrue(imports.contains("real-dep"))
        assertFalse(imports.contains("test-only-dep")) {
            "test/ should be skipped per IMPORT_SKIP_DIRS"
        }
    }

    // ── scanShellScripts ─────────────────────────────────────────────

    @Test
    fun `scanShellScripts finds packages in node_modules paths`(@TempDir tmp: Path) {
        val pkg = tmp.toFile()
        File(pkg, "scripts").mkdirs()
        File(pkg, "scripts/run.sh").writeText("""
            #!/bin/bash
            node node_modules/@zerobias-com/util-tool/bin/cli
            node node_modules/lodash/index.js
        """.trimIndent())

        val deps = Prepublish.scanShellScripts(pkg)
        assertTrue(deps.contains("@zerobias-com/util-tool"))
        assertTrue(deps.contains("lodash"))
    }

    @Test
    fun `scanShellScripts finds variable-based paths`(@TempDir tmp: Path) {
        val pkg = tmp.toFile()
        File(pkg, "scripts").mkdirs()
        File(pkg, "scripts/run.sh").writeText("""
            #!/bin/bash
            EXEC=${'$'}{NODE_MODULES_DIR}/@zerobias-com/hydra-schema-principal/bin/loader
            EXEC2=${'$'}NODE_MODULES_DIR/@zerobias-org/some-pkg/bin/cli
        """.trimIndent())

        val deps = Prepublish.scanShellScripts(pkg)
        assertTrue(deps.contains("@zerobias-com/hydra-schema-principal"))
        assertTrue(deps.contains("@zerobias-org/some-pkg"))
    }

    @Test
    fun `scanShellScripts finds standalone scoped names`(@TempDir tmp: Path) {
        val pkg = tmp.toFile()
        File(pkg, "scripts").mkdirs()
        // Note: regex consumes trailing whitespace, so two scoped pkgs with only
        // a single space between them only match the first. Use separate lines or
        // double-spacing to find both. This matches the JS regex behavior exactly.
        File(pkg, "scripts/loader.sh").writeText("""
            SCHEMAS="@zerobias-com/hydra-schema-principal
            @zerobias-com/hydra-schema-resource"
            echo @scope/foo
            echo @scope/bar
        """.trimIndent())

        val deps = Prepublish.scanShellScripts(pkg)
        assertTrue(deps.contains("@zerobias-com/hydra-schema-principal")) { "principal missing from $deps" }
        assertTrue(deps.contains("@zerobias-com/hydra-schema-resource")) { "resource missing from $deps" }
        assertTrue(deps.contains("@scope/foo")) { "foo missing from $deps" }
        assertTrue(deps.contains("@scope/bar")) { "bar missing from $deps" }
    }

    @Test
    fun `scanShellScripts finds npx invocations`(@TempDir tmp: Path) {
        val pkg = tmp.toFile()
        File(pkg, "scripts").mkdirs()
        File(pkg, "scripts/build.sh").writeText("""
            #!/bin/bash
            npx tsx build.ts
            npx @zerobias-com/codegen-tool generate
        """.trimIndent())

        val deps = Prepublish.scanShellScripts(pkg)
        assertTrue(deps.contains("tsx"))
        assertTrue(deps.contains("@zerobias-com/codegen-tool"))
    }

    @Test
    fun `scanShellScripts only scans src scripts and root sh files`(@TempDir tmp: Path) {
        val pkg = tmp.toFile()
        File(pkg, "src").mkdirs()
        File(pkg, "scripts").mkdirs()
        File(pkg, "other-dir").mkdirs()
        File(pkg, "src/in-src.sh").writeText("node node_modules/in-src-pkg/x")
        File(pkg, "scripts/in-scripts.sh").writeText("node node_modules/in-scripts-pkg/x")
        File(pkg, "root-level.sh").writeText("node node_modules/root-pkg/x")
        File(pkg, "other-dir/excluded.sh").writeText("node node_modules/other-dir-pkg/x")

        val deps = Prepublish.scanShellScripts(pkg)
        assertTrue(deps.contains("in-src-pkg"))
        assertTrue(deps.contains("in-scripts-pkg"))
        assertTrue(deps.contains("root-pkg"))
        assertFalse(deps.contains("other-dir-pkg")) { "other-dir should NOT be scanned" }
    }

    // ── extractScriptDependencies ────────────────────────────────────

    @Test
    fun `extractScriptDependencies finds npx with scoped pkg`() {
        val scripts = mapOf(
            "build" to "npx @zerobias-com/codegen run",
            "lint" to "npx eslint --fix .",
        )
        val binMap = mapOf("eslint" to "eslint")
        val deps = Prepublish.extractScriptDependencies(scripts, binMap)
        assertTrue(deps.contains("@zerobias-com/codegen"))
        assertTrue(deps.contains("eslint"))
    }

    @Test
    fun `extractScriptDependencies finds bin commands via binMap`() {
        val scripts = mapOf(
            "test" to "mocha --recursive test/",
            "tsc" to "tsc -b",
        )
        val binMap = mapOf("mocha" to "mocha", "tsc" to "typescript")
        val deps = Prepublish.extractScriptDependencies(scripts, binMap)
        assertTrue(deps.contains("mocha"))
        assertTrue(deps.contains("typescript")) { "tsc should resolve to typescript via binMap" }
    }

    @Test
    fun `extractScriptDependencies finds node_modules bin paths`() {
        val scripts = mapOf("clean" to "node_modules/.bin/rimraf dist/")
        val binMap = mapOf("rimraf" to "rimraf")
        val deps = Prepublish.extractScriptDependencies(scripts, binMap)
        assertTrue(deps.contains("rimraf"))
    }

    @Test
    fun `extractScriptDependencies handles node --import`() {
        val scripts = mapOf("test" to "node --import tsx/esm test/foo.test.ts")
        val deps = Prepublish.extractScriptDependencies(scripts, emptyMap())
        assertTrue(deps.contains("tsx"))
    }

    // ── scanYamlFiles ────────────────────────────────────────────────

    @Test
    fun `scanYamlFiles finds extends array form`(@TempDir tmp: Path) {
        val pkg = tmp.toFile()
        File(pkg, ".spectral.yaml").writeText("""
            extends:
              - "@stoplight/spectral-rules"
              - "@zerobias-com/spectral-config"
            rules:
              foo: warn
        """.trimIndent())

        val deps = Prepublish.scanYamlFiles(pkg)
        assertTrue(deps.contains("@stoplight/spectral-rules"))
        assertTrue(deps.contains("@zerobias-com/spectral-config"))
    }

    @Test
    fun `scanYamlFiles skips built-in references with colon`(@TempDir tmp: Path) {
        val pkg = tmp.toFile()
        File(pkg, ".spectral.yaml").writeText("""
            extends:
              - "spectral:oas"
              - "@real/pkg"
        """.trimIndent())

        val deps = Prepublish.scanYamlFiles(pkg)
        assertFalse(deps.contains("spectral")) { "spectral:oas is a built-in" }
        assertTrue(deps.contains("@real/pkg"))
    }

    // ── discoverBinMap ───────────────────────────────────────────────

    @Test
    fun `discoverBinMap reads single-string bin field`(@TempDir tmp: Path) {
        val root = tmp.toFile()
        val nm = File(root, "node_modules/some-tool")
        nm.mkdirs()
        File(nm, "package.json").writeText("""
            {"name": "some-tool", "bin": "./bin/cli.js"}
        """.trimIndent())

        val binMap = Prepublish.discoverBinMap(root)
        assertEquals("some-tool", binMap["some-tool"])
    }

    @Test
    fun `discoverBinMap reads object bin field with multiple commands`(@TempDir tmp: Path) {
        val root = tmp.toFile()
        val nm = File(root, "node_modules/multi-tool")
        nm.mkdirs()
        File(nm, "package.json").writeText("""
            {
              "name": "multi-tool",
              "bin": {
                "cmd-a": "./bin/a.js",
                "cmd-b": "./bin/b.js"
              }
            }
        """.trimIndent())

        val binMap = Prepublish.discoverBinMap(root)
        assertEquals("multi-tool", binMap["cmd-a"])
        assertEquals("multi-tool", binMap["cmd-b"])
    }

    @Test
    fun `discoverBinMap handles scoped packages`(@TempDir tmp: Path) {
        val root = tmp.toFile()
        val nm = File(root, "node_modules/@scope/scoped-tool")
        nm.mkdirs()
        File(nm, "package.json").writeText("""
            {"name": "@scope/scoped-tool", "bin": "./cli.js"}
        """.trimIndent())

        val binMap = Prepublish.discoverBinMap(root)
        // Scoped: command name is the part after the slash (without the scope)
        assertEquals("@scope/scoped-tool", binMap["scoped-tool"])
    }
}
