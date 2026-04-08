package com.zerobias.buildtools.monorepo

import com.fasterxml.jackson.core.util.DefaultIndenter
import com.fasterxml.jackson.core.util.DefaultPrettyPrinter
import com.fasterxml.jackson.core.util.Separators
import com.fasterxml.jackson.databind.ObjectMapper
import com.fasterxml.jackson.databind.SerializationFeature
import com.fasterxml.jackson.module.kotlin.readValue
import com.fasterxml.jackson.module.kotlin.registerKotlinModule
import java.io.File

/**
 * Kotlin port of `org/devops/tools/scripts/prepublish-standalone.js`.
 *
 * Prepares a workspace package for standalone publishing by:
 * 1. Scanning source files (TS/JS), shell scripts, npm scripts, config files,
 *    and YAML files for package references
 * 2. Resolving each reference against root `package.json` dependencies +
 *    devDependencies + workspace package versions
 * 3. Writing a modified `package.json` to the package dir (or `--target-dir`)
 *    with the resolved dependency set, sorted alphabetically, no devDependencies,
 *    plus root overrides copied verbatim
 *
 * **Parity contract:** the output must be byte-identical to what the bash/JS
 * script writes for the same input. This is enforced by fixture-based parity
 * tests in `PrepublishParityTest`.
 *
 * Used by:
 * - `zb.monorepo-publish` plugin (via PrepublishTask) — full publish flow
 * - `zb.monorepo-gate` plugin (via writeGateStamp) — `resolveRootDeps()` for
 *   the gate stamp's rootDeps snapshot (--dry-run equivalent, no file writes)
 *
 * **NOT used by:** the per-project `zb.base.gradle.kts` flow (which serves
 * `auditlogic/module-gradle` consumers and has its own publish path).
 */
object Prepublish {

    private const val BACKUP_SUFFIX = ".prepublish-backup"

    // ── Static constants (match prepublish-standalone.js) ────────────

    /** Manual overrides for bin → package mappings. Currently empty in JS. */
    private val BIN_PACKAGE_OVERRIDES: Map<String, String> = emptyMap()

    /** Packages that look like real deps but should be ignored (false positives). */
    private val IGNORED_PACKAGES = setOf(
        "src", "dist", "test", "scripts", "node", "bin", "sdk", "api", "lib", "generated",
    )

    /** Hardcoded additional deps required at runtime by codegen templates. */
    private val PACKAGE_ADDITIONAL_DEPS: Map<String, List<String>> = mapOf(
        "@zerobias-org/util-api-client-base" to listOf("qs"),
    )

    /** Node.js builtin modules that must NEVER appear in published deps. */
    private val NODE_BUILTINS = setOf(
        "fs", "path", "http", "https", "crypto", "stream", "url", "util", "os",
        "child_process", "events", "assert", "buffer", "net", "tls", "dns",
        "readline", "zlib",
    )

    // ── Public API ───────────────────────────────────────────────────

    data class Options(
        val dryRun: Boolean = false,
        val restore: Boolean = false,
        val includeBuildTools: Boolean = false,
        val targetDir: File? = null,
    )

    /**
     * Result of a `resolve()` call.
     *
     * - `dependencies` is the final sorted dep map written to the output file
     * - `overrides` is copied verbatim from root `package.json`
     * - `addedDeps` lists deps that were newly added (for the report)
     * - `missingDeps` lists scanned packages NOT found in root (warnings)
     */
    data class Result(
        val dependencies: Map<String, String>,
        val overrides: Map<String, Any?>,
        val addedDeps: List<String>,
        val missingDeps: List<String>,
        val outputPath: File,
    )

