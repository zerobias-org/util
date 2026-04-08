package com.zerobias.buildtools.monorepo

import org.gradle.api.file.DirectoryProperty
import org.gradle.api.provider.Property
import org.gradle.api.services.BuildService
import org.gradle.api.services.BuildServiceParameters
import org.yaml.snakeyaml.Yaml
import java.io.File

/**
 * Per-image config from `.zbb.yaml` `monorepo.images.<relDir>:` block.
 *
 * Example:
 *   monorepo:
 *     images:
 *       server:
 *         context: image/server
 *         name: hub-server
 *         workflow: server-image-publish.yml
 */
data class DockerImageConfig(
    /** Path to the docker build context relative to repo root */
    val context: String,
    /** Image name (no tag) — final tag is "<name>:dev" during build */
    val name: String,
    /** Optional GitHub workflow file to dispatch after publish (e.g. "server-image-publish.yml") */
    val workflow: String? = null,
)

/**
 * Configuration loaded from `.zbb.yaml` `monorepo:` block.
 *
 * Defaults match what `lib/monorepo/index.ts` provides when no config is set.
 */
data class MonorepoConfig(
    val sourceFiles: List<String> = listOf("tsconfig.json"),
    val sourceDirs: List<String> = listOf("src"),
    val buildPhases: List<String> = listOf("lint", "generate", "transpile"),
    val testPhases: List<String> = listOf("test"),
    val registry: String? = null,
    val skipPublish: Set<String> = emptySet(),
    /** Map of package relDir → docker image config (only for packages that produce images). */
    val images: Map<String, DockerImageConfig> = emptyMap(),
)

/**
 * Read `.zbb.yaml` from the repo root and return the parsed monorepo config.
 * Returns defaults if the file is missing or has no `monorepo:` block.
 */
@Suppress("UNCHECKED_CAST")
fun loadMonorepoConfig(repoRoot: File): MonorepoConfig {
    val zbbFile = File(repoRoot, ".zbb.yaml")
    if (!zbbFile.exists()) return MonorepoConfig()
    return try {
        val yaml = Yaml().load<Map<String, Any?>>(zbbFile.readText())
        val mono = yaml["monorepo"] as? Map<String, Any?> ?: return MonorepoConfig()

        val imagesRaw = (mono["images"] as? Map<String, Map<String, Any?>>) ?: emptyMap()
        val images = imagesRaw.mapNotNull { (relDir, cfg) ->
            val context = cfg["context"] as? String ?: return@mapNotNull null
            val name = cfg["name"] as? String ?: return@mapNotNull null
            val workflow = cfg["workflow"] as? String
            relDir to DockerImageConfig(context = context, name = name, workflow = workflow)
        }.toMap()

        MonorepoConfig(
            sourceFiles = (mono["sourceFiles"] as? List<String>) ?: listOf("tsconfig.json"),
            sourceDirs = (mono["sourceDirs"] as? List<String>) ?: listOf("src"),
            buildPhases = (mono["buildPhases"] as? List<String>) ?: listOf("lint", "generate", "transpile"),
            testPhases = (mono["testPhases"] as? List<String>) ?: listOf("test"),
            registry = mono["registry"] as? String,
            skipPublish = ((mono["skipPublish"] as? List<String>) ?: emptyList()).toSet(),
            images = images,
        )
    } catch (_: Exception) {
        MonorepoConfig()
    }
}

/**
 * BuildService that holds the workspace graph, monorepo config, and
 * change-detection result for a single Gradle invocation.
 *
 * Lazy-initialized: each property is computed on first access. The graph
 * and change result are reused across all tasks in the build, so
 * `git ls-files`/`git diff`/`prepublish` only run once per invocation.
 *
 * Registered by `zb.monorepo-base.gradle.kts` and consumed by `-build`,
 * `-gate`, `-publish`.
 */
abstract class MonorepoGraphService : BuildService<MonorepoGraphService.Params> {
    interface Params : BuildServiceParameters {
        val repoRoot: DirectoryProperty
        val all: Property<Boolean>
        val baseRef: Property<String>
    }

    private val rootFile: File by lazy { parameters.repoRoot.get().asFile }

    val packages: Map<String, WorkspacePackage> by lazy {
        Workspace.discoverWorkspaces(rootFile)
    }

    val graph: DependencyGraph by lazy {
        Workspace.buildDependencyGraph(packages)
    }

    val config: MonorepoConfig by lazy {
        loadMonorepoConfig(rootFile)
    }

    val changeResult: ChangeDetectionResult by lazy {
        ChangeDetector.detectChanges(
            repoRoot = rootFile,
            graph = graph,
            all = parameters.all.getOrElse(false),
            overrideBase = parameters.baseRef.orNull,
        )
    }

    /** Map of Gradle subproject path → npm package name */
    val gradlePathToPackageName: Map<String, String> by lazy {
        graph.packages.entries.associate { (name, pkg) ->
            ":" + pkg.relDir.replace("/", ":") to name
        }
    }

    /** Reverse: npm package name → Gradle subproject path */
    val packageNameToGradlePath: Map<String, String> by lazy {
        gradlePathToPackageName.entries.associate { (path, name) -> name to path }
    }

    /** Is this Gradle subproject in the affected set for the current invocation? */
    fun isAffected(gradlePath: String): Boolean {
        val pkgName = gradlePathToPackageName[gradlePath] ?: return false
        return changeResult.affected.contains(pkgName)
    }
}
