package com.zerobias.buildtools.tasks

import com.zerobias.buildtools.util.SlotManagementUtils
import org.gradle.api.DefaultTask
import org.gradle.api.tasks.Internal
import org.gradle.api.tasks.TaskAction
import org.gradle.api.Project
import javax.inject.Inject

/**
 * Gradle task to show connection info for a specific slot.
 *
 * Usage: ./gradlew showSlot -Pslot=slot-name -q
 */
abstract class ShowSlotTask @Inject constructor(
    @get:Internal val projectInstance: Project
) : DefaultTask() {

    init {
        group = "zerobias"
        description = "Show connection info for specific slot (use -Pslot=name)"
    }

    @TaskAction
    fun execute() {
        val slotName = projectInstance.findProperty("slot") as String? ?: "default"
        val info = SlotManagementUtils.getSlotInfo(projectInstance, slotName)
        println(SlotManagementUtils.formatSlotConnectionInfo(info))
    }
}