    /**
     * Run prepublish on a package.
     *
     * In `--dry-run` mode: returns the Result without modifying any files.
     * In normal mode: writes the modified package.json (with backup) and returns the Result.
     * In `--restore` mode: restores from backup (if present) and returns an empty Result.
     */
    fun resolve(serviceDir: File, rootDir: File, options: Options = Options()): Result {
        val servicePackageJsonPath = File(serviceDir, "package.json")
        val outputPackageJsonPath = options.targetDir
            ?.let { File(it, "package.json") }
            ?: servicePackageJsonPath

        if (options.restore) {
            restoreBackup(outputPackageJsonPath)
            return emptyResult(outputPackageJsonPath)
        }

        // Read root package.json
        val rootPackageJsonPath = File(rootDir, "package.json")
        val rootPackageJson = readJson(rootPackageJsonPath)
        val rootDeps = stringMapField(rootPackageJson, "dependencies")
        val rootDevDeps = stringMapField(rootPackageJson, "devDependencies")
        val rootOverrides = mapField(rootPackageJson, "overrides")

        // Build workspace map: package name → version, and name → full package.json
        val workspacePackages = mutableMapOf<String, String>()
        val workspacePackageJsons = mutableMapOf<String, Map<String, Any?>>()
        val workspaces = listField<String>(rootPackageJson, "workspaces")
        for (ws in workspaces) {
            val wsPath = File(rootDir, "$ws/package.json")
            if (!wsPath.exists()) continue
            try {
                val wsPkg = readJson(wsPath)
                val name = wsPkg["name"] as? String ?: continue
                val version = wsPkg["version"] as? String ?: continue
                workspacePackages[name] = version
                workspacePackageJsons[name] = wsPkg
            } catch (_: Exception) { /* skip unparseable */ }
        }

        // Read service package.json (the source for scanning)
        val servicePackageJson = readJson(servicePackageJsonPath)
        val outputPackageJson: MutableMap<String, Any?> = if (options.targetDir != null && outputPackageJsonPath.exists()) {
            // ng-packagr style: merge into existing target
            readJson(outputPackageJsonPath).toMutableMap()
        } else {
            servicePackageJson.toMutableMap()
        }

        // Determine if build tools are skipped (default: yes, unless flag or import-artifact: service)
        @Suppress("UNCHECKED_CAST")
        val zerobias = servicePackageJson["zerobias"] as? Map<String, Any?>
        val importArtifact = zerobias?.get("import-artifact") as? String
        val skipBuildTools = !options.includeBuildTools && importArtifact != "service"

        // ── Scan all sources ──
        val scannedImports = scanImports(serviceDir)

        // Shell scripts: scanned if NOT skipping build tools, OR if files-array contains *.sh
        val filesArray = listField<String>(servicePackageJson, "files")
        val hasShellInFiles = filesArray.any { f -> f.endsWith(".sh") || f == "*.sh" || f.contains("*.sh") }
        val shellDeps = if (!skipBuildTools || hasShellInFiles) scanShellScripts(serviceDir) else emptySet()

        // Script dependencies: only when NOT skipping build tools
        val scriptDeps = if (!skipBuildTools) {
            val binMap = discoverBinMap(rootDir)
            extractScriptDependencies(mapField(servicePackageJson, "scripts"), binMap)
        } else emptySet()

        // YAML extends scanning (always runs)
        val yamlDeps = scanYamlFiles(serviceDir)

        // Config file scanning (always runs — eslint/prettier configs)
        val configDeps = scanConfigFiles(serviceDir)

        // Existing service dependencies (preserved)
        val existingDeps = buildMap<String, String> {
            putAll(stringMapField(servicePackageJson, "dependencies"))
            if (options.targetDir != null) {
                putAll(stringMapField(outputPackageJson, "dependencies"))
            }
        }

        // ── Build the requiredDeps set ──
        val requiredDeps = mutableSetOf<String>()
        requiredDeps.addAll(scannedImports)
        requiredDeps.addAll(shellDeps)
        requiredDeps.addAll(scriptDeps)
        requiredDeps.addAll(yamlDeps)
        requiredDeps.addAll(configDeps)
        requiredDeps.addAll(existingDeps.keys)

        // Implicit deps based on package name patterns
        val packageName = servicePackageJson["name"] as? String ?: ""
        if (packageName.contains("eslint-config")) {
            requiredDeps.addAll(listOf(
                "eslint",
                "@typescript-eslint/eslint-plugin",
                "@typescript-eslint/parser",
                "eslint-plugin-unicorn",
            ))
        }
        if (packageName.contains("prettier-config")) {
            requiredDeps.add("prettier")
        }

        // Hardcoded additional deps for specific packages
        PACKAGE_ADDITIONAL_DEPS[packageName]?.let { requiredDeps.addAll(it) }

        // Workspace transitive expansion: if a required dep IS a workspace pkg,
        // pull in its transitive dependencies recursively
        val transitiveDeps = mutableSetOf<String>()
        for (pkg in requiredDeps.toSet()) {
            if (workspacePackageJsons.containsKey(pkg)) {
                transitiveDeps.addAll(getWorkspaceTransitiveDeps(pkg, workspacePackageJsons))
            }
        }
        requiredDeps.addAll(transitiveDeps)

        // ── Resolve each required dep ──
        val newDependencies = mutableMapOf<String, String>()
        val addedDeps = mutableListOf<String>()
        val missingDeps = mutableListOf<String>()

        for (pkg in requiredDeps) {
            // Skip ignored packages
            if (pkg in IGNORED_PACKAGES) continue
            // Skip self
            if (pkg == packageName) continue

            // 1. Workspace package?
            workspacePackages[pkg]?.let { version ->
                newDependencies[pkg] = version
                if (!existingDeps.containsKey(pkg)) addedDeps.add("$pkg@$version (workspace)")
                return@let
            }
            if (newDependencies.containsKey(pkg)) continue

            // 2. Root deps?
            rootDeps[pkg]?.let { version ->
                newDependencies[pkg] = version
                if (!existingDeps.containsKey(pkg)) addedDeps.add("$pkg@$version")
                return@let
            }
            if (newDependencies.containsKey(pkg)) continue

            // 3. Root devDeps?
            rootDevDeps[pkg]?.let { version ->
                newDependencies[pkg] = version
                if (!existingDeps.containsKey(pkg)) addedDeps.add("$pkg@$version (dev)")
                return@let
            }
            if (newDependencies.containsKey(pkg)) continue

            // 4. Node.js builtin?
            if (pkg in NODE_BUILTINS) continue

            // 5. Existing service dep?
            existingDeps[pkg]?.let { version ->
                newDependencies[pkg] = version
                return@let
            }
            if (newDependencies.containsKey(pkg)) continue

            // 6. Missing
            missingDeps.add(pkg)
        }

        // Sort dependencies alphabetically (matches JS Object.keys().sort())
        val sortedDependencies = newDependencies.toSortedMap()

        if (options.dryRun) {
            return Result(
                dependencies = sortedDependencies,
                overrides = rootOverrides,
                addedDeps = addedDeps,
                missingDeps = missingDeps,
                outputPath = outputPackageJsonPath,
            )
        }

        // Write the modified package.json (with backup if not target-dir mode)
        if (options.targetDir == null) {
            createBackup(servicePackageJsonPath)
        }

        outputPackageJson["dependencies"] = sortedDependencies
        outputPackageJson.remove("devDependencies")
        if (rootOverrides.isNotEmpty()) {
            outputPackageJson["overrides"] = rootOverrides
        }

        writeJson(outputPackageJsonPath, outputPackageJson)

        return Result(
            dependencies = sortedDependencies,
            overrides = rootOverrides,
            addedDeps = addedDeps,
            missingDeps = missingDeps,
            outputPath = outputPackageJsonPath,
        )
    }

