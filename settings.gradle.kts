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
//     Same resolution order as consumer repos (com/hub, com/platform):
//     mavenLocal → GitHub Packages Maven. Use `publishToMavenLocal` from
//     packages/build-tools when developing locally.
buildscript {
    repositories {
        mavenLocal()
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
    dependencies {
        classpath("com.zerobias:build-tools:1.+")
    }
}

rootProject.name = "util"

// Env var → gradle property mapping for Sonatype/GPG credentials lives
// in each Java package's own settings.gradle.kts (build-tools,
// lite-filter, codegen). They're standalone Gradle roots — no longer
// included as monorepo subprojects here. See their settings files.

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
// Standalone Gradle roots: each has its own gradlew, settings, zbb.yaml,
// and publishes independently from its package dir. Keep them out of
// util's monorepo inclusion so root-level `zbb build` doesn't run their
// Gradle. (build-tools additionally stays composite-included via
// pluginManagement.includeBuild above so consumers in this repo resolve
// its convention plugins.)
val excluded = setOf(
    "packages/build-tools",
    "packages/lite-filter",
    "packages/codegen",
)
val packages = Workspace.discoverWorkspaces(settings.rootDir)
    .filterValues { it.relDir !in excluded }
for ((_, pkg) in packages) {
    val gradlePath = ":" + pkg.relDir.replace("/", ":")
    include(gradlePath)
    project(gradlePath).projectDir = pkg.dir
}
println("zb.monorepo: included ${packages.size} workspace packages from ${settings.rootDir.name}")
