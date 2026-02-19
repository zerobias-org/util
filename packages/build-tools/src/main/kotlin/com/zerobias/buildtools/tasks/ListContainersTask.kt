package com.zerobias.buildtools.tasks

import com.zerobias.buildtools.util.ContainerTrackingUtils
import org.gradle.api.DefaultTask
import org.gradle.api.tasks.Internal
import org.gradle.api.tasks.TaskAction
import org.gradle.api.Project
import javax.inject.Inject

/**
 * Gradle task to list all ZeroBias-labeled containers.
 *
 * Usage:
 *   ./gradlew listContainers -q
 *   ./gradlew listContainers -Pslot=slot-name -q
 *   ./gradlew listContainers -Pmodule=module-name -q
 *   ./gradlew listContainers -Pslot=slot-name -Pmodule=module-name -q
 */
abstract class ListContainersTask @Inject constructor(
    @get:Internal val projectInstance: Project
) : DefaultTask() {

    init {
        group = "zerobias"
        description = "List all ZeroBias-labeled containers (use -Pslot=X -Pmodule=Y to filter)"
    }

    @TaskAction
    fun execute() {
        val slot = projectInstance.findProperty("slot") as String?
        val module = projectInstance.findProperty("module") as String?
        val containers = ContainerTrackingUtils.listContainers(slot, module)

        if (containers.isEmpty()) {
            println("No containers found")
        } else {
            containers.forEach { c ->
                println("${c.name}\t${c.slot ?: "none"}\t${c.module ?: "none"}\t${c.status}")
            }
        }
    }
}