    /**
     * Resolve which root deps + overrides this package uses, without writing
     * any files. Used by the gate stamp's rootDeps snapshot. Equivalent to
     * `resolve(... dryRun=true)` followed by extracting the resolved set.
     *
     * Override values are stored as `JSON.stringify(value)` to preserve type
     * information for the rootDeps drift check (matches TS GateStamp.ts).
     */
    fun resolveRootDeps(serviceDir: File, rootDir: File): Map<String, String> {
        val result = resolve(serviceDir, rootDir, Options(dryRun = true))
        val rootPkg = readJson(File(rootDir, "package.json"))
        val rootDeps = stringMapField(rootPkg, "dependencies")
        val rootDevDeps = stringMapField(rootPkg, "devDependencies")
        val rootOverrides = mapField(rootPkg, "overrides")
        val allRootDeps = rootDeps + rootDevDeps

        val resolved = linkedMapOf<String, String>()
        // Resolved deps that came from root (not workspace)
        for ((name, version) in result.dependencies) {
            if (allRootDeps[name] == version) {
                resolved[name] = version
            }
        }
        // Plus overrides (always included as JSON-stringified values)
        for ((name, value) in rootOverrides) {
            resolved[name] = jsonStringifyValue(value)
        }
        return resolved
    }

    // ── Scanners ─────────────────────────────────────────────────────

