plugins {
    id("zb.workspace")
}

group = "com.zerobias.hub"

val projectPaths by tasks.registering {
    group = "info"
    description = "Output project-to-directory mappings for tooling (used by zbb CLI)"
    doLast {
        subprojects.filter { it.buildFile.exists() }.forEach { p ->
            println("${p.path}=${p.projectDir.relativeTo(rootDir)}")
        }
    }
}

val changedModules by tasks.registering {
    group = "info"
    description = "List modules changed since last version tag"
    doLast {
        val lastTag = try {
            providers.exec {
                commandLine("git", "describe", "--tags", "--abbrev=0")
            }.standardOutput.asText.get().trim()
        } catch (e: Exception) {
            logger.warn("No version tags found -- listing all modules as changed")
            null
        }

        val diffArgs = if (lastTag != null) {
            listOf("git", "diff", "--name-only", lastTag, "HEAD")
        } else {
            listOf("git", "ls-files")  // No tag -> all files are "changed"
        }

        val result = providers.exec {
            commandLine(diffArgs)
        }.standardOutput.asText.get()

        val changed = result.lines()
            .filter { it.startsWith("package/") }
            .map { it.split("/").drop(1).dropLast(1).joinToString("/") }
            .distinct()
            .filter { it.isNotEmpty() }

        changed.forEach { println(it) }
    }
}
