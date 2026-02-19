/**
 * Shared stack testing plugin.
 *
 * Provides standard tasks for slot-based Docker Compose stack management:
 * - stackUp: Start service stack in a slot
 * - stackDown: Stop service
 * - stackDestroy: Destroy service and optionally slot
 *
 * Uses shared utilities for slot management, port allocation, and health checks.
 *
 * Usage:
 *   plugins {
 *       id("zb.stack-testing")
 *   }
 *
 *   zbStack {
 *       serviceName = "hub-server"
 *       composeFile = file("../test/docker-compose.yml")
 *       healthCheckServices = listOf("hub-server")
 *       defaultSlotPrefix = "hub-test"
 *   }
 */

import com.zerobias.buildtools.util.SlotUtils
import com.zerobias.buildtools.util.PortUtils
import com.zerobias.buildtools.util.HealthCheckUtils
import com.zerobias.buildtools.util.ExecUtils
import java.time.LocalDateTime
import java.time.format.DateTimeFormatter

// Extension for configuration
open class StackTestingExtension {
    var serviceName: String = "service"
    var composeFile: java.io.File? = null
    var healthCheckServices: List<String> = emptyList()
    var healthCheckTimeout: Int = 60
    var defaultSlotPrefix: String = "test"
    var defaultPortStart: Int = 8000
}

val extension = extensions.create<StackTestingExtension>("zbStack")

// Shared slot name resolution
val slotName: String by lazy {
    val rawName = if (project.hasProperty("slot")) {
        project.property("slot") as String
    } else {
        // Auto-generate: prefix + timestamp
        "${extension.defaultSlotPrefix}-" + LocalDateTime.now().format(
            DateTimeFormatter.ofPattern("yyyyMMdd-HHmmss")
        )
    }
    // Docker Compose requires lowercase alphanumeric + hyphens/underscores
    rawName.lowercase().replace(Regex("[^a-z0-9_-]"), "-")
}

// Shared computed values
val slotsDir = SlotUtils.getSlotsDir()
val slotDir = SlotUtils.getSlotDir(slotName)
val slotEnvFile = slotDir.resolve(".env")
val isEphemeral = SlotUtils.isEphemeralSlot(slotName)
val preserveSlot = project.hasProperty("preserve")

// ============================================================
// Stack Management Tasks
// ============================================================

tasks.register("stackUp") {
    group = "stack"
    description = "Start ${extension.serviceName} stack [-Pslot=<name>]"

    doFirst {
        val composeFile = extension.composeFile
            ?: throw GradleException("composeFile not configured in zbStack extension")

        if (!composeFile.exists()) {
            throw GradleException("Compose file not found: $composeFile")
        }

        val workingDir = composeFile.parentFile

        // Ensure slot exists
        if (!SlotUtils.slotExists(slotName)) {
            println("Creating new slot: $slotName")
            slotDir.mkdirs()
            slotEnvFile.writeText("STACK_NAME=$slotName\n")
        }

        // Load slot environment
        val env = SlotUtils.loadSlotEnv(slotName).toMutableMap()
        val stackName = env["STACK_NAME"] ?: slotName

        // Find available port if needed
        val servicePortEnvVar = "${extension.serviceName.uppercase().replace("-", "_")}_PORT"
        if (!env.containsKey(servicePortEnvVar)) {
            val port = PortUtils.findAvailablePort(extension.defaultPortStart)
            env[servicePortEnvVar] = port.toString()
            SlotUtils.updateSlotEnv(slotName, mapOf(servicePortEnvVar to port.toString()))
            println("Allocated port: $port")
        }

        // Start service
        println("Starting ${extension.serviceName}...")
        ExecUtils.exec(
            command = listOf(
                "docker", "compose",
                "-f", composeFile.absolutePath,
                "-p", stackName,
                "--env-file", slotEnvFile.absolutePath,
                "up", "-d", extension.serviceName
            ),
            workingDir = workingDir
        )

        // Health checks
        extension.healthCheckServices.forEach { service ->
            println("Waiting for $service to be healthy...")
            HealthCheckUtils.waitForDockerHealth(
                workingDir = workingDir,
                slotName = stackName,
                serviceName = service,
                envFile = slotEnvFile,
                maxWaitSeconds = extension.healthCheckTimeout
            )
        }

        // Display connection info
        println("")
        println("✓ Stack ready: $stackName")
        println("  Slot dir: ${slotDir.absolutePath}")
        println("")
        println("Quick connect:")
        println("  source ${slotDir.absolutePath}/connect.env")
        println("")
    }
}

