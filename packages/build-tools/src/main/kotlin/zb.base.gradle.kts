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
// Versioning — read package.json base version, append branch suffix
// ────────────────────────────────────────────────────────────
val baseVersion: String = project.file("package.json").let { f ->
    if (f.exists()) {
        val text = f.readText()
        val match = Regex(""""version"\s*:\s*"([^"]+)"""").find(text)
        val raw = match?.groupValues?.get(1) ?: "0.0.0"
        raw.replace(Regex("-.*"), "") // strip any existing pre-release suffix
    } else "0.0.0"
}

val branch: String = providers.exec {
    commandLine("git", "rev-parse", "--abbrev-ref", "HEAD")
}.standardOutput.asText.get().trim()

val preReleaseCounter: String = providers.exec {
    commandLine("git", "rev-list", "--count", "HEAD", "--not", "origin/main")
}.standardOutput.asText.get().trim()

version = when (branch) {
    "main" -> baseVersion                                 // 1.2.3
    "qa"   -> "${baseVersion}-rc.${preReleaseCounter}"    // 1.2.3-rc.4
    "dev"  -> "${baseVersion}-alpha.${preReleaseCounter}" // 1.2.3-alpha.12
    else   -> "${baseVersion}-dev.${preReleaseCounter}"   // feature branches
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
// Utility tasks
// ────────────────────────────────────────────────────────────
val printVersion by tasks.registering {
    group = "lifecycle"
    description = "Print resolved version"
    doLast { println(project.version) }
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

val testDocker by tasks.registering {
    group = "lifecycle"
    description = "Run Docker-based tests via module-tester REST interface"
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
    dependsOn(validate, compile, test, buildArtifacts)
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

val publishAll by tasks.registering {
    group = "publish"
    description = "Publish all artifacts"
    dependsOn(publishNpm, publishImage)
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