    private val FROM_REGEX = Regex("""\bfrom\s+['"]([^'"]+)['"]""")
    private val BARE_IMPORT_REGEX = Regex("""\bimport\s+['"]([^'"]+)['"]""")
    private val REQUIRE_REGEX = Regex("""\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)""")

    private val IMPORT_FILE_EXTENSIONS = listOf(".ts", ".js", ".mts", ".mjs")
    private val IMPORT_SKIP_DIRS = setOf("node_modules", "dist", ".git", "coverage", "test", "tests", "__tests__")

    /**
     * Scan TS/JS source files for `import`/`require` statements.
     * Returns the set of distinct package names referenced.
     */
    fun scanImports(serviceDir: File): Set<String> {
        val imports = mutableSetOf<String>()
        scanDirectoryForFiles(serviceDir, IMPORT_FILE_EXTENSIONS, IMPORT_SKIP_DIRS) { file ->
            val content = file.readText()
            for (match in FROM_REGEX.findAll(content)) {
                extractPackageName(match.groupValues[1])?.let { imports.add(it) }
            }
            for (match in BARE_IMPORT_REGEX.findAll(content)) {
                extractPackageName(match.groupValues[1])?.let { imports.add(it) }
            }
            for (match in REQUIRE_REGEX.findAll(content)) {
                extractPackageName(match.groupValues[1])?.let { imports.add(it) }
            }
        }

        // Also scan files listed in package.json `files` array (root-level JS entry points)
        val pkgFile = File(serviceDir, "package.json")
        if (pkgFile.exists()) {
            try {
                val pkg = readJson(pkgFile)
                val filesArray = listField<String>(pkg, "files")
                for (filePattern in filesArray) {
                    if (IMPORT_FILE_EXTENSIONS.any { filePattern.endsWith(it) }) {
                        val f = File(serviceDir, filePattern)
                        if (f.exists() && f.isFile) {
                            val content = f.readText()
                            for (match in FROM_REGEX.findAll(content)) extractPackageName(match.groupValues[1])?.let { imports.add(it) }
                            for (match in BARE_IMPORT_REGEX.findAll(content)) extractPackageName(match.groupValues[1])?.let { imports.add(it) }
                            for (match in REQUIRE_REGEX.findAll(content)) extractPackageName(match.groupValues[1])?.let { imports.add(it) }
                        }
                    }
                }
                val main = pkg["main"] as? String
                if (main != null && IMPORT_FILE_EXTENSIONS.any { main.endsWith(it) }) {
                    val f = File(serviceDir, main)
                    if (f.exists() && f.isFile) {
                        val content = f.readText()
                        for (match in FROM_REGEX.findAll(content)) extractPackageName(match.groupValues[1])?.let { imports.add(it) }
                        for (match in BARE_IMPORT_REGEX.findAll(content)) extractPackageName(match.groupValues[1])?.let { imports.add(it) }
                        for (match in REQUIRE_REGEX.findAll(content)) extractPackageName(match.groupValues[1])?.let { imports.add(it) }
                    }
                }
            } catch (_: Exception) { /* ignore parse errors */ }
        }

        return imports
    }

