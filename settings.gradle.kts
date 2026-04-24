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
//
// Excluded (standalone Gradle roots that publish independently):
//   packages/build-tools — already composite-included above for plugin
//     resolution; including as subproject too would double-register tasks.
//   packages/lite-filter — standalone Java library; nothing in the monorepo
//     depends on its JARs at build time.
//
// NOT excluded:
//   packages/codegen — hub-module-utils:generate invokes hub-generator, which
//     needs JARs staged into packages/codegen/bin/ by codegen's Gradle build.
//     monorepo-build's hasExistingBuildInfra() detects compileJava and wires
//     hub-module-utils:compile → packages:codegen:build automatically, ensuring
//     the JARs exist before generate runs. Codegen still publishes independently
//     from its own directory (./gradlew publish there), but the root build runs
//     its Gradle build as a dependency of consumers.
val excluded = setOf(
    "packages/build-tools",
    "packages/lite-filter",
)
val packages = Workspace.discoverWorkspaces(settings.rootDir)
    .filterValues { it.relDir !in excluded }
for ((_, pkg) in packages) {
    val gradlePath = ":" + pkg.relDir.replace("/", ":")
    include(gradlePath)
    project(gradlePath).projectDir = pkg.dir
}
println("zb.monorepo: included ${packages.size} workspace packages from ${settings.rootDir.name}")
