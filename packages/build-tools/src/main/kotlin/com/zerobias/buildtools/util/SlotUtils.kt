package com.zerobias.buildtools.util

import org.gradle.api.GradleException
import org.gradle.api.Project
import java.io.File

/**
 * Utilities for managing slot directories and configuration.
 *
 * Slots are isolated environments for E2E testing, stored in ~/.zerobias/slots/
 * Each slot contains:
 * - .env - Complete environment variables for all services
 * - connect.env - Minimal user-facing connection variables
 * - state.json - Stack state (running/stopped)
 * - .keys/ - JWT keys, SSL certs, etc.
 */
object SlotUtils {
    /**
     * Get the slot directory for a given slot name.
     *
     * @param slotName Name of the slot (e.g., "local", "dev", "e2e-20260212-161000")
     * @return File pointing to ~/.zerobias/slots/{slotName}/
     */
    fun getSlotDir(slotName: String): File {
        val zbHome = File(System.getProperty("user.home"), ".zerobias")
        val slotsDir = File(zbHome, "slots")
        return File(slotsDir, slotName)
    }

    /**
     * Get the slots directory.
     *
     * @return File pointing to ~/.zerobias/slots/
     */
    fun getSlotsDir(): File {
        val zbHome = File(System.getProperty("user.home"), ".zerobias")
        return File(zbHome, "slots").also { it.mkdirs() }
    }

    /**
     * Load slot environment variables from .env file.
     *
     * @param slotName Name of the slot
     * @return Map of environment variable name to value
     * @throws IllegalStateException if slot doesn't exist
     */
    fun loadSlotEnv(slotName: String): Map<String, String> {
        val slotDir = getSlotDir(slotName)
        val envFile = File(slotDir, ".env")

        if (!envFile.exists()) {
            throw IllegalStateException("Slot not initialized: $slotName. .env file not found at ${envFile.absolutePath}")
        }

        return envFile.readLines()
            .filter { it.isNotBlank() && !it.trimStart().startsWith("#") }
            .mapNotNull {
                val parts = it.split("=", limit = 2)
                if (parts.size == 2) parts[0].trim() to parts[1].trim() else null
            }
            .toMap()
    }

    /**
     * Update slot environment variables in .env file.
     *
     * @param slotName Name of the slot
     * @param updates Map of variable names to new values
     * @param preserveAll If true, preserve all existing variables. If false, only preserve updated ones.
     */
    fun updateSlotEnv(slotName: String, updates: Map<String, String>, preserveAll: Boolean = true) {
        val slotDir = getSlotDir(slotName)
        val envFile = File(slotDir, ".env")

        if (!envFile.exists()) {
            throw IllegalStateException("Slot not initialized: $slotName")
        }

        if (preserveAll) {
            // Read existing lines, update matching vars
            val envLines = envFile.readLines().toMutableList()
            updates.forEach { (varName, newValue) ->
                val lineIndex = envLines.indexOfFirst { it.startsWith("$varName=") }
                if (lineIndex >= 0) {
                    envLines[lineIndex] = "$varName=$newValue"
                } else {
                    // Add new variable
                    envLines.add("$varName=$newValue")
                }
            }
            envFile.writeText(envLines.joinToString("\n"))
        } else {
            // Replace entire file with updates only
            val content = updates.entries.joinToString("\n") { (k, v) -> "$k=$v" }
            envFile.writeText(content)
        }
    }

    /**
     * Check if a slot name represents an ephemeral slot.
     *
     * Ephemeral slots start with "e2e-" and are auto-cleaned up after tests.
     *
     * @param slotName Name of the slot
     * @return true if ephemeral, false if persistent
     */
    fun isEphemeralSlot(slotName: String): Boolean {
        return slotName.startsWith("e2e-")
    }

    /**
     * Check if a slot exists.
     *
     * @param slotName Name of the slot
     * @return true if slot directory exists
     */
    fun slotExists(slotName: String): Boolean {
        return getSlotDir(slotName).exists()
    }

