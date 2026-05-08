package com.zerobias.buildtools.appliance

import org.gradle.api.Project
import org.gradle.api.tasks.Exec
import org.gradle.kotlin.dsl.named
import org.gradle.kotlin.dsl.register

/**
 * Register the `bunBundle` task for an appliance TypeScript module.
 *
 * Runs `bun build.bun.ts` (the module's bun build entrypoint script) AFTER
 * `tsc -b` has populated `dist/`, so the SolidJS bundler can import from the
 * just-emitted `.d.ts` and `.js` files.
 *
 * Wires:
 *   - dependsOn `transpile` (registered by `registerTscTranspile`)
 *   - inputs: build.bun.ts, srcDir
 *   - outputs: configured output path (default `dist/index.js`)
 *   - hooks into `compile` so `build` picks it up
 *
 * @param entry entry point script, relative to module dir (default `"src/index.tsx"`)
 *              kept as a parameter for inputs tracking; the actual entry is
 *              resolved inside the module's own `build.bun.ts`.
 * @param output bundle output path, relative to module dir (default `"dist/index.js"`)
 */
fun Project.registerBunBundle(
    entry: String = "src/index.tsx",
    output: String = "dist/index.js",
) {
    val moduleDir = projectDir
    val buildBunTs = moduleDir.resolve("build.bun.ts")
    val srcDir = moduleDir.resolve("src")
    val outputFile = moduleDir.resolve(output)
    val entryFile = moduleDir.resolve(entry)

    val bunBundle = tasks.register<Exec>("bunBundle") {
        group = "lifecycle"
        description = "Bundle SolidJS app via bun build.bun.ts"
        workingDir(moduleDir)
        commandLine("bun", "build.bun.ts")
        dependsOn("transpile")
        inputs.file(buildBunTs).withPropertyName("buildBunTs")
        inputs.dir(srcDir).withPropertyName("src")
        if (entryFile.exists()) {
            inputs.file(entryFile).withPropertyName("entry")
        }
        outputs.file(outputFile)
    }

    tasks.named("compile") { dependsOn(bunBundle) }
}
