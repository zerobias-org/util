// settings.gradle.kts for org/util
// Phase 3: org/util is the meta-repo containing build-tools and zbb itself.
// It uses the same monorepo Gradle plugins as the consumer repos —
// includeBuild points at the local build-tools project (a sibling
// workspace), not a relative path.

import com.zerobias.buildtools.monorepo.Workspace

// ── 1. pluginManagement: project plugins resolved via includeBuild ──
//     Settings plugins can't be loaded from a composite build, so the
//     buildscript classpath below loads build-tools directly for the
//     workspace discovery code.
pluginManagement {
    val localBuildTools = file("packages/build-tools")
    if (localBuildTools.exists()) {
        includeBuild(localBuildTools)
    }
    repositories {
        maven {
            url = uri("https://maven.pkg.github.com/zerobias-org/util")
            credentials {
                username = System.getenv("GITHUB_ACTOR") ?: "zerobias-org"
                password = System.getenv("READ_TOKEN")
                    ?: System.getenv("NPM_TOKEN")
                    ?: System.getenv("GITHUB_TOKEN")
                    ?: ""
            }
        }
        gradlePluginPortal()
        mavenCentral()
    }
    plugins {
        id("zb.monorepo-base") version "1.+"
        id("zb.monorepo-gate") version "1.+"
        id("zb.monorepo-build") version "1.+"
        id("zb.monorepo-publish") version "1.+"
    }
}

// ── 2. Buildscript classpath for direct Workspace.discoverWorkspaces() ──
buildscript {
    val localBuildToolsLibs = file("packages/build-tools/build/libs")
    repositories {
        if (localBuildToolsLibs.exists()) {
            flatDir { dirs(localBuildToolsLibs) }
        }
        maven {
            url = uri("https://maven.pkg.github.com/zerobias-org/util")
            credentials {
                username = System.getenv("GITHUB_ACTOR") ?: "zerobias-org"
                password = System.getenv("READ_TOKEN")
                    ?: System.getenv("NPM_TOKEN")
                    ?: System.getenv("GITHUB_TOKEN")
                    ?: ""
            }
        }
        // gradle-node-plugin (a transitive of build-tools) lives at the
        // Gradle Plugin Portal, not Maven Central. Without this repo CI
        // resolves build-tools fine but fails on the transitive dep.
        gradlePluginPortal()
        mavenCentral()
    }
    dependencies {
        if (localBuildToolsLibs.exists()) {
            val jars: Array<java.io.File> = localBuildToolsLibs.listFiles { f ->
                f.name.startsWith("build-tools-") && f.name.endsWith(".jar")
            } ?: arrayOf<java.io.File>()
            classpath(files(*jars))
        } else {
            classpath("com.zerobias:build-tools:1.+")
        }
        classpath("com.fasterxml.jackson.module:jackson-module-kotlin:2.17.2")
        classpath("org.yaml:snakeyaml:2.2")
    }
}

rootProject.name = "util"

// ── 3. Discover npm workspaces and include each as a Gradle subproject ──
//     `packages/build-tools` has its own standalone Gradle setup AND
//     is loaded into the parent via the includeBuild composite above.
//     Including it as a subproject too would double-register tasks and
//     create circular evaluation. Exclude it.
//
//     `packages/codegen` ALSO has its own standalone Gradle setup
//     (apply plugin: 'java'), but we KEEP it as a subproject — the
//     monorepo-build plugin's `hasExistingBuildInfra` check defers to
//     codegen's existing tasks (notably `test`) and skips registering
//     conflicting fallbacks. codegen's npm scripts still drive the
//     workflow; the gradle build is invoked transitively via npm.
val excluded = setOf("packages/build-tools")
val packages = Workspace.discoverWorkspaces(settings.rootDir)
    .filterValues { it.relDir !in excluded }
for ((_, pkg) in packages) {
    val gradlePath = ":" + pkg.relDir.replace("/", ":")
    include(gradlePath)
    project(gradlePath).projectDir = pkg.dir
}
println("zb.monorepo: included ${packages.size} workspace packages from ${settings.rootDir.name}")