    /**
     * Validate that all -P properties passed to the build are recognized.
     * Catches typos like -Pslots=local (should be -Pslot=local) at task start
     * instead of silently falling through.
     *
     * @param project The Gradle project
     * @param recognized Set of property names this build file accepts (e.g., "slot", "preserve")
     * @throws GradleException if unrecognized properties are found
     */
    fun validateProjectProperties(project: Project, recognized: Set<String>) {
        // startParameter.projectProperties contains ONLY explicit -P flags from the command line,
        // excluding Gradle internals, plugin extensions, task names, etc.
        val cliProps = project.gradle.startParameter.projectProperties.keys

        val unknown = cliProps.filter { it !in recognized }

        if (unknown.isNotEmpty()) {
            throw GradleException(
                "Unrecognized project properties: ${unknown.joinToString(", ") { "-P$it" }}\n" +
                "Valid properties: ${recognized.joinToString(", ") { "-P$it" }}"
            )
        }
    }

    /**
     * Register property validation that runs before any task executes, but only
     * when a stack task is in the task graph. Call this at configuration time
     * (top-level in build.gradle.kts).
     *
     * Usage:
     *   SlotUtils.validateOnStackTasks(gradle, project, setOf("slot", "preserve", "hydraSchemaVersion"))
     *
     * @param gradle The Gradle instance (for taskGraph access)
     * @param project The Gradle project (for reading -P properties)
     * @param recognized Set of valid -P property names
     * @param taskNames Stack task names to trigger validation (defaults to standard set)
     */
    fun validateOnStackTasks(
        gradle: org.gradle.api.invocation.Gradle,
        project: Project,
        recognized: Set<String>,
        taskNames: Set<String> = setOf("stackUp", "stackDown", "stackDestroy", "stackInfo")
    ) {
        gradle.taskGraph.whenReady {
            if (allTasks.any { it.name in taskNames }) {
                validateProjectProperties(project, recognized)
            }
        }
    }

    /**
     * Regenerate connect.env with current environment values.
     *
     * Reads the existing connect.env (preserving comments, blank lines, section headers),
     * updates `export VAR=value` lines with values from envVars, and applies urlMappings
     * for derived URL variables.
     *
     * @param slotName Name of the slot
     * @param envVars Current environment variables (e.g., after port reassignment)
     * @param urlMappings Map of variable name to a function that computes its value from envVars.
     *                    Used for derived vars like DANA_URL that depend on port values.
     */
    fun regenerateConnectEnv(
        slotName: String,
        envVars: Map<String, String>,
        urlMappings: Map<String, (Map<String, String>) -> String> = emptyMap()
    ) {
        val connectEnvFile = getSlotDir(slotName).resolve("connect.env")
        if (!connectEnvFile.exists()) return

        val updatedLines = connectEnvFile.readLines().map { line ->
            val trimmed = line.trim()
            if (trimmed.startsWith("export ") && trimmed.contains("=")) {
                // Parse: export VAR=value
                val withoutExport = trimmed.removePrefix("export ")
                val eqIdx = withoutExport.indexOf('=')
                if (eqIdx > 0) {
                    val varName = withoutExport.substring(0, eqIdx)
                    when {
                        urlMappings.containsKey(varName) ->
                            "export $varName=${urlMappings[varName]!!.invoke(envVars)}"
                        envVars.containsKey(varName) ->
                            "export $varName=${envVars[varName]}"
                        else -> line  // Not in envVars or mappings — preserve as-is
                    }
                } else {
                    line
                }
            } else {
                line  // Comments, blank lines, section headers — preserve
            }
        }

        connectEnvFile.writeText(updatedLines.joinToString("\n"))
    }

    /**
     * Parse a PostgreSQL connection URL into a map of standard libpq environment variables.
     *
     * Supports URLs like: postgresql://user:pass@host:port/dbname
     *
     * @param url PostgreSQL connection URL
     * @return Map of PGHOST, PGPORT, PGUSER, PGPASSWORD, PGDATABASE
     */
    fun parseDbUrl(url: String): Map<String, String> {
        val uri = java.net.URI(url)
        val userInfo = uri.userInfo?.split(":", limit = 2)
        return mapOf(
            "PGHOST" to (uri.host ?: "localhost"),
            "PGPORT" to (if (uri.port > 0) uri.port.toString() else "5432"),
            "PGUSER" to (userInfo?.getOrNull(0) ?: "postgres"),
            "PGPASSWORD" to (userInfo?.getOrNull(1) ?: ""),
            "PGDATABASE" to (uri.path?.removePrefix("/") ?: "zerobias")
        )
    }
}
