/**
 * Workspace-level plugin for the module-gradle root project.
 *
 * Registers slot management tasks (listSlots, showSlot) at the workspace level
 * so they are available from the root project without needing to target a specific module.
 *
 * Usage (root build.gradle.kts only):
 *   plugins {
 *       id("zb.workspace")
 *   }
 *
 * Then run:
 *   ./gradlew listSlots
 *   ./gradlew showSlot -Pslot=local
 */

import com.zerobias.buildtools.tasks.ListSlotsTask
import com.zerobias.buildtools.tasks.ShowSlotTask

tasks.register("listSlots", ListSlotsTask::class.java, project)
tasks.register("showSlot", ShowSlotTask::class.java, project)
