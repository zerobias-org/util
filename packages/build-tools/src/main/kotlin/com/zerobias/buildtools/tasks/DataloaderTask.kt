package com.zerobias.buildtools.tasks

import com.zerobias.buildtools.util.ZbbSlotProvider
import com.zerobias.buildtools.util.ExecUtils
import org.gradle.api.DefaultTask
import org.gradle.api.GradleException
import org.gradle.api.file.DirectoryProperty
import org.gradle.api.tasks.Input
import org.gradle.api.tasks.InputDirectory
import org.gradle.api.tasks.Optional
import org.gradle.api.tasks.TaskAction
import org.gradle.api.tasks.options.Option
import java.io.File

/**
 * Gradle task that wraps the platform `dataloader` CLI with slot SQL env injection.
 *
 * Reads PG connection from the active zbb slot and injects:
 *   PGHOST, PGPORT, PGUSER, PGPASSWORD, PGDATABASE
 *
 * Includes an up-to-date check: reads module name+version from package.json and
 * queries catalog.module_version. If the record already exists, the task is skipped.
 *
 * Usage in module build.gradle.kts:
 * ```kotlin
 * tasks.register<DataloaderTask>("dataloader") {
 *     packageDir.set(layout.projectDirectory)
 * }
 * ```
 *
 * Or run from root:
 * ```
 * ./gradlew :vendor:product:dataloader
 * ```
 */
abstract class DataloaderTask : DefaultTask() {

    /**
     * Directory containing the package to load (must have a package.json).
     * Defaults to the project directory.
     */
    @get:InputDirectory
    @get:Optional
    abstract val packageDir: DirectoryProperty

    /**
     * Additional args to pass through to the dataloader CLI.
     */
    @get:Input
    @get:Optional
    var extraArgs: List<String> = emptyList()

    init {
        group = "zerobias"
        description = "Load module artifacts into the local database via platform dataloader"
    }

    @TaskAction
    fun execute() {
        // Resolve package directory (default to project dir)
        val pkgDir: File = if (packageDir.isPresent) {
            packageDir.get().asFile
        } else {
            project.projectDir
        }

        // Read slot env for PG connection injection
        val slotEnv = ZbbSlotProvider.getSlotEnv()

        val pgHost = slotEnv["PGHOST"] ?: "localhost"
        val pgPort = slotEnv["PGPORT"] ?: "5432"
        val pgUser = slotEnv["PGUSER"] ?: "postgres"
        val pgPassword = slotEnv["PGPASSWORD"] ?: ""
        val pgDatabase = slotEnv["PGDATABASE"] ?: "zerobias"

        // Up-to-date check: query DB for existing module_version record
        val pkgJson = File(pkgDir, "package.json")
        if (pkgJson.exists()) {
            val (moduleName, moduleVersion) = readPackageNameVersion(pkgJson)
            if (moduleName != null && moduleVersion != null) {
                if (isAlreadyLoaded(moduleName, moduleVersion, pgHost, pgPort, pgUser, pgPassword, pgDatabase)) {
                    logger.lifecycle("DataloaderTask: $moduleName@$moduleVersion already loaded — UP-TO-DATE")
                    return
                }
            }
        }

        // Build environment with PG vars injected (slot wins for PG vars)
        val childEnv = buildEnv(slotEnv, pgHost, pgPort, pgUser, pgPassword, pgDatabase)

        // Build dataloader command: dataloader -d <packageDir> [extraArgs...]
        val cmd = mutableListOf("dataloader", "-d", pkgDir.absolutePath)
        cmd.addAll(extraArgs)

        logger.lifecycle("DataloaderTask: running ${cmd.joinToString(" ")}")

        ExecUtils.exec(
            command = cmd,
            workingDir = pkgDir,
            environment = childEnv,
            throwOnError = true,
            captureOutput = false
        )
    }

    // ── Internal ─────────────────────────────────────────────────────

    /**
     * Read `name` and `version` from package.json.
     * Returns (null, null) if the file cannot be parsed.
     */
    private fun readPackageNameVersion(pkgJson: File): Pair<String?, String?> {
        return try {
            val content = pkgJson.readText()
            val name = Regex(""""name"\s*:\s*"([^"]+)"""").find(content)?.groupValues?.get(1)
            val version = Regex(""""version"\s*:\s*"([^"]+)"""").find(content)?.groupValues?.get(1)
            name to version
        } catch (e: Exception) {
            logger.warn("DataloaderTask: could not read package.json: ${e.message}")
            null to null
        }
    }

    /**
     * Query catalog.module_version to determine if this module@version already exists.
     * Uses psql CLI with PG env vars. Returns false on any error (run dataloader to be safe).
     */
    private fun isAlreadyLoaded(
        moduleName: String,
        moduleVersion: String,
        pgHost: String,
        pgPort: String,
        pgUser: String,
        pgPassword: String,
        pgDatabase: String
    ): Boolean {
        return try {
            val sql = "SELECT id FROM catalog.module_version WHERE module_id = " +
                "(SELECT id FROM catalog.module WHERE key = '${moduleName.replace("'", "''")}') " +
                "AND version = '${moduleVersion.replace("'", "''")}' LIMIT 1;"
            val psqlEnv = mapOf(
                "PGPASSWORD" to pgPassword,
                "PGHOST" to pgHost,
                "PGPORT" to pgPort,
                "PGUSER" to pgUser,
                "PGDATABASE" to pgDatabase
            )
            val result = ExecUtils.execCapture(
                command = listOf("psql", "-t", "-c", sql),
                environment = psqlEnv,
                throwOnError = false
            )
            result.trim().isNotEmpty()
        } catch (e: Exception) {
            logger.warn("DataloaderTask: up-to-date check failed (${e.message}) — will run dataloader")
            false
        }
    }

    /**
     * Build the child process environment: current process env + slot PG vars on top.
     */
    private fun buildEnv(
        slotEnv: Map<String, String>,
        pgHost: String,
        pgPort: String,
        pgUser: String,
        pgPassword: String,
        pgDatabase: String
    ): Map<String, String> {
        val env = mutableMapOf<String, String>()
        // Start from current process env
        env.putAll(System.getenv())
        // Inject PG vars from slot
        env["PGHOST"] = pgHost
        env["PGPORT"] = pgPort
        env["PGUSER"] = pgUser
        env["PGPASSWORD"] = pgPassword
        env["PGDATABASE"] = pgDatabase
        // Inject NPM_TOKEN if present in slot
        slotEnv["NPM_TOKEN"]?.let { env["NPM_TOKEN"] = it }
        return env
    }
}
