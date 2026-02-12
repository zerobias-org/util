package com.zerobias.buildtools.util

import org.gradle.api.GradleException
import java.io.File
import java.io.IOException
import java.net.ServerSocket

/**
 * Utilities for port conflict detection and resolution.
 */
object PortUtils {
    /**
     * Check if a port is currently in use.
     *
     * @param port Port number to check
     * @return true if port is in use, false if available
     */
    fun isPortInUse(port: Int): Boolean {
        return try {
            ServerSocket(port).use { false }
        } catch (e: IOException) {
            true
        }
    }

    /**
     * Find the next available port starting from a given port.
     *
     * @param startPort Port to start searching from
     * @return First available port number
     * @throws GradleException if no available ports found before 65535
     */
    fun findAvailablePort(startPort: Int): Int {
        var port = startPort
        while (port < 65535) {
            if (!isPortInUse(port)) {
                return port
            }
            port++
        }
        throw GradleException("No available ports found starting from $startPort")
    }

    /**
     * Ensure ports are available, reassigning if needed and updating env files.
     *
     * @param envVars Mutable map of environment variables
     * @param portVarNames List of port variable names to check (e.g., ["PGPORT", "DANA_PORT"])
     * @param slotEnvFile .env file to update
     * @param connectEnvFile connect.env file to update (optional)
     * @param portMappings Optional map of port var to URL var for connect.env updates
     * @return true if any ports were reassigned
     */
    fun ensurePortsAvailable(
        envVars: MutableMap<String, String>,
        portVarNames: List<String>,
        slotEnvFile: File,
        connectEnvFile: File? = null,
        portMappings: Map<String, (Int) -> String> = emptyMap()
    ): Boolean {
        var updated = false

        portVarNames.forEach { varName ->
            val currentPort = envVars[varName]?.toIntOrNull() ?: return@forEach
            if (isPortInUse(currentPort)) {
                val newPort = findAvailablePort(currentPort + 1)
                println("  $varName: $currentPort → $newPort (port conflict resolved)")
                envVars[varName] = newPort.toString()
                updated = true
            }
        }

        if (updated) {
            // Update .env file (preserve all variables, just update ports)
            updateEnvFile(slotEnvFile, envVars, portVarNames)

            // Update connect.env if provided
            if (connectEnvFile != null && connectEnvFile.exists()) {
                updateConnectEnv(connectEnvFile, envVars, portMappings)
            }

            println("✓ Updated slot configuration with available ports")
        }

        return updated
    }

    private fun updateEnvFile(
        envFile: File,
        envVars: Map<String, String>,
        portVarNames: List<String>
    ) {
        val envLines = envFile.readLines().toMutableList()
        portVarNames.forEach { varName ->
            val newValue = envVars[varName]
            if (newValue != null) {
                val lineIndex = envLines.indexOfFirst { it.startsWith("$varName=") }
                if (lineIndex >= 0) {
                    envLines[lineIndex] = "$varName=$newValue"
                }
            }
        }
        envFile.writeText(envLines.joinToString("\n"))
    }

    private fun updateConnectEnv(
        connectEnvFile: File,
        envVars: Map<String, String>,
        portMappings: Map<String, (Int) -> String>
    ) {
        val connectLines = connectEnvFile.readLines().toMutableList()
        portMappings.forEach { (portVar, urlFormatter) ->
            val newPort = envVars[portVar]?.toIntOrNull()
            if (newPort != null) {
                val newUrl = urlFormatter(newPort)
                val lineIndex = connectLines.indexOfFirst {
                    it.contains("export $portVar=") || it.contains(newUrl.substringBefore("://"))
                }
                if (lineIndex >= 0) {
                    // Update port or URL line
                    when {
                        connectLines[lineIndex].contains("export $portVar=") ->
                            connectLines[lineIndex] = "export $portVar=$newPort"
                        connectLines[lineIndex].contains("URL=") ->
                            connectLines[lineIndex] = connectLines[lineIndex].substringBefore("=") + "=$newUrl"
                    }
                }
            }
        }
        connectEnvFile.writeText(connectLines.joinToString("\n"))
    }
}
