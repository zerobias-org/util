package com.zerobias.buildtools.monorepo

import org.gradle.api.file.DirectoryProperty
import org.gradle.api.provider.Property
import org.gradle.api.services.BuildService
import org.gradle.api.services.BuildServiceParameters
import org.yaml.snakeyaml.Yaml
import java.io.File

/**
 * Per-image config from `zbb.yaml` `monorepo.images.<relDir>:` block.
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
 * Per-substack docker build config from `zbb.yaml` `substacks.<name>.docker:`.
 *
 * Marks a substack as producing a Docker image during `zbb build`/`gate`/`dockerBuild`.
 * The `package` field selects which workspace package the image is built from
 * (must match the last segment of a workspace package's relDir).
 *
 * Example:
 *   substacks:
 *     hydra-service:
 *       compose: ...
 *       docker:
 *         package: app
 *         image: hydra-app
 *         context: image/server
 */
data class SubstackDockerConfig(
    /** Workspace package short-name (last segment of relDir) that this image is built from */
    val pkg: String,
    /** Docker image name (no tag) — final tag is "<image>:dev" during local build */
    val image: String,
    /** Path to the docker build context relative to repo root */
    val context: String,
)

/**
 * Configuration loaded from `zbb.yaml` `monorepo:` block.
 *
 * Defaults match what the legacy TS path used to provide when no config was set.
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
    /** Map of substack name → docker build config (only for substacks with a `docker:` block). */
    val substacksDocker: Map<String, SubstackDockerConfig> = emptyMap(),
)

/**
 * Read `zbb.yaml` from the repo root and return the parsed monorepo config.
 * Returns defaults if the file is missing or has no `monorepo:` block.
 */
@Suppress("UNCHECKED_CAST")
fun loadMonorepoConfig(repoRoot: File): MonorepoConfig {
    val zbbFile = File(repoRoot, "zbb.yaml")
    if (!zbbFile.exists()) return MonorepoConfig()
    return try {
        val yaml = Yaml().load<Map<String, Any?>>(zbbFile.readText())
        val mono = yaml["monorepo"] as? Map<String, Any?>

        val imagesRaw = (mono?.get("images") as? Map<String, Map<String, Any?>>) ?: emptyMap()
        val images = imagesRaw.mapNotNull { (relDir, cfg) ->
            val context = cfg["context"] as? String ?: return@mapNotNull null
            val name = cfg["name"] as? String ?: return@mapNotNull null
            val workflow = cfg["workflow"] as? String
            relDir to DockerImageConfig(context = context, name = name, workflow = workflow)
        }.toMap()

        // Parse top-level substacks: each entry may have a `docker:` block declaring
        // a buildable image. Substacks without `docker:` are runtime-only and ignored.
        val substacksRaw = (yaml["substacks"] as? Map<String, Map<String, Any?>>) ?: emptyMap()
        val substacksDocker = substacksRaw.mapNotNull { (substackName, substackCfg) ->
            val docker = substackCfg["docker"] as? Map<String, Any?> ?: return@mapNotNull null
            val pkg = docker["package"] as? String ?: return@mapNotNull null
            val image = docker["image"] as? String ?: return@mapNotNull null
            val context = docker["context"] as? String ?: return@mapNotNull null
            substackName to SubstackDockerConfig(pkg = pkg, image = image, context = context)
        }.toMap()

        MonorepoConfig(
            sourceFiles = (mono?.get("sourceFiles") as? List<String>) ?: listOf("tsconfig.json"),
            sourceDirs = (mono?.get("sourceDirs") as? List<String>) ?: listOf("src"),
            buildPhases = (mono?.get("buildPhases") as? List<String>) ?: listOf("lint", "generate", "transpile"),
            testPhases = (mono?.get("testPhases") as? List<String>) ?: listOf("test"),
            registry = mono?.get("registry") as? String,
            skipPublish = ((mono?.get("skipPublish") as? List<String>) ?: emptyList()).toSet(),
            images = images,
            substacksDocker = substacksDocker,
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

    /**
     * Map of workspace package short-name (last segment of relDir) →
     * SubstackDockerConfig of the substack that builds an image from it.
     *
     * Empty if no substack declares a `docker:` block. The short-name lookup
     * lets `zb.monorepo-build` cheaply ask "should I register dockerBuild for
     * this subproject?" without re-walking the substacks map.
     *
     * If two substacks reference the same package (which would be an error),
     * the last one wins — a future validation pass should reject this.
     */
    val dockerizedPackages: Map<String, SubstackDockerConfig> by lazy {
        val byShortName = mutableMapOf<String, SubstackDockerConfig>()
        for ((_, dockerCfg) in config.substacksDocker) {
            byShortName[dockerCfg.pkg] = dockerCfg
        }
        byShortName.toMap()
    }

    /** Is this Gradle subproject in the affected set for the current invocation? */
    fun isAffected(gradlePath: String): Boolean {
        val pkgName = gradlePathToPackageName[gradlePath] ?: return false
        return changeResult.affected.contains(pkgName)
    }
}
