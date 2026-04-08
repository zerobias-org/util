/**
 * Build orchestration plugin for zbb monorepos. Applied at the root project.
 *
 * Wires up per-subproject tasks for the npm workspace dep graph:
 *   - workspaceInstall: `npm install` at the repo root, with hooks for
 *     registry injection (Phase 2.6a)
 *   - For each subproject: lint, generate, transpile, test (Exec tasks
 *     running the corresponding npm script in the package dir)
 *   - dependsOn wiring across subprojects based on internal dep graph
 *
 * Root aggregator tasks:
 *   - monorepoClean: clean every workspace package
 *   - monorepoBuild: workspaceInstall + transpile all affected packages
 *   - monorepoTest: monorepoBuild + test all affected packages
 *
 * Phase 2.6 stub: docker build phase + registry injection come in 2.6b/c.
 */

import com.zerobias.buildtools.monorepo.MonorepoGraphService
import org.gradle.api.tasks.Exec

@Suppress("UNCHECKED_CAST")
val graphService = (project.extensions.extraProperties["monorepoGraphService"]
    as org.gradle.api.provider.Provider<MonorepoGraphService>)

// ── workspaceInstall — npm install at the repo root ─────────────────

val workspaceInstall = tasks.register<Exec>("workspaceInstall") {
    group = "monorepo"
    description = "Run `npm install` at the repo root (workspace install)"
    workingDir = rootProject.projectDir
    commandLine = listOf("npm", "install")
    inputs.file(rootProject.file("package.json"))
    if (rootProject.file("package-lock.json").exists()) {
        inputs.file(rootProject.file("package-lock.json"))
    }
    outputs.dir(rootProject.file("node_modules"))
        .withPropertyName("nodeModules")
    outputs.upToDateWhen { rootProject.file("node_modules").exists() }
}

// ── Root aggregator tasks (registered now, deps wired below) ────────

val monorepoBuild = tasks.register("monorepoBuild") {
    group = "monorepo"
    description = "Build all affected workspace packages (lint + generate + transpile)"
    dependsOn(workspaceInstall)
}

val monorepoTest = tasks.register("monorepoTest") {
    group = "monorepo"
    description = "Run tests for all affected workspace packages"
    dependsOn(monorepoBuild)
}

tasks.register("monorepoClean") {
    group = "monorepo"
    description = "Clean all workspace packages (dist/, generated/, build/, tsbuildinfo)"
    doLast {
        val service = graphService.get()
        var cleaned = 0
        for ((_, pkg) in service.graph.packages) {
            for (sub in listOf("dist", "generated", "build")) {
                val target = pkg.dir.resolve(sub)
                if (target.exists()) {
                    target.deleteRecursively()
                    cleaned += 1
                }
            }
            val tsBuildInfo = pkg.dir.resolve("tsconfig.tsbuildinfo")
            if (tsBuildInfo.exists()) {
                tsBuildInfo.delete()
                cleaned += 1
            }
        }
        logger.lifecycle("monorepoClean: removed $cleaned artifacts across ${service.graph.packages.size} packages")
    }
}

// ── Per-subproject task wiring ──────────────────────────────────────
//
// Subprojects are pure npm packages with no build.gradle.kts of their own,
// so we configure them all from the root plugin during projectsEvaluated.

gradle.projectsEvaluated {
    val service = graphService.get()
    val packages = service.graph.packages
    val phases = service.config.buildPhases  // ["lint", "generate", "transpile"] by default
    val testPhases = service.config.testPhases  // ["test"] by default

    // 1. Register per-subproject phase tasks
    for ((pkgName, pkg) in packages) {
        val gradlePath = ":" + pkg.relDir.replace("/", ":")
        val subproject = rootProject.findProject(gradlePath) ?: continue

        for (phase in phases) {
            val scriptBody = pkg.scripts[phase]
            if (scriptBody.isNullOrBlank() || scriptBody.trimStart().startsWith("echo ")) {
                continue
            }
            subproject.tasks.register<Exec>(phase) {
                group = "monorepo"
                description = "Run `npm run $phase` for $pkgName"
                workingDir = pkg.dir
                commandLine = listOf("npm", "run", phase)
                dependsOn(workspaceInstall)
            }
        }

        for (testPhase in testPhases) {
            val scriptBody = pkg.scripts[testPhase]
            if (scriptBody.isNullOrBlank() || scriptBody.trimStart().startsWith("echo ")) {
                continue
            }
            subproject.tasks.register<Exec>(testPhase) {
                group = "monorepo"
                description = "Run `npm run $testPhase` for $pkgName"
                workingDir = pkg.dir
                commandLine = listOf("npm", "run", testPhase)
                dependsOn(workspaceInstall)
            }
        }
    }

    // 2. Wire per-package dependsOn across subprojects based on the npm dep graph.
    //    Lint is parallel-safe (doesn't depend on other packages' build outputs).
    val crossProjectPhases = phases.filter { it != "lint" } + testPhases
    for ((_, pkg) in packages) {
        val gradlePath = ":" + pkg.relDir.replace("/", ":")
        val subproject = rootProject.findProject(gradlePath) ?: continue
        for (phase in crossProjectPhases) {
            val task = subproject.tasks.findByName(phase) ?: continue
            for (depName in pkg.internalDeps) {
                val depPath = service.packageNameToGradlePath[depName] ?: continue
                val depProject = rootProject.findProject(depPath) ?: continue
                val depTask = depProject.tasks.findByName(phase) ?: continue
                task.dependsOn(depTask)
            }
        }
    }

    // 3. Cross-phase ordering within a subproject: transpile mustRunAfter
    //    lint+generate; test mustRunAfter transpile.
    for ((_, pkg) in packages) {
        val gradlePath = ":" + pkg.relDir.replace("/", ":")
        val subproject = rootProject.findProject(gradlePath) ?: continue
        val transpile = subproject.tasks.findByName("transpile")
        if (transpile != null) {
            listOf("lint", "generate").forEach { earlierPhase ->
                subproject.tasks.findByName(earlierPhase)?.let { transpile.mustRunAfter(it) }
            }
            subproject.tasks.findByName("test")?.mustRunAfter(transpile)
        }
    }

    // 4. Wire monorepoBuild and monorepoTest to depend on the affected subprojects
    val affected = service.changeResult.affected
    monorepoBuild.configure {
        for (pkgName in affected) {
            val gradlePath = service.packageNameToGradlePath[pkgName] ?: continue
            val subproject = rootProject.findProject(gradlePath) ?: continue
            for (phase in phases) {
                subproject.tasks.findByName(phase)?.let { dependsOn(it) }
            }
        }
    }
    monorepoTest.configure {
        for (pkgName in affected) {
            val gradlePath = service.packageNameToGradlePath[pkgName] ?: continue
            val subproject = rootProject.findProject(gradlePath) ?: continue
            for (testPhase in testPhases) {
                subproject.tasks.findByName(testPhase)?.let { dependsOn(it) }
            }
        }
    }
}
