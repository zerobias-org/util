package com.zerobias.buildtools.appliance

import com.github.gradle.node.npm.task.NpxTask
import org.gradle.api.Project
import org.gradle.api.tasks.Exec
import org.gradle.kotlin.dsl.findByType
import org.gradle.kotlin.dsl.named
import org.gradle.kotlin.dsl.register
import java.io.File

/**
 * Register the `transpile` task for an appliance TypeScript module.
 *
 * Runs `tsc -b` over the module via the node-gradle plugin (which inherits the
 * nvm-managed Node binary from the `PATH` injection in `zb.typescript-base`).
 *
 * Wires:
 *   - dependsOn `npmInstallModule` (registered by `zb.typescript-base`)
 *   - dependsOn the rootProject's `:generateVersionFiles` task when present
 *     (com/node defines this aggregator at the root). Falls back silently when
 *     absent so the function is reusable in stacks without that convention.
 *   - inputs: srcDir, tsconfig.json, root tsconfig.json (when present)
 *   - outputs: dist/
 *   - finalizedBy a `posttranspile` task that chmods the configured bin
 *     (when `appliance.chmodBin` is set)
 *   - hooks into `compile` (Gradle base plugin lifecycle task)
 *
 * @param srcDir source root, relative to the module dir (default `"src"`)
 */
fun Project.registerTscTranspile(srcDir: String = "src") {
    val moduleDir = projectDir
    val srcDirFile = moduleDir.resolve(srcDir)
    val distDir = moduleDir.resolve("dist")
    val moduleTsconfig = moduleDir.resolve("tsconfig.json")
    val rootTsconfig = rootProject.file("tsconfig.json")

    val transpile = tasks.register<NpxTask>("transpile") {
        group = "lifecycle"
        description = "Compile TypeScript via tsc -b"
        workingDir.set(moduleDir)
        command.set("tsc")
        args.set(listOf("-b"))
        dependsOn("npmInstallModule")
        // Optional cross-project version-file generator.
        rootProject.tasks.findByName("generateVersionFiles")?.let { dependsOn(it) }
        inputs.dir(srcDirFile).withPropertyName("src")
        inputs.file(moduleTsconfig).withPropertyName("tsconfig")
        if (rootTsconfig.exists()) {
            inputs.file(rootTsconfig).withPropertyName("rootTsconfig")
        }
        outputs.dir(distDir)
    }

    // Optional posttranspile chmod. Reads ApplianceExtension lazily so users
    // can configure `appliance { chmodBin = ... }` after applying the plugin.
    val applianceExt = extensions.findByType<ApplianceExtension>()
    if (applianceExt != null) {
        val posttranspile = tasks.register<Exec>("posttranspile") {
            group = "lifecycle"
            description = "chmod +x the module's bin entrypoint after tsc"
            workingDir(moduleDir)
            onlyIf { applianceExt.chmodBin.isPresent }
            // commandLine is set in doFirst so the property is read at execution time
            doFirst {
                val rel: String = applianceExt.chmodBin.get()
                val target: File = distDir.resolve(rel)
                commandLine("chmod", "+x", target.absolutePath)
            }
        }
        transpile.configure { finalizedBy(posttranspile) }
    }

    tasks.named("compile") { dependsOn(transpile) }
}