    /**
     * Extract a package name from an import path.
     * Returns null for relative paths and node: protocol imports.
     */
    private fun extractPackageName(importPath: String): String? {
        if (importPath.startsWith(".") || importPath.startsWith("/")) return null
        if (importPath.startsWith("node:")) return null
        return if (importPath.startsWith("@")) {
            val parts = importPath.split("/")
            if (parts.size < 2) null else "${parts[0]}/${parts[1]}"
        } else {
            importPath.split("/")[0]
        }
    }

    // Shell script scanning regexes (case-insensitive)
    private val NODE_MODULES_REGEX = Regex("""node_modules/(@[a-z0-9][-a-z0-9]*/[a-z0-9][-a-z0-9._]*|[a-z0-9][-a-z0-9._]*)""", RegexOption.IGNORE_CASE)
    private val VAR_PATH_REGEX = Regex("""\$\{?[A-Z_]+}?/(@[a-z0-9][-a-z0-9]*/[a-z0-9][-a-z0-9._]*)""", RegexOption.IGNORE_CASE)
    private val SCOPED_PKG_REGEX = Regex("""(?:^|[\s"'])(@[a-z0-9][-a-z0-9]*/[a-z0-9][-a-z0-9._]*)(?:[\s"'\n]|$)""", setOf(RegexOption.IGNORE_CASE, RegexOption.MULTILINE))
    private val NPX_REGEX = Regex("""npx\s+(?:node\s+)?(?:\$[A-Z_]+/)?(?:node_modules/)?(@[a-z0-9][-a-z0-9]*/[a-z0-9][-a-z0-9._]*|[a-z][a-z0-9-]*)""", RegexOption.IGNORE_CASE)

    /**
     * Scan shell scripts for package references.
     */
    fun scanShellScripts(serviceDir: File): Set<String> {
        val packages = mutableSetOf<String>()
        val toScan = mutableListOf<File>()

        // src/, scripts/, and root-level .sh files
        listOf("src", "scripts").forEach { sub ->
            val dir = File(serviceDir, sub)
            if (dir.exists()) {
                dir.walkTopDown().filter { it.isFile && it.name.endsWith(".sh") }.forEach { toScan.add(it) }
            }
        }
        serviceDir.listFiles { f -> f.isFile && f.name.endsWith(".sh") }?.forEach { toScan.add(it) }

        for (file in toScan) {
            val content = try { file.readText() } catch (_: Exception) { continue }
            for (match in NODE_MODULES_REGEX.findAll(content)) {
                val pkg = match.groupValues[1].lowercase()
                if (isValidPackageName(pkg)) packages.add(pkg)
            }
            for (match in VAR_PATH_REGEX.findAll(content)) {
                val pkg = match.groupValues[1].lowercase()
                if (isValidPackageName(pkg)) packages.add(pkg)
            }
            for (match in SCOPED_PKG_REGEX.findAll(content)) {
                val pkg = match.groupValues[1].lowercase()
                if (isValidPackageName(pkg)) packages.add(pkg)
            }
            for (match in NPX_REGEX.findAll(content)) {
                val pkg = match.groupValues[1].lowercase()
                if (isValidPackageName(pkg)) packages.add(pkg)
            }
        }

        return packages
    }