tasks.register("stackDown") {
    group = "stack"
    description = "Stop ${extension.serviceName} [-Pslot=<name>]"

    doFirst {
        val composeFile = extension.composeFile
            ?: throw GradleException("composeFile not configured in zbStack extension")

        if (!SlotUtils.slotExists(slotName)) {
            println("Slot does not exist: $slotName")
            return@doFirst
        }

        val env = SlotUtils.loadSlotEnv(slotName)
        val stackName = env["STACK_NAME"] ?: slotName

        println("Stopping ${extension.serviceName}: $stackName")
        ExecUtils.execIgnoreErrors(
            command = listOf(
                "docker", "compose",
                "-f", composeFile.absolutePath,
                "-p", stackName,
                "--env-file", slotEnvFile.absolutePath,
                "stop", extension.serviceName
            ),
            workingDir = composeFile.parentFile
        )

        println("✓ ${extension.serviceName} stopped")
    }
}

tasks.register("stackDestroy") {
    group = "stack"
    description = "Destroy ${extension.serviceName} stack [-Pslot=<name>] [-Ppreserve to keep slot]"

    doFirst {
        val composeFile = extension.composeFile
            ?: throw GradleException("composeFile not configured in zbStack extension")

        if (!SlotUtils.slotExists(slotName)) {
            println("Slot does not exist: $slotName")
            return@doFirst
        }

        val env = SlotUtils.loadSlotEnv(slotName)
        val stackName = env["STACK_NAME"] ?: slotName

        if (isEphemeral && !preserveSlot) {
            // Ephemeral slot: destroy everything and delete slot
            println("Destroying full stack: $stackName")
            ExecUtils.execIgnoreErrors(
                command = listOf(
                    "docker", "compose",
                    "-f", composeFile.absolutePath,
                    "-p", stackName,
                    "--env-file", slotEnvFile.absolutePath,
                    "down", "-v"
                ),
                workingDir = composeFile.parentFile
            )

            println("Deleting slot: $slotName")
            delete(slotDir)
            println("✓ Stack destroyed and slot deleted: $slotName")
        } else {
            // Persistent slot: only remove service
            println("Persistent slot - removing only ${extension.serviceName}: $stackName")
            ExecUtils.execIgnoreErrors(
                command = listOf(
                    "docker", "compose",
                    "-f", composeFile.absolutePath,
                    "-p", stackName,
                    "--env-file", slotEnvFile.absolutePath,
                    "down"
                ),
                workingDir = composeFile.parentFile
            )
            println("✓ ${extension.serviceName} removed (slot preserved)")
        }
    }
}

// ============================================================
// Info Tasks
// ============================================================

tasks.register("stackInfo") {
    group = "stack"
    description = "Show stack connection information [-Pslot=<name>]"

    doFirst {
        if (!SlotUtils.slotExists(slotName)) {
            println("Slot does not exist: $slotName")
            return@doFirst
        }

        val env = SlotUtils.loadSlotEnv(slotName)

        println("")
        println("Slot: $slotName (${if (isEphemeral) "ephemeral" else "persistent"})")
        println("  Directory: ${slotDir.absolutePath}")
        println("")
        println("Quick connect:")
        println("  source ${slotDir.absolutePath}/connect.env")
        println("")

        // Show service-specific connection info
        env.forEach { (key, value) ->
            if (key.endsWith("_PORT") || key.endsWith("_URL")) {
                println("  $key: $value")
            }
        }
        println("")
    }
}
