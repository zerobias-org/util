/**
 * Base plugin for zbb monorepo support. Applied at the root project.
 *
 * Responsibilities:
 *   - Registers the `MonorepoGraphService` BuildService that holds the
 *     workspace graph, monorepo config, and change-detection result for
 *     this build invocation
 *   - Exposes the service via `extra["monorepoGraphService"]` for child
 *     plugins (`-gate`, `-build`, `-publish`) to consume
 *   - Reads command-line properties: `-Pmonorepo.all=true` and
 *     `-Pmonorepo.base=<ref>` for `--all` and `--base` from zbb
 *
 * NOT in this plugin:
 *   - Cleanse / preflight (those stay in zbb at the boundary)
 *   - Slot / vault env injection (zbb does that before invoking gradle)
 *   - Per-subproject task wiring (that's in -build, -gate, -publish)
 *
 * Usage in root build.gradle.kts:
 *   plugins {
 *       id("zb.monorepo-base")
 *   }
 *
 * The MonorepoGraphService class itself lives in
 * `com/zerobias/buildtools/monorepo/MonorepoGraphService.kt` so it can
 * be imported by sibling precompiled plugins.
 */

import com.zerobias.buildtools.monorepo.MonorepoGraphService

val monorepoAll = (project.findProperty("monorepo.all") as? String)?.toBoolean() ?: false
val monorepoBase = project.findProperty("monorepo.base") as? String

val graphService = gradle.sharedServices.registerIfAbsent(
    "monorepoGraph",
    MonorepoGraphService::class.java
) {
    parameters.repoRoot.set(rootProject.layout.projectDirectory)
    parameters.all.set(monorepoAll)
    monorepoBase?.let { parameters.baseRef.set(it) }
}

extensions.extraProperties["monorepoGraphService"] = graphService

gradle.projectsEvaluated {
    val service = graphService.get()
    val packages = service.packages
    println("zb.monorepo-base: ${packages.size} workspace packages discovered")
    if (monorepoAll) {
        println("  --all mode: affecting all ${packages.size} packages")
    } else {
        val affected = service.changeResult.affected.size
        val base = service.changeResult.baseRef
        println("  base: $base, affected: $affected/${packages.size}")
    }
}
