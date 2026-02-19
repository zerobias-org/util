package com.zerobias.buildtools.util

import java.text.SimpleDateFormat
import java.util.Date

/**
 * Data class representing a Docker container with zerobias metadata.
 */
data class ContainerInfo(
    val name: String,
    val id: String,
    val slot: String?,
    val module: String?,
    val status: String,
    val created: String,
    val isOrphaned: Boolean = false
)

/**
 * Utilities for tracking Docker containers with zerobias labels.
 *
 * Containers created by stackUp tasks are tagged with labels:
 * - zerobias.slot=<slot-name>
 * - zerobias.module=<module-name> (dana, hub-server, hub-events, etc.)
 * - zerobias.created=<timestamp>
 */
object ContainerTrackingUtils {

    /**
     * List all containers with zerobias labels.
     *
     * @param slot Optional slot name filter
     * @param module Optional module name filter
     * @return List of container info
     */
    fun listContainers(
        slot: String? = null,
        module: String? = null
    ): List<ContainerInfo> {
        val filters = mutableListOf("label=zerobias.slot")

        if (slot != null) {
            filters.clear()
            filters.add("label=zerobias.slot=$slot")
        }
        if (module != null) {
            filters.add("label=zerobias.module=$module")
        }

        val filterArgs = filters.flatMap { listOf("--filter", it) }

        val command = listOf(
            "docker", "ps", "-a",
            "--format", "{{.Names}}\t{{.ID}}\t{{.Label \"zerobias.slot\"}}\t{{.Label \"zerobias.module\"}}\t{{.Status}}\t{{.CreatedAt}}"
        ) + filterArgs

        val output = try {
            ExecUtils.execCapture(
                command = command,
                throwOnError = false
            )
        } catch (e: Exception) {
            println("WARN: Failed to list containers: ${e.message}")
            return emptyList()
        }

        val containers = output.trim().lines()
            .filter { it.isNotBlank() }
            .mapNotNull { line ->
                val parts = line.split("\t")
                if (parts.size >= 6) {
                    val slotLabel = parts[2].ifBlank { null }
                    val moduleLabel = parts[3].ifBlank { null }

                    // Check if orphaned (slot label exists but slot directory doesn't)
                    val isOrphaned = slotLabel != null && !SlotUtils.slotExists(slotLabel)

                    ContainerInfo(
                        name = parts[0],
                        id = parts[1],
                        slot = slotLabel,
                        module = moduleLabel,
                        status = parseContainerStatus(parts[4]),
                        created = parts[5],
                        isOrphaned = isOrphaned
                    )
                } else {
                    null
                }
            }

        return containers
    }

    /**
     * Get containers for a specific slot.
     *
     * @param slotName Slot name
     * @return List of containers for this slot
     */
    fun getSlotContainers(slotName: String): List<ContainerInfo> {
        return listContainers(slot = slotName)
    }

    /**
     * Get orphaned containers (slot label exists but slot directory doesn't).
     *
     * @return List of orphaned containers
     */
    fun getOrphanedContainers(): List<ContainerInfo> {
        return listContainers().filter { it.isOrphaned }
    }

    /**
     * Format container labels for docker-compose.yml.
     *
     * Returns a map suitable for the labels section of a service definition.
     *
     * @param slot Slot name
     * @param module Module name (dana, hub-server, etc.)
     * @return Map of label keys to values
     */
    fun formatContainerLabels(slot: String, module: String): Map<String, String> {
        return mapOf(
            "zerobias.slot" to slot,
            "zerobias.module" to module,
            "zerobias.created" to SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ssZ").format(Date())
        )
    }

    /**
     * Format container list as a table for display.
     *
     * @param containers List of containers
     * @return Formatted table string
     */
    fun formatContainerList(containers: List<ContainerInfo>): String {
        if (containers.isEmpty()) {
            return "\nNo zerobias containers found\n"
        }

        val sb = StringBuilder()

        sb.appendLine()
        sb.appendLine(String.format("%-25s %-15s %-12s %-12s %-10s",
            "CONTAINER", "SLOT", "MODULE", "STATUS", "CREATED"))

        containers.forEach { container ->
            val slotDisplay = when {
                container.isOrphaned -> "[ORPHAN]"
                container.slot != null -> container.slot
                else -> "-"
            }
            val moduleDisplay = container.module ?: "-"
            val status = container.status
            val created = container.created.take(10)  // Just the date part

            sb.appendLine(String.format("%-25s %-15s %-12s %-12s %-10s",
                container.name, slotDisplay, moduleDisplay, status, created))
        }

        sb.appendLine()
        val orphanedCount = containers.count { it.isOrphaned }
        val matchedCount = containers.size - orphanedCount
        sb.appendLine("Total: ${containers.size} containers ($matchedCount matched, $orphanedCount orphaned)")

        return sb.toString()
    }

    /**
     * Parse container status from docker ps output.
     *
     * Simplifies status like "Up 2 hours" or "Exited (0) 5 minutes ago" to "running" or "exited"
     */
    private fun parseContainerStatus(statusString: String): String {
        return when {
            statusString.startsWith("Up", ignoreCase = true) -> "running"
            statusString.startsWith("Exited", ignoreCase = true) -> "exited"
            statusString.startsWith("Created", ignoreCase = true) -> "created"
            statusString.startsWith("Restarting", ignoreCase = true) -> "restarting"
            statusString.startsWith("Paused", ignoreCase = true) -> "paused"
            statusString.startsWith("Dead", ignoreCase = true) -> "dead"
            else -> statusString.lowercase()
        }
    }

    /**
     * Generate docker-compose labels YAML snippet.
     *
     * Returns a YAML string that can be added to a service definition.
     *
     * @param slotEnvVar Environment variable name for slot (e.g., STACK_NAME)
     * @param module Module name
     * @return YAML labels snippet
     */
    fun generateDockerComposeLabels(slotEnvVar: String, module: String): String {
        return """
            |    labels:
            |      - "zerobias.slot=$slotEnvVar"
            |      - "zerobias.module=$module"
            |      - "zerobias.created=${'$'}{CREATED_TIMESTAMP:-unknown}"
        """.trimMargin()
    }
}
