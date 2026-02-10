package com.zerobias.buildtools.module

import org.gradle.api.GradleException
import java.io.File
import java.net.HttpURLConnection
import java.net.ServerSocket
import java.net.URI

/**
 * Manages Docker container lifecycle for Hub Modules.
 *
 * Provides start/stop/health-check operations used by the
 * `startModule` and `stopModule` Gradle tasks.
 */
object DockerRunner {

    data class ContainerInfo(
        val containerId: String,
        val port: Int,
        val image: String,
        val baseUrl: String
    ) {
        fun toJson(): String = buildString {
            appendLine("{")
            appendLine("""  "containerId": "$containerId",""")
            appendLine("""  "port": $port,""")
            appendLine("""  "image": "$image",""")
            appendLine("""  "baseUrl": "$baseUrl"""")
            appendLine("}")
        }

        companion object {
            fun fromJson(json: String): ContainerInfo {
                fun extract(key: String): String {
                    val match = Regex(""""$key"\s*:\s*"?([^",}\n]+)"?""").find(json)
                        ?: throw GradleException("Missing '$key' in module-container.json")
                    return match.groupValues[1].trim()
                }
                return ContainerInfo(
                    containerId = extract("containerId"),
                    port = extract("port").toInt(),
                    image = extract("image"),
                    baseUrl = extract("baseUrl")
                )
            }
        }
    }

    /**
     * Start a module container. Removes any stale container with the same name first.
     *
     * @param imageName  Docker image name:tag (e.g. "github-github:local")
     * @param containerName  Deterministic name (e.g. "module-github-github")
     * @param hostPort  Host port to map to container port 8888
     * @param insecure  If true, sets HUB_NODE_INSECURE=true in the container
     * @return ContainerInfo with the running container details
     */
    fun start(imageName: String, containerName: String, hostPort: Int, insecure: Boolean): ContainerInfo {
        // Remove any existing container with this name (idempotent restart)
        exec(listOf("docker", "rm", "-f", containerName), throwOnError = false)

        val cmd = buildList {
            add("docker"); add("run"); add("-d")
            add("-p"); add("$hostPort:8888")
            add("--name"); add(containerName)
            if (insecure) {
                add("-e"); add("HUB_NODE_INSECURE=true")
            }
            add(imageName)
        }

        val containerId = exec(cmd).trim()
        return ContainerInfo(
            containerId = containerId,
            port = hostPort,
            image = imageName,
            baseUrl = "http://localhost:$hostPort"
        )
    }

    /**
     * Poll the module's health endpoint until it responds with nonsensitiveProfileFields.
     *
     * @param port  Host port the container is mapped to
     * @param timeoutMs  Maximum wait time (default 60s)
     * @param intervalMs  Poll interval (default 1s)
     */
    fun waitForHealthy(port: Int, timeoutMs: Long = 60_000, intervalMs: Long = 1_000) {
        val deadline = System.currentTimeMillis() + timeoutMs
        val url = "http://localhost:$port/"
        var lastError: String? = null

        while (System.currentTimeMillis() < deadline) {
            try {
                val conn = URI(url).toURL().openConnection() as HttpURLConnection
                conn.connectTimeout = 2_000
                conn.readTimeout = 2_000
                conn.requestMethod = "GET"
                val code = conn.responseCode
                if (code == 200) {
                    val body = conn.inputStream.bufferedReader().readText()
                    if (body.contains("nonsensitiveProfileFields")) {
                        return
                    }
                    lastError = "HTTP 200 but no nonsensitiveProfileFields in response"
                } else {
                    lastError = "HTTP $code"
                }
                conn.disconnect()
            } catch (e: Exception) {
                lastError = e.message
            }
            Thread.sleep(intervalMs)
        }

        throw GradleException(
            "Module health check timed out after ${timeoutMs / 1000}s (last error: $lastError)"
        )
    }

    /**
     * Stop and remove a container by ID and name.
     */
    fun stop(containerId: String, @Suppress("UNUSED_PARAMETER") containerName: String) {
        exec(listOf("docker", "stop", "-t", "10", containerId), throwOnError = false)
        exec(listOf("docker", "rm", "-f", containerId), throwOnError = false)
    }

    /**
     * Stop and remove a container by name only (fallback when JSON file is missing).
     */
    fun stopByName(containerName: String) {
        exec(listOf("docker", "stop", "-t", "10", containerName), throwOnError = false)
        exec(listOf("docker", "rm", "-f", containerName), throwOnError = false)
    }

    /**
     * Get container logs for diagnostics.
     */
    fun getLogs(containerId: String): String {
        return exec(listOf("docker", "logs", containerId), throwOnError = false)
    }

    /**
     * Find an available TCP port by briefly binding to port 0.
     */
    fun findFreePort(): Int {
        return ServerSocket(0).use { it.localPort }
    }

    /**
     * Execute a command and return stdout. Throws on non-zero exit unless throwOnError=false.
     */
    private fun exec(command: List<String>, throwOnError: Boolean = true): String {
        val process = ProcessBuilder(command)
            .redirectErrorStream(false)
            .start()

        val stdout = process.inputStream.bufferedReader().readText()
        val stderr = process.errorStream.bufferedReader().readText()
        val exitCode = process.waitFor()

        if (exitCode != 0 && throwOnError) {
            throw GradleException(
                "Command failed (exit $exitCode): ${command.joinToString(" ")}\n$stderr"
            )
        }
        return stdout
    }
}