    /**
     * Extract package dependencies from npm script commands.
     * Looks for npx invocations, node_modules/.bin paths, leading bin commands,
     * and `node --import` patterns.
     */
    fun extractScriptDependencies(scripts: Map<String, Any?>, binMap: Map<String, String>): Set<String> {
        val deps = mutableSetOf<String>()

        for ((_, scriptCmdRaw) in scripts) {
            val scriptCmd = scriptCmdRaw as? String ?: continue
            // Split on common command separators
            val parts = scriptCmd.split(';', '&', '|')
            for (part in parts) {
                val trimmed = part.trim()

                // npx <pkg>
                Regex("""npx\s+(?:--[^\s]+\s+)*([^\s]+)""").find(trimmed)?.let { m ->
                    val pkg = m.groupValues[1]
                    if (!pkg.startsWith("-") && !pkg.startsWith(".")) {
                        when {
                            binMap.containsKey(pkg) -> deps.add(binMap[pkg]!!)
                            pkg.startsWith("@") -> {
                                val parts2 = pkg.split("/")
                                if (parts2.size >= 2) deps.add("${parts2[0]}/${parts2[1]}")
                            }
                            else -> deps.add(pkg.split("/")[0])
                        }
                    }
                }

                // node_modules/.bin/<tool>
                Regex("""node_modules/\.bin/([^\s]+)""").find(trimmed)?.let { m ->
                    binMap[m.groupValues[1]]?.let { deps.add(it) }
                }

                // Leading tool name (camelCase or kebab)
                Regex("""^([a-zA-Z][-a-zA-Z0-9]*)""").find(trimmed)?.let { m ->
                    binMap[m.groupValues[1]]?.let { deps.add(it) }
                }

                // node --import <pkg>
                Regex("""node\s+--import\s+([^\s/]+)""").find(trimmed)?.also { m ->
                    val pkg = m.groupValues[1]
                    if (pkg.startsWith("@")) {
                        val parts2 = pkg.split("/")
                        if (parts2.size >= 2) {
                            deps.add("${parts2[0]}/${parts2[1]}")
                        }
                    } else {
                        deps.add(pkg.split("/")[0])
                    }
                }
            }
        }

        return deps
    }

    private val CONFIG_FILE_PATTERNS = listOf(
        "eslint.config.js", "eslint.config.mjs", "eslint.config.cjs",
        ".eslintrc.js", ".eslintrc.cjs", ".eslintrc.mjs",
        "prettier.config.js", "prettier.config.mjs",
        ".prettierrc.js", ".prettierrc.cjs",
    )

    /**
     * Scan eslint/prettier config files for package imports.
     */
    fun scanConfigFiles(serviceDir: File): Set<String> {
        val imports = mutableSetOf<String>()
        for (pattern in CONFIG_FILE_PATTERNS) {
            val file = File(serviceDir, pattern)
            if (!file.exists()) continue
            try {
                val content = file.readText()
                for (match in FROM_REGEX.findAll(content)) {
                    extractPackageName(match.groupValues[1])?.let { imports.add(it) }
                }
                for (match in BARE_IMPORT_REGEX.findAll(content)) {
                    extractPackageName(match.groupValues[1])?.let { imports.add(it) }
                }
                for (match in REQUIRE_REGEX.findAll(content)) {
                    extractPackageName(match.groupValues[1])?.let { imports.add(it) }
                }
            } catch (_: Exception) { /* ignore */ }
        }
        return imports
    }

    private val EXTENDS_ARRAY_REGEX = Regex("""extends:\s*\n((?:\s+-\s+["']?[^\n]+["']?\n?)+)""", RegexOption.IGNORE_CASE)
    private val EXTENDS_ARRAY_ITEM_REGEX = Regex("""-\s+["']?([^"'\n]+)["']?""", RegexOption.IGNORE_CASE)
    private val EXTENDS_SINGLE_REGEX = Regex("""extends:\s+["'](@?[a-z0-9][-a-z0-9._]*(?:/[a-z0-9][-a-z0-9._]*)?)["']""", RegexOption.IGNORE_CASE)

    /**
     * Scan YAML files for `extends:` directives that reference npm packages.
     */
    fun scanYamlFiles(serviceDir: File): Set<String> {
        val packages = mutableSetOf<String>()
        val skipDirs = setOf("node_modules", "dist", ".git", "coverage")

        scanDirectoryForFiles(
            root = serviceDir,
            extensions = listOf(".yml", ".yaml"),
            skipDirs = skipDirs,
        ) { file ->
            val content = file.readText()

            // Array form
            for (match in EXTENDS_ARRAY_REGEX.findAll(content)) {
                val arrayContent = match.groupValues[1]
                for (itemMatch in EXTENDS_ARRAY_ITEM_REGEX.findAll(arrayContent)) {
                    val rawValue = itemMatch.groupValues[1].trim()
                    if (rawValue.contains(":")) continue
                    if (rawValue.startsWith(".") || rawValue.startsWith("/")) continue
                    val pkg = if (rawValue.startsWith("@")) {
                        val parts = rawValue.split("/")
                        if (parts.size >= 2) "${parts[0]}/${parts[1]}" else continue
                    } else {
                        rawValue.split("/")[0]
                    }
                    if (isValidPackageName(pkg)) packages.add(pkg)
                }
            }

            // Single string form
            for (match in EXTENDS_SINGLE_REGEX.findAll(content)) {
                val pkg = match.groupValues[1]
                if (pkg.contains(":")) continue
                if (pkg.startsWith(".") || pkg.startsWith("/")) continue
                if (isValidPackageName(pkg)) packages.add(pkg)
            }
        }

        return packages
    }

