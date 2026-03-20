package com.zerobias.buildtools.util

import org.gradle.api.GradleException
import java.io.File

/**
 * Provides slot environment via zbb CLI.
 *
 * Two modes:
 * 1. Inside a loaded slot (ZB_SLOT set) — reads env from ZB_SLOT_DIR/.env
 * 2. Ephemeral slots — creates via `zbb slot create --ephemeral`, reads .env from result
 *
 * This replaces direct slot directory manipulation. zbb owns slot creation,
 * port allocation, secret generation, and env resolution. Gradle just reads
 * the resulting .env and passes it to child processes.
 */
object ZbbSlotProvider {

    /**
     * Get the active slot name from ZB_SLOT env var.
     * Throws if not inside a loaded slot.
     */
    fun requireActiveSlot(): String {
        return System.getenv("ZB_SLOT")
            ?: throw GradleException(
                "No active slot. Run:\n" +
                "  zbb slot create <name>\n" +
                "  zbb slot load <name>"
            )
    }

    /**
     * Get the active slot name, or null if not inside a loaded slot.
     */
    fun activeSlotName(): String? = System.getenv("ZB_SLOT")

    /**
     * Check if we're running inside a loaded zbb slot.
     */
    fun isInsideSlot(): Boolean = System.getenv("ZB_SLOT") != null

    /**
     * Get the active slot's directory path from ZB_SLOT_DIR.
     */
    fun activeSlotDir(): File? {
        val dir = System.getenv("ZB_SLOT_DIR") ?: return null
        return File(dir)
    }

    /**
     * Get the .env file path for the active slot.
     */
    fun activeEnvFilePath(): String {
        val dir = System.getenv("ZB_SLOT_DIR")
            ?: throw GradleException("ZB_SLOT_DIR not set. Are you inside a loaded slot?")
        return File(dir, ".env").absolutePath
    }

    /**
     * Read slot environment variables from the .env file.
     *
     * If slotName matches the active slot (or is null), reads from ZB_SLOT_DIR/.env.
     * Otherwise reads from ~/.zbb/slots/<slotName>/.env.
     */
    fun getSlotEnv(slotName: String? = null): Map<String, String> {
        val envFile = getEnvFile(slotName)
        if (!envFile.exists()) {
            throw GradleException(
                "Slot .env not found: ${envFile.absolutePath}\n" +
                "Create a slot with: zbb slot create ${slotName ?: "<name>"}"
            )
        }
        return readEnvFile(envFile)
    }

    /**
     * Get the .env File for a slot.
     */
    fun getEnvFile(slotName: String? = null): File {
        val activeSlot = System.getenv("ZB_SLOT")
        val activeDir = System.getenv("ZB_SLOT_DIR")

        // Active slot match — use ZB_SLOT_DIR
        if (activeDir != null && (slotName == null || slotName == activeSlot)) {
            return File(activeDir, ".env")
        }

        // Named slot — look in ~/.zbb/slots/
        val name = slotName ?: throw GradleException(
            "No slot name provided and not inside a loaded slot."
        )
        val slotsDir = getSlotsDir()
        return File(slotsDir, "$name/.env")
    }

    /**
     * Create an ephemeral slot via zbb CLI.
     *
     * @param ttl Time-to-live (e.g., "30m", "2h")
     * @param name Optional name (auto-generated if omitted)
     * @return Slot name
     */
    fun createEphemeralSlot(ttl: String = "30m", name: String? = null): String {
        val cmd = mutableListOf("zbb", "slot", "create", "--ephemeral", "--ttl", ttl)
        if (name != null) cmd.add(name)

        val output = execZbb(cmd)

        // Parse slot name from output: "Slot 'e2e-abc123' created."
        val match = Regex("""Slot '([^']+)' created""").find(output)
            ?: throw GradleException("Failed to parse slot name from zbb output:\n$output")
        return match.groupValues[1]
    }

    /**
     * Delete a slot via zbb CLI.
     */
    fun deleteSlot(name: String) {
        execZbb(listOf("zbb", "slot", "delete", name))
    }

    /**
     * Run zbb garbage collection for expired ephemeral slots.
     */
    fun gc() {
        execZbb(listOf("zbb", "slot", "gc"))
    }

    // ── Internal ─────────────────────────────────────────────────────

    private fun getSlotsDir(): File {
        return File(System.getProperty("user.home"), ".zbb/slots")
    }

    private fun readEnvFile(file: File): Map<String, String> {
        return file.readLines()
            .filter { it.isNotBlank() && !it.trimStart().startsWith("#") }
            .mapNotNull { line ->
                val idx = line.indexOf('=')
                if (idx > 0) line.substring(0, idx).trim() to line.substring(idx + 1).trim()
                else null
            }
            .toMap()
    }

    private fun execZbb(command: List<String>): String {
        val process = ProcessBuilder(command)
            .redirectErrorStream(true)
            .start()
        val output = process.inputStream.bufferedReader().readText()
        val exitCode = process.waitFor()
        if (exitCode != 0) {
            throw GradleException("zbb command failed (exit $exitCode): ${command.joinToString(" ")}\n$output")
        }
        return output
    }
}
