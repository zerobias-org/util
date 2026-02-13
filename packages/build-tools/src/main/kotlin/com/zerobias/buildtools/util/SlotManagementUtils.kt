package com.zerobias.buildtools.util

import org.gradle.api.Project
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date

/**
 * Data class representing a slot with its metadata and container info.
 */
data class SlotInfo(
    val name: String,
    val directory: File,
    val type: String,  // "ephemeral" or "persistent"
    val created: Date,
    val modified: Date,
    val envVars: Map<String, String>,
    val containers: List<ContainerInfo>,
    val isRunning: Boolean
) {
    val runningContainerCount: Int
        get() = containers.count { it.status == "running" }

    val totalContainerCount: Int
        get() = containers.size
}

/**
 * Utilities for managing and querying slots.
 *
 * Builds on SlotUtils to provide higher-level operations like listing all slots,
 * getting slot status, and displaying connection information.
 */
object SlotManagementUtils {

    /**
     * List all slots in the slots directory.
     *
     * @param project Gradle project (for running docker commands)
     * @return List of SlotInfo objects, sorted by modified date (newest first)
     */
    fun listAllSlots(project: Project): List<SlotInfo> {
        val slotsDir = SlotUtils.getSlotsDir()

        return slotsDir.listFiles { file -> file.isDirectory }
            ?.mapNotNull { slotDir ->
                try {
                    val envFile = File(slotDir, ".env")
                    if (!envFile.exists()) {
                        return@mapNotNull null  // Skip invalid slots
                    }

                    val slotName = slotDir.name
                    val envVars = SlotUtils.loadSlotEnv(slotName)
                    val containers = ContainerTrackingUtils.getSlotContainers(slotName)

                    SlotInfo(
                        name = slotName,
                        directory = slotDir,
                        type = if (SlotUtils.isEphemeralSlot(slotName)) "ephemeral" else "persistent",
                        created = Date(slotDir.lastModified()),  // Approximation
                        modified = Date(slotDir.lastModified()),
                        envVars = envVars,
                        containers = containers,
                        isRunning = containers.any { it.status == "running" }
                    )
                } catch (e: Exception) {
                    println("WARN: Failed to load slot ${slotDir.name}: ${e.message}")
                    null
                }
            }
            ?.sortedByDescending { it.modified }
            ?: emptyList()
    }

    /**
     * Get detailed information about a specific slot.
     *
     * @param project Gradle project
     * @param slotName Name of the slot
     * @return SlotInfo object
     * @throws IllegalStateException if slot doesn't exist
     */
    fun getSlotInfo(project: Project, slotName: String): SlotInfo {
        val slotDir = SlotUtils.getSlotDir(slotName)

        if (!slotDir.exists()) {
            throw IllegalStateException("Slot not found: $slotName")
        }

        val envVars = SlotUtils.loadSlotEnv(slotName)
        val containers = ContainerTrackingUtils.getSlotContainers(slotName)

        return SlotInfo(
            name = slotName,
            directory = slotDir,
            type = if (SlotUtils.isEphemeralSlot(slotName)) "ephemeral" else "persistent",
            created = Date(slotDir.lastModified()),
            modified = Date(slotDir.lastModified()),
            envVars = envVars,
            containers = containers,
            isRunning = containers.any { it.status == "running" }
        )
    }

