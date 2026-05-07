package com.zerobias.buildtools.appliance

import com.github.gradle.node.npm.task.NpxTask
import org.gradle.api.Project
import org.gradle.kotlin.dsl.named
import org.gradle.kotlin.dsl.register

/**
 * Register the `lint` task for an appliance TypeScript module.
 *
 * Runs `eslint <srcDir> --ext .ts` via npx (using the nvm-managed Node from
 * `zb.typescript-base`).
 *
 * Wires:
 *   - dependsOn `npmInstallModule`
 *   - dependsOn the rootProject's `:generateVersionFiles` when present
 *   - inputs: srcDir, eslint.config.js (per-module — root-only configs do not
 *     pick up module sources)
 *   - hooks into the Gradle base plugin's `check` lifecycle via `lint`
 *
 * @param srcDir source root, relative to the module dir (default `"src"`)
 */
fun Project.registerEslintLint(srcDir: String = "src") {
    val moduleDir = projectDir
    val srcDirFile = moduleDir.resolve(srcDir)
    val eslintConfig = moduleDir.resolve("eslint.config.js")

    val lintTask = tasks.register<NpxTask>("lint") {
        group = "lifecycle"
        description = "Lint TypeScript sources via eslint"
        workingDir.set(moduleDir)
        command.set("eslint")
        args.set(listOf(srcDir, "--ext", ".ts"))
        dependsOn("npmInstallModule")
        rootProject.tasks.findByName("generateVersionFiles")?.let { dependsOn(it) }
        inputs.dir(srcDirFile).withPropertyName("src")
        if (eslintConfig.exists()) {
            inputs.file(eslintConfig).withPropertyName("eslintConfig")
        }
    }

    // Wire into Gradle base plugin's check lifecycle. The `build` task in
    // zb.typescript-base picks up `lint` explicitly.
    tasks.named("check") { dependsOn(lintTask) }
}
