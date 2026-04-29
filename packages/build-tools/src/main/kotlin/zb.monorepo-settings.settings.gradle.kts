/**
 * Settings plugin for zbb monorepos.
 *
 * Reads the root `package.json` workspaces field, expands globs, and includes
 * each npm workspace package as a Gradle subproject. Replaces hand-rolled
 * `include(...)` blocks in repos that opt into the new monorepo flow.
 *
 * Usage in `settings.gradle.kts`:
 *   plugins {
 *       id("zb.monorepo-settings")
 *   }
 *
 * After the plugin runs, every npm workspace package becomes a Gradle
 * subproject keyed by its relDir with `/` → `:` (e.g. "packages/dynamodb"
 * becomes ":packages:dynamodb").
 */

import com.zerobias.buildtools.monorepo.Workspace

val rootPackageJson = settings.rootDir.resolve("package.json")
if (!rootPackageJson.exists()) {
    throw GradleException(
        "zb.monorepo-settings: no package.json found at ${settings.rootDir.absolutePath}. " +
        "This plugin must be applied to a directory containing an npm workspace root."
    )
}

val packages = try {
    Workspace.discoverWorkspaces(settings.rootDir)
} catch (e: Exception) {
    throw GradleException("zb.monorepo-settings: failed to discover workspaces: ${e.message}", e)
}

if (packages.isEmpty()) {
    throw GradleException(
        "zb.monorepo-settings: no workspace packages discovered in ${settings.rootDir.absolutePath}. " +
        "Check the `workspaces` field in your root package.json."
    )
}

// Convert each package's relDir into a Gradle subproject path.
// "packages/dynamodb" → ":packages:dynamodb"
// "core" → ":core"
for ((_, pkg) in packages) {
    val gradlePath = ":" + pkg.relDir.replace("/", ":")
    include(gradlePath)
    project(gradlePath).projectDir = pkg.dir
}

println("zb.monorepo-settings: included ${packages.size} workspace packages as Gradle subprojects")
