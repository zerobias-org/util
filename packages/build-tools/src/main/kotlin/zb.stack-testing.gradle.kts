/**
 * Shared stack testing plugin.
 *
 * Provides standard tasks for zbb slot-based Docker Compose stack management:
 * - stackUp: Start service stack using active zbb slot
 * - stackDown: Stop service
 * - stackDestroy: Destroy service stack
 * - stackInfo: Show stack connection info
 *
 * Requires an active zbb slot (ZB_SLOT env var set via `zbb slot load`).
 * All env resolution (ports, secrets, derived vars) is handled by zbb.
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
 *   }
 */

import com.zerobias.buildtools.util.ZbbSlotProvider
import com.zerobias.buildtools.util.HealthCheckUtils
import com.zerobias.buildtools.util.ExecUtils
import com.github.gradle.node.npm.task.NpmTask
import com.github.gradle.node.npm.task.NpxTask

// Extension for configuration
open class StackTestingExtension {
    var serviceName: String = "service"
    var composeFile: java.io.File? = null
    var healthCheckServices: List<String> = emptyList()
    var healthCheckTimeout: Int = 60
}

val extension = extensions.create<StackTestingExtension>("zbStack")

// ============================================================
// Slot Environment
//
// Reads from active zbb slot (ZB_SLOT env var).
// All env vars are already in the shell from `zbb slot load`.
// We also read the .env file for docker compose --env-file.
// ============================================================

val slotName: String by lazy {
    ZbbSlotProvider.requireActiveSlot()
}

val slotEnv: Map<String, String> by lazy {
    ZbbSlotProvider.getSlotEnv()
}

val envFilePath: String by lazy {
    // Use stack .env if in a stack context, fall back to slot .env
    if (ZbbSlotProvider.activeStackName() != null) {
        ZbbSlotProvider.activeStackEnvFilePath()
    } else {
        ZbbSlotProvider.activeEnvFilePath()
    }
}

val composeProject: String by lazy {
    if (ZbbSlotProvider.activeStackName() != null) {
        ZbbSlotProvider.composeProjectName()
    } else {
        slotName  // Legacy: slot name as compose project when no stack
    }
}

// Inject slot env into all process-spawning task types
// so test processes (mocha, npm test, etc.) see slot vars
if (ZbbSlotProvider.isInsideSlot()) {
    val env = ZbbSlotProvider.getSlotEnv()
    tasks.withType<NpxTask>().configureEach {
        environment.putAll(env)
    }
    tasks.withType<NpmTask>().configureEach {
        environment.putAll(env)
    }
    tasks.withType<Exec>().configureEach {
        environment.putAll(env)
    }
    tasks.withType<JavaExec>().configureEach {
        environment.putAll(env)
    }
}

// ============================================================
// Stack Management Tasks
// ============================================================

// stackUp is registered as a bare task. Projects add doFirst/doLast to implement
// their specific startup sequence (e.g., postgres → schema → app).
// The plugin provides helper functions and slot env, not compose orchestration.
tasks.register("stackUp") {
    group = "stack"
    description = "Start ${extension.serviceName} stack (requires active zbb slot)"
}

tasks.register("stackDown") {
    group = "stack"
    description = "Stop ${extension.serviceName}"

    doFirst {
        val composeFile = extension.composeFile
            ?: throw GradleException("composeFile not configured in zbStack extension")

        println("Stopping ${extension.serviceName}: $composeProject")
        ExecUtils.execIgnoreErrors(
            command = listOf(
                "docker", "compose",
                "-f", composeFile.absolutePath,
                "-p", composeProject,
                "--env-file", envFilePath,
                "stop", extension.serviceName
            ),
            workingDir = composeFile.parentFile
        )

        println("✓ ${extension.serviceName} stopped")
    }
}

tasks.register("stackDestroy") {
    group = "stack"
    description = "Destroy ${extension.serviceName} stack"

    doFirst {
        val composeFile = extension.composeFile
            ?: throw GradleException("composeFile not configured in zbStack extension")

        println("Destroying stack: $composeProject")
        ExecUtils.execIgnoreErrors(
            command = listOf(
                "docker", "compose",
                "-f", composeFile.absolutePath,
                "-p", composeProject,
                "--env-file", envFilePath,
                "down", "-v"
            ),
            workingDir = composeFile.parentFile
        )

        println("✓ Stack destroyed: $composeProject")
    }
}

tasks.register("stackInfo") {
    group = "stack"
    description = "Show stack connection information"

    doFirst {
        val slot = slotName
        val env = slotEnv

        println("")
        println("Slot: $slot")
        println("  Env file: $envFilePath")
        println("")

        env.filter { (key, _) -> key.endsWith("_PORT") || key.endsWith("_URL") }
            .toSortedMap()
            .forEach { (key, value) ->
                println("  $key: $value")
            }
        println("")
    }
}

// ============================================================
// Ephemeral Slot Tasks (for CI / isolated test runs)
// ============================================================

tasks.register("createTestSlot") {
    group = "stack"
    description = "Create an ephemeral slot for testing (use -PslotTtl=30m to set TTL)"

    doLast {
        val ttl = if (project.hasProperty("slotTtl")) {
            project.property("slotTtl") as String
        } else {
            "30m"
        }

        val name = ZbbSlotProvider.createEphemeralSlot(ttl)
        println("Ephemeral slot created: $name (ttl: $ttl)")
        println("Load with: zbb slot load $name")
    }
}
