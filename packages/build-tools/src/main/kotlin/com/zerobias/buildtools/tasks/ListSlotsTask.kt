package com.zerobias.buildtools.tasks

import com.zerobias.buildtools.util.SlotManagementUtils
import org.gradle.api.DefaultTask
import org.gradle.api.tasks.Internal
import org.gradle.api.tasks.TaskAction
import org.gradle.api.Project
import javax.inject.Inject

/**
 * Gradle task to list all ZeroBias slots with container status.
 *
 * Usage: ./gradlew listSlots -q
 */
abstract class ListSlotsTask @Inject constructor(
    @get:Internal val projectInstance: Project
) : DefaultTask() {

    init {
        group = "zerobias"
        description = "List all ZeroBias slots with container status"
    }

    @TaskAction
    fun execute() {
        val slots = SlotManagementUtils.listAllSlots(projectInstance)
        println(SlotManagementUtils.formatSlotList(slots))
    }
}
