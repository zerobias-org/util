package com.zerobias.buildtools.module

import com.zerobias.buildtools.util.ExecUtils
import org.gradle.api.GradleException
import java.io.File
import java.net.ServerSocket
import java.net.URI
import javax.net.ssl.HttpsURLConnection
import javax.net.ssl.SSLContext
import javax.net.ssl.X509TrustManager
import java.security.cert.X509Certificate

/**
 * Manages Docker container lifecycle for Hub Modules.
 *
 * Provides start/stop/health-check operations used by the
 * `startModule` and `stopModule` Gradle tasks.
 *
 * All containers run with SSL (self-signed certs). There is no insecure mode.
 */
@OptIn(ExperimentalStdlibApi::class)
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
                    val regex = """"$key"\s*:\s*"?([^",}\n]+)"?""".toRegex()
                    return regex.find(json)?.groupValues?.get(1)?.trim()
                        ?: throw GradleException("Missing '$key' in container JSON")
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
     * Start a module container.
     * Always runs with SSL (self-signed certs). No insecure mode.
     */
    fun start(imageName: String, containerName: String, hostPort: Int): ContainerInfo {
        // Remove any existing container with this name (idempotent restart)
        ExecUtils.execIgnoreErrors(listOf("docker", "rm", "-f", containerName))

        val cmd = buildList {
            add("docker"); add("run"); add("-d")
            add("-p"); add("$hostPort:8888")
            add("--name"); add(containerName)
            // Tag with slot for cleanup by zbb destroy
            val slotName = System.getenv("ZB_SLOT")
            if (slotName != null) {
                add("--label"); add("zerobias.slot=$slotName")
            }
            add("--label"); add("hub.test=true")
            add(imageName)
        }

        val containerId = ExecUtils.execCapture(cmd).trim()
        return ContainerInfo(
            containerId = containerId,
            port = hostPort,
            image = imageName,
            baseUrl = "https://localhost:$hostPort"
        )
    }

    /**
     * Poll the module's health endpoint until it responds.
     * Uses HTTPS with self-signed cert trust (modules generate certs at startup).
     */
    fun waitForHealthy(port: Int, timeoutMs: Long = 60_000, intervalMs: Long = 1_000) {
        val deadline = System.currentTimeMillis() + timeoutMs
        val url = "https://localhost:$port/"
        var lastError: String? = null

        // Trust all certs (modules use self-signed)
        val trustAll = arrayOf<javax.net.ssl.TrustManager>(object : X509TrustManager {
            override fun checkClientTrusted(chain: Array<out X509Certificate>?, authType: String?) {}
            override fun checkServerTrusted(chain: Array<out X509Certificate>?, authType: String?) {}
            override fun getAcceptedIssuers(): Array<X509Certificate> = arrayOf()
        })
        val sslContext = SSLContext.getInstance("TLS")
        sslContext.init(null, trustAll, java.security.SecureRandom())

        while (System.currentTimeMillis() < deadline) {
            try {
                val conn = URI(url).toURL().openConnection() as HttpsURLConnection
                conn.sslSocketFactory = sslContext.socketFactory
                conn.setHostnameVerifier { _, _ -> true }
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
        ExecUtils.execIgnoreErrors(listOf("docker", "stop", "-t", "10", containerId))
        ExecUtils.execIgnoreErrors(listOf("docker", "rm", "-f", containerId))
    }

    /**
     * Stop and remove a container by name only (fallback).
     */
    fun stopByName(containerName: String) {
        ExecUtils.execIgnoreErrors(listOf("docker", "stop", "-t", "10", containerName))
        ExecUtils.execIgnoreErrors(listOf("docker", "rm", "-f", containerName))
    }

    /**
     * Get container logs.
     */
    fun getLogs(containerId: String): String {
        return try {
            ExecUtils.execCapture(listOf("docker", "logs", containerId))
        } catch (e: Exception) {
            "(failed to get logs: ${e.message})"
        }
    }

    /**
     * Find a free port on localhost.
     */
    fun findFreePort(): Int {
        ServerSocket(0).use { return it.localPort }
    }
}
