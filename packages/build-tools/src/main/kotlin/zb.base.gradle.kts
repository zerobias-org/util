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
    dockerImageName.convention(
        vendor.zip(product) { v, p -> "${v}-${p}" }
    )
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
// Versioning — reckon plugin sets project.version at root level.
// Subprojects inherit root version. npmDistTag derived from branch.
// ────────────────────────────────────────────────────────────
val branch: String = providers.exec {
    commandLine("git", "rev-parse", "--abbrev-ref", "HEAD")
}.standardOutput.asText.get().trim()

// If reckon is applied at root, subprojects inherit rootProject.version.
// reckon MUST set the version. No fallbacks.
if (project.version == Project.DEFAULT_VERSION) {
    throw GradleException("Version is unspecified — reckon plugin not applied or no git tags. Run: git tag v0.0.0")
}

val npmDistTag: String = when (branch) {
    "main" -> "latest"
    "qa"   -> "rc"
    "dev"  -> "alpha"
    else   -> "dev"
}

// Store as extra property for child plugins to access
extra["npmDistTag"] = npmDistTag

// ────────────────────────────────────────────────────────────
// Dry-run flag — publish tasks check this to skip actual push
// Usage: ./gradlew publish -PdryRun=true
// ────────────────────────────────────────────────────────────
val isDryRun: Boolean = project.findProperty("dryRun") == "true"
extra["isDryRun"] = isDryRun

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
    description = "Remove build outputs (dist/, build/)"
    delete("dist", "build")
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
    description = "Publish all artifacts"
    dependsOn(publishNpm, publishImage, publishSdk, publishHubSdk)
}

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