    // ── Bin map discovery ────────────────────────────────────────────

    /**
     * Walk node_modules and build a map of bin command name → package name.
     * Reads each package's `bin` field (string or object).
     */
    fun discoverBinMap(rootDir: File): Map<String, String> {
        val binMap = mutableMapOf<String, String>()
        val nodeModulesDir = File(rootDir, "node_modules")
        if (!nodeModulesDir.exists()) return binMap

        fun processPackage(pkgDir: File, packageName: String) {
            val pkgJsonFile = File(pkgDir, "package.json")
            if (!pkgJsonFile.exists()) return
            try {
                val pkgJson = readJson(pkgJsonFile)
                when (val bin = pkgJson["bin"]) {
                    is String -> {
                        // Single bin: command name = package name without scope
                        val cmdName = if (packageName.startsWith("@")) {
                            packageName.split("/").getOrNull(1) ?: packageName
                        } else {
                            packageName
                        }
                        binMap[cmdName] = packageName
                    }
                    is Map<*, *> -> {
                        for (key in bin.keys) {
                            (key as? String)?.let { binMap[it] = packageName }
                        }
                    }
                    else -> { /* no bin */ }
                }
            } catch (_: Exception) { /* skip unparseable */ }
        }

        nodeModulesDir.listFiles()?.forEach { entry ->
            if (!entry.isDirectory || entry.name.startsWith(".")) return@forEach
            if (entry.name.startsWith("@")) {
                // Scoped package: walk @scope/* subdirectories
                entry.listFiles()?.forEach { scopeEntry ->
                    if (scopeEntry.isDirectory) {
                        processPackage(scopeEntry, "${entry.name}/${scopeEntry.name}")
                    }
                }
            } else {
                processPackage(entry, entry.name)
            }
        }

        // Apply overrides
        for ((cmd, pkg) in BIN_PACKAGE_OVERRIDES) binMap[cmd] = pkg

        return binMap
    }

    // ── Workspace transitive expansion ───────────────────────────────

    private fun getWorkspaceTransitiveDeps(
        packageName: String,
        workspacePackageJsons: Map<String, Map<String, Any?>>,
        visited: MutableSet<String> = mutableSetOf(),
    ): Set<String> {
        if (packageName in visited) return emptySet()
        visited.add(packageName)
        val pkgJson = workspacePackageJsons[packageName] ?: return emptySet()
        val deps = mutableSetOf<String>()
        val pkgDeps = stringMapField(pkgJson, "dependencies")
        for (depName in pkgDeps.keys) {
            deps.add(depName)
            if (workspacePackageJsons.containsKey(depName)) {
                deps.addAll(getWorkspaceTransitiveDeps(depName, workspacePackageJsons, visited))
            }
        }
        return deps
    }

    // ── Validation helpers ───────────────────────────────────────────

    private val SCOPE_REGEX = Regex("""^[a-z0-9][-a-z0-9]*$""")
    private val UNSCOPED_REGEX = Regex("""^[a-z0-9][-a-z0-9._]*$""")
    private val SCOPED_NAME_REGEX = Regex("""^[a-z0-9][-a-z0-9._]*$""")