    /**
     * Format slot connection information (one-liners and connection details).
     *
     * Returns formatted string similar to stackUp task output.
     *
     * @param slotInfo Slot information
     * @return Formatted multi-line string
     */
    fun formatSlotConnectionInfo(slotInfo: SlotInfo): String {
        val sb = StringBuilder()
        val env = slotInfo.envVars

        sb.appendLine()
        sb.appendLine("✓ Slot: ${slotInfo.name} (${slotInfo.type})")
        sb.appendLine("  Directory: ${slotInfo.directory.absolutePath}")
        sb.appendLine()
        sb.appendLine("Quick connect:")
        sb.appendLine("  source ${slotInfo.directory.absolutePath}/connect.env")
        sb.appendLine()

        // PostgreSQL one-liner
        if (env.containsKey("PGPORT") && env.containsKey("PGUSER") && env.containsKey("PGDATABASE")) {
            sb.appendLine("PostgreSQL (1-liner):")
            sb.appendLine("  PGPASSWORD=${env["PGPASSWORD"]} psql -h localhost -p ${env["PGPORT"]} -U ${env["PGUSER"]} -d ${env["PGDATABASE"]}")
            sb.appendLine()
        }

        // Dana /me one-liner
        if (env.containsKey("DANA_PORT") && env.containsKey("API_KEY")) {
            sb.appendLine("Dana /me (1-liner):")
            sb.appendLine("  curl http://localhost:${env["DANA_PORT"]}/api/dana/me -H 'Authorization: ApiKey ${env["API_KEY"]}'")
            sb.appendLine()
        }

        // Services status
        sb.appendLine("Services:")
        if (env.containsKey("PGPORT")) {
            val pgContainer = slotInfo.containers.find { it.name.contains("postgres") }
            val status = if (pgContainer?.status == "running") "[running]" else "[stopped]"
            sb.appendLine("  PostgreSQL: localhost:${env["PGPORT"]} $status")
        }
        if (env.containsKey("DANA_PORT")) {
            val danaContainer = slotInfo.containers.find { it.name.contains("dana") && !it.name.contains("nginx") }
            val status = if (danaContainer?.status == "running") "[running]" else "[stopped]"
            sb.appendLine("  Dana:       http://localhost:${env["DANA_PORT"]} $status")
        }
        if (env.containsKey("NGINX_HTTPS_PORT")) {
            val nginxContainer = slotInfo.containers.find { it.name.contains("nginx") }
            val status = if (nginxContainer?.status == "running") "[running]" else "[stopped]"
            sb.appendLine("  nginx:      https://localhost:${env["NGINX_HTTPS_PORT"]} $status")
        }
        if (env.containsKey("PKG_PROXY_PORT")) {
            val pkgContainer = slotInfo.containers.find { it.name.contains("pkg-proxy") }
            val status = if (pkgContainer?.status == "running") "[running]" else "[stopped]"
            sb.appendLine("  pkg-proxy:  http://localhost:${env["PKG_PROXY_PORT"]} $status")
        }

        return sb.toString()
    }

    /**
     * Format a list of slots as a table for display.
     *
     * @param slots List of slot info
     * @return Formatted table string
     */
    fun formatSlotList(slots: List<SlotInfo>): String {
        if (slots.isEmpty()) {
            return "No slots found in ${SlotUtils.getSlotsDir().absolutePath}"
        }

        val sb = StringBuilder()
        val dateFormat = SimpleDateFormat("yyyy-MM-dd HH:mm")

        sb.appendLine()
        sb.appendLine("Slots in ${SlotUtils.getSlotsDir().absolutePath}:")
        sb.appendLine()

        // Header
        sb.appendLine(String.format("%-20s %-10s %-12s %-12s %-19s",
            "NAME", "STATUS", "CONTAINERS", "TYPE", "MODIFIED"))

        // Rows
        slots.forEach { slot ->
            val status = if (slot.isRunning) "running" else "stopped"
            val containers = "${slot.runningContainerCount}/${slot.totalContainerCount}"
            val modified = dateFormat.format(slot.modified)

            sb.appendLine(String.format("%-20s %-10s %-12s %-12s %-19s",
                slot.name, status, containers, slot.type, modified))
        }

        sb.appendLine()
        val runningCount = slots.count { it.isRunning }
        val stoppedCount = slots.size - runningCount
        sb.appendLine("Total: ${slots.size} slots ($runningCount running, $stoppedCount stopped)")

        return sb.toString()
    }
}
