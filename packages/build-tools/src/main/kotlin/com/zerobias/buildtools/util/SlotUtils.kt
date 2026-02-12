package com.zerobias.buildtools.util

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
}