    fun isValidPackageName(name: String?): Boolean {
        if (name.isNullOrEmpty()) return false
        if (name.startsWith(".") || name.startsWith("-") || name.startsWith("$")) return false
        if (name.any { it in "\"';|&=[](){}"  }) return false
        if (name.startsWith("@")) {
            val parts = name.split("/")
            if (parts.size != 2) return false
            val scope = parts[0].substring(1)
            val pkg = parts[1]
            return SCOPE_REGEX.matches(scope) && SCOPED_NAME_REGEX.matches(pkg)
        }
        return UNSCOPED_REGEX.matches(name)
    }

    // ── Backup / Restore ─────────────────────────────────────────────

    private fun createBackup(packageJsonPath: File) {
        val backupPath = File(packageJsonPath.parentFile, packageJsonPath.name + BACKUP_SUFFIX)
        if (!backupPath.exists()) {
            packageJsonPath.copyTo(backupPath, overwrite = false)
        }
    }

    private fun restoreBackup(packageJsonPath: File): Boolean {
        val backupPath = File(packageJsonPath.parentFile, packageJsonPath.name + BACKUP_SUFFIX)
        if (!backupPath.exists()) return false
        backupPath.copyTo(packageJsonPath, overwrite = true)
        backupPath.delete()
        return true
    }

    private fun emptyResult(outputPath: File) = Result(
        dependencies = emptyMap(),
        overrides = emptyMap(),
        addedDeps = emptyList(),
        missingDeps = emptyList(),
        outputPath = outputPath,
    )

    // ── JSON helpers ─────────────────────────────────────────────────

    private val mapper: ObjectMapper = ObjectMapper().registerKotlinModule().apply {
        val indenter = DefaultIndenter("  ", "\n")
        val separators = Separators.createDefaultInstance()
            .withObjectFieldValueSpacing(Separators.Spacing.AFTER)
        val printer = DefaultPrettyPrinter()
            .withSeparators(separators)
            .also { it.indentObjectsWith(indenter) }
            .also { it.indentArraysWith(indenter) }
        setDefaultPrettyPrinter(printer)
        enable(SerializationFeature.INDENT_OUTPUT)
    }

    private fun readJson(file: File): MutableMap<String, Any?> {
        return mapper.readValue(file)
    }

    private fun writeJson(file: File, value: Map<String, Any?>) {
        val json = mapper.writeValueAsString(value)
        file.writeText(json + "\n")
    }

    @Suppress("UNCHECKED_CAST")
    private fun stringMapField(json: Map<String, Any?>, key: String): Map<String, String> {
        val raw = json[key] as? Map<String, Any?> ?: return emptyMap()
        return raw.mapNotNull { (k, v) -> if (v is String) k to v else null }.toMap()
    }

    @Suppress("UNCHECKED_CAST")
    private fun mapField(json: Map<String, Any?>, key: String): Map<String, Any?> {
        return (json[key] as? Map<String, Any?>) ?: emptyMap()
    }

    @Suppress("UNCHECKED_CAST")
    private fun <T> listField(json: Map<String, Any?>, key: String): List<T> {
        return (json[key] as? List<T>) ?: emptyList()
    }

    /**
     * Match JS `JSON.stringify(value)` for any value.
     */
    private fun jsonStringifyValue(value: Any?): String {
        // Use a non-pretty mapper for compact JSON.stringify equivalent
        return ObjectMapper().registerKotlinModule().writeValueAsString(value)
    }

    // ── File walking ─────────────────────────────────────────────────

    private fun scanDirectoryForFiles(
        root: File,
        extensions: List<String>,
        skipDirs: Set<String>,
        action: (File) -> Unit,
    ) {
        if (!root.exists()) return
        // Only skip subdirectories whose name is in skipDirs — never skip the
        // root directory itself even if its name matches (e.g. a package named
        // "test/"). Mirrors the JS scanDirectory which only checks names of
        // child entries, not the starting directory.
        root.walkTopDown()
            .onEnter { dir -> dir == root || dir.name !in skipDirs }
            .filter { it.isFile && extensions.any { ext -> it.name.endsWith(ext) } }
            .forEach { file ->
                try {
                    action(file)
                } catch (_: Exception) { /* ignore unreadable files */ }
            }
    }
}
