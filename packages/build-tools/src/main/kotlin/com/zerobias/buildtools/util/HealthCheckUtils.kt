package com.zerobias.buildtools.util

import org.gradle.api.GradleException
import org.gradle.api.Project
import java.io.ByteArrayOutputStream
import java.io.File
import java.net.URL

/**
 * Utilities for health checking Docker containers and HTTP services.
 */
object HealthCheckUtils {
    /**
     * Wait for a Docker service to become healthy.
     *
     * Uses `docker compose ps --format json` to check container health status.
     *
     * @param project Gradle project (for exec)
     * @param workingDir Directory containing docker-compose.yml
     * @param slotName Stack/project name for docker compose (-p flag)
     * @param serviceName Name of the service to check
     * @param envFile .env file for docker compose (--env-file flag)
     * @param maxWaitSeconds Maximum time to wait in seconds
     * @throws GradleException if service doesn't become healthy within maxWait
     */
    fun waitForDockerHealth(
        project: Project,
        workingDir: File,
        slotName: String,
        serviceName: String,
        envFile: File,
        maxWaitSeconds: Int = 60
    ) {
        println("Waiting for $serviceName to be healthy...")
        val startTime = System.currentTimeMillis()
        while (System.currentTimeMillis() - startTime < maxWaitSeconds * 1000) {
            val output = ByteArrayOutputStream()
            project.exec {
                this.workingDir = workingDir
                commandLine("docker", "compose", "-p", slotName, "--env-file", envFile.absolutePath, "ps", "--format", "json", serviceName)
                standardOutput = output
                isIgnoreExitValue = true
            }

            val status = output.toString()
            if (status.contains(""""Health":"healthy"""") ||
                (status.contains(""""State":"running"""") && !status.contains(""""Health":""""))) {
                println("✓ $serviceName is healthy")
                return
            }
            Thread.sleep(2000)
        }
        throw GradleException("$serviceName did not become healthy within $maxWaitSeconds seconds")
    }

    /**
     * Wait for an HTTP service to become healthy.
     *
     * Polls an HTTP endpoint until it returns successfully.
     *
     * @param serviceName Name of the service (for logging)
     * @param url Full URL to check (e.g., "http://localhost:3000/health")
     * @param maxWaitSeconds Maximum time to wait in seconds
     * @param intervalSeconds Interval between checks
     * @throws GradleException if service doesn't become healthy within maxWait
     */
    fun waitForHttpHealth(
        serviceName: String,
        url: String,
        maxWaitSeconds: Int = 60,
        intervalSeconds: Int = 2
    ) {
        println("Waiting for $serviceName HTTP health check...")
        val startTime = System.currentTimeMillis()
        while (System.currentTimeMillis() - startTime < maxWaitSeconds * 1000) {
            try {
                URL(url).readText()
                println("✓ $serviceName is healthy")
                return
            } catch (e: Exception) {
                Thread.sleep(intervalSeconds * 1000L)
            }
        }
        throw GradleException("$serviceName did not become healthy within $maxWaitSeconds seconds")
    }

    /**
     * Check if a list of Docker services are all running and healthy.
     *
     * @param project Gradle project (for exec)
     * @param workingDir Directory containing docker-compose.yml
     * @param slotName Stack/project name for docker compose (-p flag)
     * @param envFile .env file for docker compose (--env-file flag)
     * @param expectedServices List of service names to check
     * @return true if all services are running and healthy, false otherwise
     */
    fun checkServicesHealthy(
        project: Project,
        workingDir: File,
        slotName: String,
        envFile: File,
        expectedServices: List<String>
    ): Boolean {
        val statusOutput = ByteArrayOutputStream()
        project.exec {
            this.workingDir = workingDir
            commandLine("docker", "compose", "-p", slotName, "--env-file", envFile.absolutePath, "ps", "--format", "json")
            standardOutput = statusOutput
            isIgnoreExitValue = true
        }

        val containerStatuses = statusOutput.toString().lines()
            .filter { it.trim().startsWith("{") }
            .mapNotNull { line ->
                val service = Regex(""""Service":"([^"]+)"""").find(line)?.groupValues?.get(1)
                val state = Regex(""""State":"([^"]+)"""").find(line)?.groupValues?.get(1)
                val health = Regex(""""Health":"([^"]+)"""").find(line)?.groupValues?.get(1)
                if (service != null) service to (state to health) else null
            }
            .toMap()

        return expectedServices.all { service ->
            val (state, health) = containerStatuses[service] ?: return@all false
            state == "running" && (health == null || health == "healthy")
        }
    }
}
