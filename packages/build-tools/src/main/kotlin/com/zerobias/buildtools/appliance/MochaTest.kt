package com.zerobias.buildtools.appliance

import com.github.gradle.node.npm.task.NpxTask
import org.gradle.api.Project
import org.gradle.kotlin.dsl.register

/**
 * Register the `testUnit` task for an appliance TypeScript module.
 *
 * Runs `mocha <testGlob>` via npx (using the nvm-managed Node from
 * `zb.typescript-base`).
 *
 * Sets `TSX_TSCONFIG_PATH=tsconfig.test.json` so the loader picks up test
 * compiler settings (matches the legacy npm script chain).
 *
 * Wires:
 *   - dependsOn `transpile`
 *   - inputs: srcDir, testDir
 *   - aggregates into Gradle base's `test` task (the `zb.typescript-base`
 *     plugin always registers a `test` umbrella; this function appends to it)
 *
 * @param testGlob mocha pattern, relative to module dir
 *                 (default `test/unit` recursive `.test.ts`)
 */
fun Project.registerMochaTest(testGlob: String = "test/unit/**/*.test.ts") {
    val moduleDir = projectDir
    val srcDir = moduleDir.resolve("src")
    val testDir = moduleDir.resolve("test")
    val unitTestDir = moduleDir.resolve("test/unit")
    val pkgJson = moduleDir.resolve("package.json")

    val testUnit = tasks.register<NpxTask>("testUnit") {
        group = "verification"
        description = "Run mocha unit tests ($testGlob)"
        workingDir.set(moduleDir)
        command.set("mocha")
        args.set(listOf(testGlob))
        environment.put("TSX_TSCONFIG_PATH", "tsconfig.test.json")
        dependsOn("transpile")
        inputs.dir(srcDir).withPropertyName("src")
        if (testDir.exists()) {
            inputs.dir(testDir).withPropertyName("test")
        }
        // Skip cleanly when the module isn't set up to run mocha. Modules
        // qualify when they (a) have a test/unit directory AND (b) declare
        // `mocha` as a devDependency. cli/node/ui all fail one of those:
        // cli ships .test.ts orphans without chai/mocha installed; node and
        // ui never had unit tests.
        onlyIf {
            unitTestDir.exists() &&
                pkgJson.exists() &&
                pkgJson.readText().contains(Regex("""\"mocha\"\s*:\s*\""""))
        }
    }

    // Append to the `test` aggregate registered by `zb.typescript-base`.
    tasks.named("test").configure { dependsOn(testUnit) }
}
