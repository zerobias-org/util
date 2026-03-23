import com.zerobias.buildtools.module.ZbExtension
import com.zerobias.buildtools.core.PropertyResolver
import com.zerobias.buildtools.core.VaultSecretsService

// ────────────────────────────────────────────────────────────
// Extension: project-level configuration
// ────────────────────────────────────────────────────────────
val zb = extensions.create<ZbExtension>("zb").apply {
    // Auto-detect vendor from parent directory name
    vendor.convention(project.projectDir.parentFile.name)
    product.convention(project.projectDir.name)
    hasConnectionProfile.convention(
        project.file("connectionProfile.yml").exists()
    )
    hasOpenApiSdk.convention(false)
    // Docker image name derived from package.json NPM name — same name the Hub Node uses.
    // @auditlogic/module-github-github → auditlogic-module-github-github
    // One name for local, ECR, GHCR, and pkg-proxy.
    dockerImageName.convention(provider {
        val pkgJson = project.file("package.json")
        if (pkgJson.exists()) {
            val match = Regex(""""name"\s*:\s*"@([^/]+)/([^"]+)"""").find(pkgJson.readText())
            if (match != null) {
                val (scope, name) = match.destructured
                "$scope-$name"
            } else {
                // No scoped name — fall back to vendor-product (non-module projects)
                "${vendor.get()}-${product.get()}"
            }
        } else {
            "${vendor.get()}-${product.get()}"
        }
    })
    includeConnectionProfileInDist.convention(false)
    generatorArgs.convention(emptyList())
}

// ────────────────────────────────────────────────────────────
// VaultSecretsService registration
// ────────────────────────────────────────────────────────────
val vaultService = gradle.sharedServices.registerIfAbsent("vaultSecrets", VaultSecretsService::class) {
    parameters {
        vaultAddress.set(providers.gradleProperty("vaultAddr").orElse("https://vault.auditmation.io:8200"))
    }
}

// ────────────────────────────────────────────────────────────
// PropertyResolver instance (lazy — only resolves when tasks execute)
// ────────────────────────────────────────────────────────────
val propertyResolver = PropertyResolver(vaultService)

// ────────────────────────────────────────────────────────────
// Versioning — package.json is the version source of truth.
// commit-and-tag-version bumps it from conventional commits.
// Branch determines pre-release suffix and npm dist-tag.
// ────────────────────────────────────────────────────────────
val branch: String = providers.exec {
    commandLine("git", "rev-parse", "--abbrev-ref", "HEAD")
}.standardOutput.asText.get().trim()

val preReleaseCounter: String = try {
    providers.exec {
        commandLine("git", "rev-list", "--count", "HEAD", "--not", "origin/main")
    }.standardOutput.asText.get().trim()
} catch (e: Exception) { "0" }

// Read base version from package.json (source of truth)
fun readBaseVersion(): String {
    val pkgJson = project.file("package.json")
    if (!pkgJson.exists()) {
        throw GradleException("package.json not found in ${project.projectDir} — cannot determine version")
    }
    val match = Regex(""""version"\s*:\s*"([^"]+)"""").find(pkgJson.readText())
    val raw = match?.groupValues?.get(1)
        ?: throw GradleException("Cannot find 'version' in package.json at ${pkgJson.absolutePath}")
    return raw.replace(Regex("-.*"), "")  // strip existing pre-release suffix
}

val baseVersion = readBaseVersion()

version = when (branch) {
    "main"   -> baseVersion                                    // 6.8.0
    "qa"     -> "${baseVersion}-rc.${preReleaseCounter}"       // 6.8.0-rc.4
    "dev"    -> "${baseVersion}-alpha.${preReleaseCounter}"    // 6.8.0-alpha.12
    else     -> "${baseVersion}-dev.${preReleaseCounter}"      // 6.8.0-dev.7
}

val npmDistTag: String = when (branch) {
    "main" -> "latest"
    "qa"   -> "rc"
    "dev"  -> "alpha"
    else   -> "dev"
}

// Store as extra properties for child plugins to access
extra["npmDistTag"] = npmDistTag

// ────────────────────────────────────────────────────────────
// bumpVersion — conventional commits → package.json version bump
// Uses commit-and-tag-version (npm), scoped to this module's path.
// Only runs on main branch publish. Dev branches use current version + suffix.
// ────────────────────────────────────────────────────────────
val moduleRelativePath = project.projectDir.relativeTo(project.rootDir).path
val tagPrefix = "${zb.vendor.get()}-${zb.product.get()}-v"

val bumpVersion by tasks.registering(Exec::class) {
    group = "publish"
    description = "Bump package.json version from conventional commits (main branch only)"
    onlyIf { branch == "main" }
    workingDir(project.rootDir)
    commandLine("npx", "commit-and-tag-version",
        "--path", moduleRelativePath,
        "--tag-prefix", tagPrefix,
        "--skip.changelog",  // changelog generation is separate concern
        "--skip.commit",     // Gradle commits after all modules bump
        "--skip.tag"         // Gradle tags after successful publish
    )
    // After bump, re-read version so project.version is current
    doLast {
        val newVersion = readBaseVersion()
        project.version = newVersion
        logger.lifecycle("Version bumped to $newVersion (from conventional commits)")
    }
}

// Tag after successful publish (not during bump)
val tagVersion by tasks.registering(Exec::class) {
    group = "publish"
    description = "Create git tag for published version"
    onlyIf { branch == "main" && !(extra["isDryRun"] as Boolean) }
    workingDir(project.rootDir)
    commandLine("echo", "placeholder")
    doFirst {
        val ver = readBaseVersion()
        commandLine("git", "tag", "${tagPrefix}${ver}")
    }
}

// ────────────────────────────────────────────────────────────
// Dry-run flag — publish tasks check this to skip actual push
// Usage: ./gradlew publish -PdryRun=true
// ────────────────────────────────────────────────────────────
val isDryRun: Boolean = project.findProperty("dryRun") == "true"
extra["isDryRun"] = isDryRun

// ────────────────────────────────────────────────────────────
// Changed-since-tag detection — publish tasks skip unchanged modules
// Uses last version tag (git describe --tags --abbrev=0), not HEAD~1
// ────────────────────────────────────────────────────────────
val changedSinceTag: Boolean by lazy {
    try {
        val lastTag = providers.exec {
            commandLine("git", "describe", "--tags", "--abbrev=0")
        }.standardOutput.asText.get().trim()

        val changedFiles = providers.exec {
            commandLine("git", "diff", "--name-only", lastTag, "HEAD")
        }.standardOutput.asText.get().trim()

        val projectRelativePath = project.projectDir.relativeTo(project.rootDir).path
        changedFiles.lines().any { it.startsWith(projectRelativePath) }
    } catch (e: Exception) {
        // No tags exist yet (bootstrap) -> treat as changed
        true
    }
}

extra["changedSinceTag"] = changedSinceTag

// ────────────────────────────────────────────────────────────
// Preflight checks — validates publish readiness
// dryRun runs these checks + logs intent (not skip-with-log)
// Real publish also runs these as a safety gate
// ────────────────────────────────────────────────────────────
val preflightChecks by tasks.registering {
    group = "publish"
    description = "Validate publish readiness: registry auth, version, Docker, working tree"
    dependsOn(gate)
    doLast {
        val ver = project.version.toString()
        val (pkgName, _) = if (project.file("package.json").exists()) {
            val text = project.file("package.json").readText()
            val nameMatch = Regex(""""name"\s*:\s*"([^"]+)"""").find(text)
            val name = nameMatch?.groupValues?.get(1) ?: "unknown"
            name to ver
        } else {
            "unknown" to ver
        }
        logger.lifecycle("Preflight: version = $ver, package = $pkgName")

        // 1. Registry auth — verify NPM_TOKEN is set
        val npmToken = System.getenv("NPM_TOKEN")
        if (npmToken.isNullOrBlank()) {
            logger.warn("Preflight WARNING: NPM_TOKEN not set — npm publish will fail")
        } else {
            logger.lifecycle("Preflight: NPM_TOKEN is set")
        }

        // 2. Check version is not "unspecified"
        if (ver == "unspecified" || ver == Project.DEFAULT_VERSION) {
            throw GradleException("Preflight FAILED: version is '$ver' — reckon not configured or no git tags")
        }
        logger.lifecycle("Preflight: version '$ver' is valid")

        // 3. Clean working tree (no uncommitted changes)
        val gitStatus = providers.exec {
            commandLine("git", "status", "--porcelain")
        }.standardOutput.asText.get().trim()
        if (gitStatus.isNotEmpty()) {
            logger.warn("Preflight WARNING: working tree is dirty:\n$gitStatus")
        } else {
            logger.lifecycle("Preflight: working tree is clean")
        }

        // 4. Docker daemon (only if connector module)
        val hasConnProfile = project.file("connectionProfile.yml").exists()
        if (hasConnProfile) {
            try {
                val dockerCheck = providers.exec {
                    commandLine("docker", "info")
                    isIgnoreExitValue = true
                }
                if (dockerCheck.result.get().exitValue != 0) {
                    logger.warn("Preflight WARNING: Docker daemon not running — image publish will fail")
                } else {
                    logger.lifecycle("Preflight: Docker daemon is running")
                }
            } catch (e: Exception) {
                logger.warn("Preflight WARNING: Docker not available — ${e.message}")
            }
        }

        // 5. AWS credentials (only if connector module — needed for ECR)
        if (hasConnProfile) {
            val awsKey = System.getenv("AWS_ACCESS_KEY_ID")
            if (awsKey.isNullOrBlank()) {
                logger.warn("Preflight WARNING: AWS_ACCESS_KEY_ID not set — ECR push will fail")
            } else {
                logger.lifecycle("Preflight: AWS credentials are set")
            }
        }

        // 6. Check if version already published (npm view — non-fatal check)
        if (!npmToken.isNullOrBlank() && pkgName != "unknown") {
            try {
                val npmView = providers.exec {
                    commandLine("npm", "view", "${pkgName}@${ver}", "version")
                    isIgnoreExitValue = true
                }
                val existing = npmView.standardOutput.asText.get().trim()
                if (existing == ver) {
                    logger.warn("Preflight WARNING: ${pkgName}@${ver} already published — publish will fail with duplicate")
                } else {
                    logger.lifecycle("Preflight: ${pkgName}@${ver} not yet published")
                }
            } catch (e: Exception) {
                logger.lifecycle("Preflight: could not check registry (offline?) — proceeding")
            }
        }

        // 7. Verify .npmrc exists and points to a registry
        val npmrc = project.file(".npmrc")
        if (!npmrc.exists()) {
            throw GradleException("Preflight FAILED: .npmrc not found in ${project.projectDir} — npm publish requires registry config")
        } else {
            val npmrcContent = npmrc.readText()
            if (!npmrcContent.contains("registry=")) {
                logger.warn("Preflight WARNING: .npmrc exists but contains no registry= line")
            } else {
                logger.lifecycle("Preflight: .npmrc found with registry config")
            }
        }

        logger.lifecycle("Preflight checks complete.")
    }
}

extra["preflightChecks"] = preflightChecks

// ────────────────────────────────────────────────────────────
// Utility tasks
// ────────────────────────────────────────────────────────────
val printVersion by tasks.registering {
    group = "lifecycle"
    description = "Print resolved version"
    doLast { println(project.version) }
}

// ────────────────────────────────────────────────────────────
// CLEAN — remove build outputs
// ────────────────────────────────────────────────────────────

val clean by tasks.registering(Delete::class) {
    group = "lifecycle"
    description = "Remove build outputs (dist/, generated/, build/)"
    delete("dist", "generated", "build")
}

// ────────────────────────────────────────────────────────────
// Lifecycle phases — ordered via dependsOn
// Flavor plugins fill in the implementations.
// ────────────────────────────────────────────────────────────

// Phase 1: VALIDATE — filled by flavor plugins
val validate by tasks.registering {
    group = "lifecycle"
    description = "Run all validation checks"
}

// LINT — code quality checks, filled by flavor plugins
val lint by tasks.registering {
    group = "lifecycle"
    description = "Run code quality checks (eslint, etc.)"
}

// Phase 2: GENERATE — filled by flavor plugins
val generate by tasks.registering {
    group = "lifecycle"
    description = "Generate code from OpenAPI specification"
    dependsOn(validate)
}

// Phase 3: COMPILE — filled by flavor plugins
val compile by tasks.registering {
    group = "lifecycle"
    description = "Compile source code"
    dependsOn(generate)
}

// Phase 4: TEST
val testUnit by tasks.registering {
    group = "lifecycle"
    description = "Run unit tests (in-process, fast)"
    dependsOn(compile)
}

val testIntegration by tasks.registering {
    group = "lifecycle"
    description = "Run integration tests (in-process, may need external deps)"
    dependsOn(compile)
}

val testDirect by tasks.registering {
    group = "lifecycle"
    description = "Run e2e tests in Direct mode (in-process, live API)"
    dependsOn(compile)
}

val testDocker by tasks.registering {
    group = "lifecycle"
    description = "Run e2e tests in Docker mode (container, wire protocol)"
    dependsOn(compile)
}

val test by tasks.registering {
    group = "lifecycle"
    description = "Run all in-process tests (unit + integration)"
    dependsOn(testUnit, testIntegration)
}

// Phase 5: BUILD ARTIFACTS
val buildHubSdk by tasks.registering {
    group = "lifecycle"
    description = "Generate hub-server caller SDK"
    dependsOn(compile)
}

val buildOpenApiSdk by tasks.registering {
    group = "lifecycle"
    description = "Generate standalone OpenAPI SDK"
    dependsOn(compile)
    onlyIf { zb.hasOpenApiSdk.get() }
}

val buildImage by tasks.registering {
    group = "lifecycle"
    description = "Build Docker image"
    dependsOn(compile)
}

// ── Docker runtime — start/stop module container for local dev ──
val startModule by tasks.registering {
    group = "docker"
    description = "Start module Docker container (use -Pport=N to set port)"
    dependsOn(buildImage)
}

val stopModule by tasks.registering {
    group = "docker"
    description = "Stop module Docker container"
}

val buildArtifacts by tasks.registering {
    group = "lifecycle"
    description = "Build all artifacts"
    dependsOn(buildHubSdk, buildOpenApiSdk, buildImage)
}

// Alias: build → buildArtifacts (standard Gradle convention)
val build by tasks.registering {
    group = "lifecycle"
    description = "Build all artifacts (alias for buildArtifacts)"
    dependsOn(buildArtifacts)
}

// Phase 6: GATE — full CI validation
val gate by tasks.registering {
    group = "lifecycle"
    description = "Full CI gate — all checks must pass"
    dependsOn(validate, lint, compile, test, testDirect, testDocker, buildArtifacts)
}

// Phase 7: PUBLISH
val publishNpm by tasks.registering {
    group = "publish"
    description = "Publish npm package to GitHub Packages"
    dependsOn(gate)
}

val publishImage by tasks.registering {
    group = "publish"
    description = "Push Docker image to registry"
    dependsOn(gate, buildImage)
}

val publishSdk by tasks.registering {
    group = "publish"
    description = "Publish generated API client SDK"
    dependsOn(gate)
}

val publishHubSdk by tasks.registering {
    group = "publish"
    description = "Publish generated Hub SDK"
    dependsOn(gate)
}

val publishAll by tasks.registering {
    group = "publish"
    description = "Publish all artifacts (staging -- uses --tag next)"
    dependsOn(bumpVersion, publishNpm, publishImage, publishSdk, publishHubSdk)
}

// Ensure bump runs before any publish task reads version
listOf("publishNpm", "publishImage", "publishSdk", "publishHubSdk").forEach { taskName ->
    tasks.named(taskName) { mustRunAfter(bumpVersion) }
}

// Guard lifecycle publish stubs: skip if module has no changes since last tag.
// Belt-and-suspenders: exec tasks also have this guard (added in flavor plugins).
// Capture at project config time -- inside tasks.named{} the `extra` refers to
// task.extra (not project.extra), so capture must be done at plugin scope.
val changedSinceTagForGuard: Boolean = extra["changedSinceTag"] as Boolean
listOf("publishNpm", "publishImage", "publishSdk", "publishHubSdk").forEach { taskName ->
    tasks.named(taskName) {
        onlyIf {
            if (!changedSinceTagForGuard) {
                logger.lifecycle("[$taskName] Skipping -- no changes since last tag")
            }
            changedSinceTagForGuard
        }
    }
}

// Shared success flag -- set by publishAll.doLast only if all dependsOn tasks succeed.
// promoteAll uses this to ensure it only runs after successful staging publish.
// IMPORTANT: Do NOT use finalizedBy(promoteAll) -- finalizedBy runs on failure too.
var publishAllSucceeded = false

publishAll.configure {
    doLast {
        // doLast only executes if publishAll and all its dependsOn succeeded
        publishAllSucceeded = true
        logger.lifecycle("All staging publishes succeeded -- ready to promote")
    }
}

val promoteAll by tasks.registering {
    group = "publish"
    description = "Promote all NPM packages from 'next' tag to correct dist-tag (only after publishAll succeeds)"
    mustRunAfter(publishAll)
    onlyIf {
        if (!publishAllSucceeded) {
            logger.lifecycle("[promoteAll] Skipping -- publishAll did not succeed or was not run")
        }
        publishAllSucceeded
    }
}

// Top-level publish task: bump → stage → promote → tag
val publish by tasks.registering {
    group = "publish"
    description = "Publish all artifacts then promote from 'next' to correct dist-tag (staging-then-promote)"
    dependsOn(publishAll, promoteAll, tagVersion)
}

// tagVersion runs after promote succeeds
tagVersion.configure { mustRunAfter(promoteAll) }

// ────────────────────────────────────────────────────────────
// Metadata sync — utility task (not in default build chain)
// Syncs package.json version/name/desc into api.yml.
// Run manually or add to publish chain.
// ────────────────────────────────────────────────────────────
val syncMeta by tasks.registering {
    group = "lifecycle"
    description = "Sync package.json metadata into api.yml info block"
    doLast {
        com.zerobias.buildtools.module.MetadataSyncer.sync(project.projectDir)
    }
}

// ────────────────────────────────────────────────────────────
// Environment bridge: export resolved properties as env vars
// to all Exec and JavaExec child processes
// ────────────────────────────────────────────────────────────
val envExports = mapOf(
    "pgHost" to "PGHOST",
    "pgPort" to "PGPORT",
    "pgUser" to "PGUSER",
    "pgPassword" to "PGPASSWORD",
    "pgDatabase" to "PGDATABASE",
    "awsRegion" to "AWS_DEFAULT_REGION",
    "npmToken" to "NPM_TOKEN",
    "writeToken" to "WRITE_TOKEN",
    "zbToken" to "ZB_TOKEN",
    "dispatchToken" to "DISPATCH_TOKEN",
    "username" to "GITHUB_USERNAME",
    "dockerRegistry" to "DOCKER_REGISTRY",
    "logLevel" to "LOG_LEVEL",
    "vaultAddr" to "VAULT_ADDR"
)

tasks.withType<Exec>().configureEach {
    doFirst {
        envExports.forEach { (prop, envVar) ->
            val value = project.findProperty(prop)?.toString()
            if (value != null) {
                environment(envVar, propertyResolver.resolve(value))
            }
        }
    }
}

tasks.withType<JavaExec>().configureEach {
    doFirst {
        envExports.forEach { (prop, envVar) ->
            val value = project.findProperty(prop)?.toString()
            if (value != null) {
                environment(envVar, propertyResolver.resolve(value))
            }
        }
    }
}
