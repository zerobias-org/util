package com.zerobias.buildtools.util

import org.gradle.api.GradleException
import java.io.File

/**
 * Gradle 9 compatible command execution utilities.
 *
 * Replacement for deprecated project.exec() which was removed in Gradle 9.
 * Uses ProcessBuilder directly for maximum compatibility.
 */
object ExecUtils {

    /**
     * Execute a command using ProcessBuilder.
     *
     * @param command Command and arguments as list
     * @param workingDir Working directory (defaults to current directory)
     * @param environment Environment variables to set
     * @param throwOnError If true, throws GradleException on non-zero exit
     * @param captureOutput If true, returns stdout; if false, prints to console
     * @return Command stdout
     */
    fun exec(
        command: List<String>,
        workingDir: File? = null,
        environment: Map<String, String> = emptyMap(),
        throwOnError: Boolean = true,
        captureOutput: Boolean = false
    ): String {
        val processBuilder = ProcessBuilder(command)
        if (workingDir != null) {
            processBuilder.directory(workingDir)
        }
        if (environment.isNotEmpty()) {
            processBuilder.environment().putAll(environment)
        }
        processBuilder.redirectErrorStream(false)

        val process = processBuilder.start()
        val stdout = process.inputStream.bufferedReader().readText()
        val stderr = process.errorStream.bufferedReader().readText()
        val exitCode = process.waitFor()

        if (exitCode != 0 && throwOnError) {
            throw GradleException(
                "Command failed (exit $exitCode): ${command.joinToString(" ")}\n$stderr"
            )
        }

        return if (captureOutput) {
            stdout
        } else {
            if (stdout.isNotBlank()) println(stdout.trim())
            if (stderr.isNotBlank()) System.err.println(stderr.trim())
            stdout
        }
    }

    /**
     * Execute a command and capture output silently.
     * Convenience wrapper for exec() with captureOutput=true.
     */
    fun execCapture(
        command: List<String>,
        workingDir: File? = null,
        environment: Map<String, String> = emptyMap(),
        throwOnError: Boolean = true
    ): String {
        return exec(command, workingDir, environment, throwOnError, captureOutput = true)
    }

    /**
     * Execute a command and ignore errors.
     * Convenience wrapper for exec() with throwOnError=false.
     */
    fun execIgnoreErrors(
        command: List<String>,
        workingDir: File? = null,
        environment: Map<String, String> = emptyMap()
    ): String {
        return exec(command, workingDir, environment, throwOnError = false)
    }
}
