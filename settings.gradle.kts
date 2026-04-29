// settings.gradle.kts for org/util
// Phase 3: org/util is the meta-repo containing build-tools and zbb itself.
// It uses the same monorepo Gradle plugins as the consumer repos —
// includeBuild points at the local build-tools project (a sibling
// workspace), not a relative path.

import com.zerobias.buildtools.monorepo.Workspace

// ── 1. pluginManagement: build-tools is treated as a normal Maven dep ──
//     Resolution order: mavenLocal first (so a fresh `publishToMavenLocal`
//     in packages/build-tools wins), then GitHub Packages (CI / fresh
//     clones), then plugin portal / Maven Central. Version range `1.+`
//     picks the highest available patch from whichever repo serves it.
//
//     Composite includeBuild is intentionally NOT used here: it overrides
//     the Maven coordinate with the local source tree and discards the
//     version range, which causes "always pick latest" semantics to
//     silently break and shadows freshly-published mavenLocal jars with
//     whatever the auto-bump in build-tools/build.gradle.kts produced
//     this run (often 1.0.0 when the registry query can't reach the
//     network). To iterate on build-tools locally:
//
//       cd packages/build-tools && ./gradlew publishToMavenLocal
//       cd ../..                && ./gradlew <task>
pluginManagement {
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
    plugins {
        id("zb.monorepo-base") version "1.+"
        id("zb.monorepo-gate") version "1.+"
        id("zb.monorepo-build") version "1.+"
        id("zb.monorepo-publish") version "1.+"
        id("zb.maven-central-publish") version "1.+"
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
