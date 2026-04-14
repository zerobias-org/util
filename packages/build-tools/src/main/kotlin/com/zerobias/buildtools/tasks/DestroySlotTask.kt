package com.zerobias.buildtools.tasks

import com.zerobias.buildtools.util.ContainerTrackingUtils
import com.zerobias.buildtools.util.ExecUtils
import com.zerobias.buildtools.util.SlotUtils
import org.gradle.api.DefaultTask
import org.gradle.api.tasks.Internal
import org.gradle.api.tasks.TaskAction
import org.gradle.api.Project
import javax.inject.Inject

/**
 * Gradle task to completely destroy a slot — containers, volumes, and the slot directory.
 *
 * Usage: ./gradlew slotDestroy -Pslot=local
 */
abstract class DestroySlotTask @Inject constructor(
    @get:Internal val projectInstance: Project
) : DefaultTask() {

    init {
        group = "zerobias"
        description = "Destroy a slot completely — containers, volumes, and slot directory (use -Pslot=name)"
    }

    @TaskAction
    fun execute() {
        val slotName = projectInstance.findProperty("slot") as String?
            ?: throw org.gradle.api.GradleException("Slot name required: -Pslot=<name>")

        val slotDir = SlotUtils.getSlotDir(slotName)
        if (!slotDir.exists()) {
            println("Slot does not exist: $slotName")
            return
        }

        // Stop and remove all containers labeled with this slot.
        // The compose project name equals the slot name.
        val composeProject = slotName

        val containers = ExecUtils.execCapture(
            command = listOf(
                "docker", "ps", "-aq",
                "--filter", "label=zerobias.slot=$composeProject"
            ),
            throwOnError = false
        ).trim()
        if (containers.isNotEmpty()) {
            println("Removing containers for slot: $composeProject")
            ExecUtils.execIgnoreErrors(
                command = listOf("docker", "rm", "-f") + containers.split("\n")
            )
        }

        // Remove Docker volumes associated with this stack (compose project)
        val volumes = ExecUtils.execCapture(
            command = listOf(
                "docker", "volume", "ls", "-q",
                "--filter", "label=com.docker.compose.project=$composeProject"
            ),
            throwOnError = false
        ).trim()
        if (volumes.isNotEmpty()) {
            println("Removing volumes for slot: $composeProject")
            ExecUtils.execIgnoreErrors(
                command = listOf("docker", "volume", "rm") + volumes.split("\n")
            )
        }

        // Delete the slot directory
        println("Deleting slot directory: ${slotDir.absolutePath}")
        slotDir.deleteRecursively()
        println("✓ Slot '$slotName' completely destroyed")
    }
}
