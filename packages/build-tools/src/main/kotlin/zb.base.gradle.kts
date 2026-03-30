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
        vaultAddress.set(providers.gradleProperty("vaultAddr").orElse(
            providers.environmentVariable("VAULT_ADDR").orElse("")
        ))
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

// Pre-release counter always starts at 0; resolvePreReleaseVersion increments
// only if that version is already published on the registry.
val preReleaseCounter: String = "0"

// Read base version from package.json (source of truth)
// Returns the clean semver without pre-release suffix
fun readBaseVersion(): String {
    val pkgJson = project.file("package.json")
    if (!pkgJson.exists()) {
        throw GradleException("package.json not found in ${project.projectDir} — cannot determine version")
    }
    val match = Regex(""""version"\s*:\s*"([^"]+)"""").find(pkgJson.readText())
    val raw = match?.groupValues?.get(1)
        ?: throw GradleException("Cannot find 'version' in package.json at ${pkgJson.absolutePath}")
    return raw.replace(Regex("-.*"), "")
}

// Read full version from package.json including any pre-release suffix
fun readFullVersion(): String {
    val pkgJson = project.file("package.json")
    if (!pkgJson.exists()) {
        throw GradleException("package.json not found in ${project.projectDir} — cannot determine version")
    }
    val match = Regex(""""version"\s*:\s*"([^"]+)"""").find(pkgJson.readText())
    return match?.groupValues?.get(1)
        ?: throw GradleException("Cannot find 'version' in package.json at ${pkgJson.absolutePath}")
}

val baseVersion = readBaseVersion()

// For non-main branches, resolve a pre-release version that doesn't collide
// with already-published versions on the registry.
fun resolvePreReleaseVersion(base: String, suffix: String, startCounter: Int): String {
    val pkgJson = project.file("package.json")
    if (!pkgJson.exists()) return "${base}-${suffix}.${startCounter}"
    val name = Regex(""""name"\s*:\s*"([^"]+)"""").find(pkgJson.readText())?.groupValues?.get(1)
        ?: return "${base}-${suffix}.${startCounter}"

    var counter = startCounter
    var candidate = "${base}-${suffix}.${counter}"
    // Check up to 50 increments (safety limit)
    repeat(50) {
        val exists = try {
            val output = providers.exec {
                commandLine("npm", "view", "${name}@${candidate}", "version")
                isIgnoreExitValue = true
            }.standardOutput.asText.get().trim()
            output == candidate
        } catch (e: Exception) { false }

        if (!exists) return candidate
        counter++
        candidate = "${base}-${suffix}.${counter}"
    }
    return candidate // fallback — use whatever we landed on
}

val gitCounter = preReleaseCounter.toIntOrNull() ?: 0
val fullVersion = readFullVersion()

// If package.json already has the correct branch suffix, use it directly.
// Only re-resolve if the suffix doesn't match the current branch.
val branchSuffix: String? = when (branch) {
    "main" -> null
    "qa"   -> "rc"
    "dev"  -> "dev"
    "uat"  -> "uat"
    else   -> "uat"
}

// At config time, compute version without querying registry.
// resolvePreReleaseVersion (registry check + increment) only runs during publish.
version = if (branch == "main") {
    baseVersion
} else if (branchSuffix != null && fullVersion.contains("-${branchSuffix}.")) {
    // package.json already has the right suffix (e.g. 6.11.0-uat.0) — use as-is
    fullVersion
} else {
    // Default: base version + branch suffix + git counter (no registry check)
    "${baseVersion}-${branchSuffix!!}.${gitCounter}"
}

val npmDistTag: String = when (branch) {
    "main" -> "latest"
    "qa"   -> "qa"
    "dev"  -> "dev"
    "uat"  -> "uat"
    else   -> "uat"
}

// Detect interface-only modules (no Docker build needed)
// Set "interface": true in package.json to skip all Docker tasks.
val isInterface: Boolean = run {
    val pkgJson = project.file("package.json")
    if (pkgJson.exists()) {
        Regex(""""interface"\s*:\s*true""").containsMatchIn(pkgJson.readText())
    } else false
}
if (isInterface) {
    logger.lifecycle("Interface module detected — Docker tasks will be skipped")
}

// Store as extra properties for child plugins to access
extra["npmDistTag"] = npmDistTag
extra["isInterface"] = isInterface

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
    onlyIf { branch == "main" && !(extra["isDryRun"] as Boolean) && promoteAllSucceeded }
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
// Changed-since detection — publish tasks skip unchanged modules
// On main: compares against last version tag (what changed since last release)
// On branches: always publish (dev versions are cheap, skip detection adds friction)
// ────────────────────────────────────────────────────────────
val changedSinceTag: Boolean by lazy {
    if (branch != "main") {
        true
    } else {
        try {
            // Find a tag matching this module's prefix
            val tagPrefix = "${zb.vendor.get()}-${zb.product.get()}-v"
            val lastTag = providers.exec {
                commandLine("git", "describe", "--tags", "--match", "${tagPrefix}*", "--abbrev=0")
            }.standardOutput.asText.get().trim()

            val changedFiles = providers.exec {
                commandLine("git", "diff", "--name-only", lastTag, "HEAD")
            }.standardOutput.asText.get().trim()

            val projectRelativePath = project.projectDir.relativeTo(project.rootDir).path
            changedFiles.lines().any { it.startsWith(projectRelativePath) }
        } catch (e: Exception) {
            // No matching tag found — always publish
            true
        }
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

        // 0. Gate stamp verification
        // CI: must exist and sourceHash must match — fail fast otherwise
        // Local: stamp was already validated by whenReady block; gate re-ran if needed
        val isCI = System.getenv("CI") == "true"
        val stampFile = gateStampFile.asFile
        if (isCI) {
            if (!stampFile.exists()) {
                throw GradleException("Preflight FAILED: no gate-stamp.json found — run zbb gate locally and commit the stamp")
            }
            val content = stampFile.readText()
            val stampTs = Regex(""""timestamp"\s*:\s*"([^"]+)"""").find(content)?.groupValues?.get(1) ?: "unknown"

            val stampSourceHash = Regex(""""sourceHash"\s*:\s*"([^"]+)"""").find(content)?.groupValues?.get(1)
                ?: throw GradleException("Preflight FAILED: gate-stamp.json missing sourceHash — re-run zbb gate locally")
            val currentSourceHash = computeSourceHash()
            if (stampSourceHash != currentSourceHash) {
                throw GradleException("Preflight FAILED: source changed since gate at $stampTs — run zbb gate locally and commit")
            }

            val requiredTasks = listOf("validate", "lint", "compile", "test", "buildArtifacts")
            for (taskName in requiredTasks) {
                val taskStatus = Regex(""""$taskName":\s*"([^"]+)"""").find(content)?.groupValues?.get(1)
                if (taskStatus != "passed" && taskStatus != "skipped" && taskStatus != "up-to-date") {
                    throw GradleException("Preflight FAILED: gate task '$taskName' was '${taskStatus ?: "missing"}' — run zbb gate locally")
                }
            }

            val testSuites = mapOf(
                "unit" to project.file("test/unit"),
                "integration" to project.file("test/integration"),
                "e2e" to project.file("test/e2e")
            )
            for ((suite, dir) in testSuites) {
                val currentExpected = countExpectedTests(dir)
                if (currentExpected == 0) continue
                val stampExpected = Regex(""""$suite":\s*\{[^}]*"expected":\s*(\d+)""")
                    .find(content)?.groupValues?.get(1)?.toIntOrNull()
                val stampRan = Regex(""""$suite":\s*\{[^}]*"ran":\s*(\d+)""")
                    .find(content)?.groupValues?.get(1)?.toIntOrNull()
                if (stampExpected == null || stampRan == null) {
                    throw GradleException("Preflight FAILED: gate-stamp.json missing test results for $suite — run zbb gate locally")
                }
                if (currentExpected != stampExpected) {
                    throw GradleException("Preflight FAILED: $suite test count changed ($stampExpected → $currentExpected) — run zbb gate locally")
                }
                if (stampRan != stampExpected) {
                    throw GradleException("Preflight FAILED: $suite only ran $stampRan/$stampExpected — run zbb gate locally")
                }
            }

            logger.lifecycle("Preflight: gate stamp valid (from $stampTs)")
        } else {
            // Local: stamp was handled by whenReady — just log status
            if (stampFile.exists()) {
                val content = stampFile.readText()
                val stampTs = Regex(""""timestamp"\s*:\s*"([^"]+)"""").find(content)?.groupValues?.get(1) ?: "unknown"
                logger.lifecycle("Preflight: gate stamp present (from $stampTs)")
            } else {
                logger.lifecycle("Preflight: gate stamp written by gate (fresh run)")
            }
        }

        // 1. Registry auth — verify NPM_TOKEN is set
        val npmToken = System.getenv("NPM_TOKEN")
        if (npmToken.isNullOrBlank()) {
            throw GradleException("Preflight FAILED: NPM_TOKEN not set — npm publish requires auth")
        }
        logger.lifecycle("Preflight: NPM_TOKEN is set")

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

        // 4–8. Docker + registry checks (skip for interface modules)
        val needsDocker = !isInterface && project.file("connectionProfile.yml").exists()
        if (needsDocker) {
            // 4. Docker daemon
            try {
                val dockerCheck = providers.exec {
                    commandLine("docker", "info")
                    isIgnoreExitValue = true
                }
                if (dockerCheck.result.get().exitValue != 0) {
                    throw GradleException("Preflight FAILED: Docker daemon not running")
                }
                logger.lifecycle("Preflight: Docker daemon is running")
            } catch (e: GradleException) {
                throw e
            } catch (e: Exception) {
                throw GradleException("Preflight FAILED: Docker not available — ${e.message}")
            }

            // 5. Docker buildx multi-platform support
            val buildxFix = """
  Fix: docker buildx rm multiarch 2>/dev/null; docker buildx create --name multiarch --driver docker-container --platform linux/amd64,linux/arm64 --use && docker buildx inspect --bootstrap""".trimEnd()
            try {
                val buildxCheck = providers.exec {
                    commandLine("docker", "buildx", "inspect", "--bootstrap")
                    isIgnoreExitValue = true
                }
                val output = buildxCheck.standardOutput.asText.get()
                if (output.contains("linux/amd64") && output.contains("linux/arm64")) {
                    logger.lifecycle("Preflight: Docker buildx multi-platform available")
                } else {
                    throw GradleException("Preflight FAILED: Docker buildx missing linux/arm64 platform$buildxFix")
                }
            } catch (e: GradleException) {
                throw e
            } catch (e: Exception) {
                throw GradleException("Preflight FAILED: Docker buildx not available — ${e.message}$buildxFix")
            }

            // 6. ECR — validate env vars and actual login
            val ecrRegistry = System.getenv("ECR_REGISTRY")
            val awsRegion = System.getenv("AWS_REGION")
            if (ecrRegistry.isNullOrBlank()) {
                throw GradleException("Preflight FAILED: ECR_REGISTRY not set in slot env")
            }
            if (awsRegion.isNullOrBlank()) {
                throw GradleException("Preflight FAILED: AWS_REGION not set in slot env")
            }
            // Verify AWS identity resolves (credentials are valid)
            try {
                val identityProc = ProcessBuilder("aws", "sts", "get-caller-identity", "--region", awsRegion)
                    .redirectErrorStream(true).start()
                val identityOutput = identityProc.inputStream.bufferedReader().readText().trim()
                val identityExit = identityProc.waitFor()
                if (identityExit != 0) {
                    throw GradleException("Preflight FAILED: aws sts get-caller-identity failed — no valid AWS credentials\n  $identityOutput")
                }
                logger.lifecycle("Preflight: AWS identity verified")
            } catch (e: GradleException) {
                throw e
            } catch (e: Exception) {
                throw GradleException("Preflight FAILED: AWS credential check failed — ${e.message}")
            }

            // Verify ECR token + docker login
            try {
                val tokenProc = ProcessBuilder("aws", "ecr", "get-login-password", "--region", awsRegion)
                    .redirectErrorStream(true).start()
                val tokenOutput = tokenProc.inputStream.bufferedReader().readText().trim()
                val tokenExit = tokenProc.waitFor()
                if (tokenExit != 0 || tokenOutput.isEmpty()) {
                    throw GradleException("Preflight FAILED: aws ecr get-login-password failed (exit $tokenExit) — check AWS credentials\n  Output: $tokenOutput")
                }
                val loginProc = ProcessBuilder("docker", "login", "--username", "AWS", "--password-stdin", ecrRegistry)
                    .redirectErrorStream(true).start()
                loginProc.outputStream.bufferedWriter().use { it.write(tokenOutput) }
                val loginOutput = loginProc.inputStream.bufferedReader().readText().trim()
                val loginExit = loginProc.waitFor()
                if (loginExit != 0) {
                    throw GradleException("Preflight FAILED: docker login to ECR failed — $loginOutput")
                }
                logger.lifecycle("Preflight: ECR login successful ($ecrRegistry)")
            } catch (e: GradleException) {
                throw e
            } catch (e: Exception) {
                throw GradleException("Preflight FAILED: ECR auth check failed — ${e.message}")
            }

            // Verify ECR push permissions (describe + put)
            val imageName = zb.dockerImageName.get()
            try {
                // ecr:DescribeRepositories verifies read access
                val descProc = ProcessBuilder("aws", "ecr", "describe-repositories",
                    "--repository-names", imageName, "--region", awsRegion)
                    .redirectErrorStream(true).start()
                val descOutput = descProc.inputStream.bufferedReader().readText().trim()
                val descExit = descProc.waitFor()
                if (descExit != 0) {
                    if (descOutput.contains("RepositoryNotFoundException")) {
                        logger.lifecycle("Preflight: ECR repo '$imageName' does not exist yet (will be created)")
                        // Verify we can create repos
                        val dryCreateProc = ProcessBuilder("aws", "ecr", "describe-registry", "--region", awsRegion)
                            .redirectErrorStream(true).start()
                        val dryCreateOutput = dryCreateProc.inputStream.bufferedReader().readText().trim()
                        val dryCreateExit = dryCreateProc.waitFor()
                        if (dryCreateExit != 0 && dryCreateOutput.contains("AccessDenied")) {
                            throw GradleException("Preflight FAILED: no ECR write access — cannot create repositories\n  $dryCreateOutput")
                        }
                    } else if (descOutput.contains("AccessDenied")) {
                        throw GradleException("Preflight FAILED: AccessDenied on ECR — role lacks ecr:DescribeRepositories permission\n  $descOutput")
                    } else {
                        throw GradleException("Preflight FAILED: ECR describe-repositories failed\n  $descOutput")
                    }
                } else {
                    logger.lifecycle("Preflight: ECR repo '$imageName' exists and is accessible")
                }

                // ecr:GetAuthorizationToken already verified above (get-login-password uses it)
                // ecr:BatchCheckLayerAvailability + ecr:PutImage — dry-run not possible, but if
                // we got this far (describe + login), the role almost certainly has push perms.
                // The one gap: a role with read-only ECR. Verify with ecr:InitiateLayerUpload.
                val initProc = ProcessBuilder("aws", "ecr", "batch-check-layer-availability",
                    "--repository-name", imageName,
                    "--layer-digests", "sha256:0000000000000000000000000000000000000000000000000000000000000000",
                    "--region", awsRegion)
                    .redirectErrorStream(true).start()
                val initOutput = initProc.inputStream.bufferedReader().readText().trim()
                val initExit = initProc.waitFor()
                if (initExit != 0 && initOutput.contains("AccessDenied")) {
                    throw GradleException("Preflight FAILED: AccessDenied on ECR — role lacks push permissions (ecr:BatchCheckLayerAvailability)\n  $initOutput")
                }
                logger.lifecycle("Preflight: ECR push permissions verified")
            } catch (e: GradleException) {
                throw e
            } catch (e: Exception) {
                throw GradleException("Preflight FAILED: ECR permission check failed — ${e.message}")
            }

            // 7. GHCR — validate env vars, login, and push permissions
            val ghcrRegistry = System.getenv("GHCR_REGISTRY")
            if (ghcrRegistry.isNullOrBlank()) {
                throw GradleException("Preflight FAILED: GHCR_REGISTRY not set in slot env")
            }
            if (npmToken.isNullOrBlank()) {
                throw GradleException("Preflight FAILED: NPM_TOKEN not set — needed for GHCR push")
            }
            try {
                val loginProc = ProcessBuilder("docker", "login", "ghcr.io", "--username", "auditlogic", "--password-stdin")
                    .redirectErrorStream(true).start()
                loginProc.outputStream.bufferedWriter().use { it.write(npmToken) }
                val loginOutput = loginProc.inputStream.bufferedReader().readText().trim()
                val loginExit = loginProc.waitFor()
                if (loginExit != 0) {
                    throw GradleException("Preflight FAILED: docker login to GHCR failed — $loginOutput")
                }
                logger.lifecycle("Preflight: GHCR login successful (ghcr.io)")
            } catch (e: GradleException) {
                throw e
            } catch (e: Exception) {
                throw GradleException("Preflight FAILED: GHCR auth check failed — ${e.message}")
            }
            // docker login succeeded — GHCR push credentials are valid
        } else if (isInterface) {
            logger.lifecycle("Preflight: interface module — skipping Docker/ECR/GHCR checks")
        }

        // 8. Verify npm registry auth (whoami against the registry in .npmrc)
        try {
            // Parse registry from .npmrc — look for the scoped registry
            val npmrcFile = project.file(".npmrc")
            val registry = if (npmrcFile.exists()) {
                val registryLine = npmrcFile.readLines().firstOrNull { it.contains("registry=") && !it.startsWith("//") }
                registryLine?.substringAfter("registry=")?.trim()
            } else null

            val whoamiCmd = if (registry != null) {
                listOf("npm", "whoami", "--registry", registry)
            } else {
                listOf("npm", "whoami")
            }
            val whoami = providers.exec {
                commandLine(whoamiCmd)
                isIgnoreExitValue = true
            }
            val username = whoami.standardOutput.asText.get().trim()
            val exitCode = whoami.result.get().exitValue
            if (exitCode != 0 || username.isEmpty()) {
                throw GradleException("Preflight FAILED: npm whoami failed against ${registry ?: "default registry"} — NPM_TOKEN may be invalid or expired")
            }
            logger.lifecycle("Preflight: npm authenticated as '$username' (${registry ?: "default registry"})")
        } catch (e: GradleException) {
            throw e
        } catch (e: Exception) {
            throw GradleException("Preflight FAILED: npm auth check failed — ${e.message}")
        }

        // 9. Check if version already published (npm view — non-fatal check)
        if (pkgName != "unknown") {
            try {
                val npmView = providers.exec {
                    commandLine("npm", "view", "${pkgName}@${ver}", "version")
                    isIgnoreExitValue = true
                }
                val existing = npmView.standardOutput.asText.get().trim()
                if (existing == ver) {
                    logger.warn("Preflight WARNING: ${pkgName}@${ver} already published — publish will skip or fail with duplicate")
                } else {
                    logger.lifecycle("Preflight: ${pkgName}@${ver} not yet published")
                }
            } catch (e: Exception) {
                logger.lifecycle("Preflight: could not check registry (offline?) — proceeding")
            }
        }

        // 10. Verify .npmrc exists and points to a registry
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
    onlyIf { !isInterface }
}

// ── Docker runtime — start/stop module container for local dev ──
val startModule by tasks.registering {
    group = "docker"
    description = "Start module Docker container (use -Pport=N to set port)"
    dependsOn(buildImage)
    onlyIf { !isInterface }
}

val stopModule by tasks.registering {
    group = "docker"
    description = "Stop module Docker container"
    onlyIf { !isInterface }
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

// ── Gate stamp — written after gate passes, verified before publish ──
// Two hashes:
//   sourceHash — committed source files (src/, package.json, api.yml, etc.)
//                Used by CI to verify the stamp matches the source code.
//   distHash   — includes dist/ (build output, not committed)
//                Used locally to skip gate entirely when nothing changed.

fun hashFiles(dirs: List<String>, files: List<String>): String {
    val digest = java.security.MessageDigest.getInstance("SHA-256")
    for (name in files) {
        val f = project.file(name)
        if (f.exists()) {
            digest.update(name.toByteArray())
            digest.update(f.readBytes())
        }
    }
    for (dirName in dirs) {
        val dir = project.file(dirName)
        if (dir.exists()) {
            dir.walkTopDown()
                .filter { it.isFile }
                .sortedBy { it.relativeTo(project.projectDir).path }
                .forEach { f ->
                    val relPath = f.relativeTo(project.projectDir).path
                    digest.update(relPath.toByteArray())
                    digest.update(f.readBytes())
                }
        }
    }
    return digest.digest().joinToString("") { "%02x".format(it) }
}

val sourceFiles = listOf("package.json", "package-lock.json", "api.yml", "tsconfig.json")
val sourceDirs = listOf("src")

fun computeSourceHash(): String = hashFiles(sourceDirs, sourceFiles)
fun computeDistHash(): String = hashFiles(sourceDirs + "dist", sourceFiles)

val gateStampFile = project.layout.projectDirectory.file("gate-stamp.json")

// Collect test results from each test task's output.
// Each test exec task writes a small JSON file to build/test-results-{suite}.json.
// The gate stamp aggregates these.
/**
 * Count expected test cases by scanning for it( / it.only( / test( in test files.
 */
fun countExpectedTests(testDir: java.io.File): Int {
    if (!testDir.exists()) return 0
    val pattern = Regex("""(?:^|\s)(?:it|it\.only|test)\s*\(""")
    return testDir.walkTopDown()
        .filter { it.isFile && (it.name.endsWith(".ts") || it.name.endsWith(".js")) }
        .sumOf { file ->
            file.readLines().count { line -> pattern.containsMatchIn(line) }
        }
}

/**
 * Verify the gate stamp file: exists, valid JSON, hash matches current artifacts.
 * Returns true if publish can skip gate.
 */
/**
 * Check gate stamp validity. Returns a result indicating what can be skipped:
 *   - FULL: distHash + test counts match — skip all gate tasks (local, nothing changed)
 *   - SOURCE: sourceHash + test counts match, dist missing — skip tests, rebuild (CI path)
 *   - TESTS_CHANGED: source/dist ok but test count mismatch — need to re-run tests
 *   - INVALID: stamp stale or missing — re-run full gate
 */
enum class GateStampResult { FULL, SOURCE, TESTS_CHANGED, INVALID }

fun checkGateStamp(): GateStampResult {
    val stampFile = gateStampFile.asFile
    if (!stampFile.exists()) return GateStampResult.INVALID

    return try {
        val content = stampFile.readText()

        // 1. Verify sourceHash — source code hasn't changed
        val stampSourceHash = Regex(""""sourceHash"\s*:\s*"([^"]+)"""").find(content)?.groupValues?.get(1)
            ?: return GateStampResult.INVALID
        val currentSourceHash = computeSourceHash()
        if (stampSourceHash != currentSourceHash) {
            logger.lifecycle("Gate stamp invalid — source changed since last gate")
            return GateStampResult.INVALID
        }

        // 2. Verify all tasks passed
        val requiredTasks = listOf("validate", "lint", "compile", "test", "testDirect", "testDocker", "buildArtifacts")
        for (taskName in requiredTasks) {
            val taskStatus = Regex(""""$taskName":\s*"([^"]+)"""").find(content)?.groupValues?.get(1)
            if (taskStatus != "passed" && taskStatus != "skipped" && taskStatus != "up-to-date") {
                return GateStampResult.INVALID
            }
        }

        // 3. Verify test counts — separate from source hash since tests are in test/, not src/
        var testsMatch = true
        val testSuites = mapOf(
            "unit" to project.file("test/unit"),
            "integration" to project.file("test/integration"),
            "e2e" to project.file("test/e2e")
        )
        for ((suite, dir) in testSuites) {
            val currentExpected = countExpectedTests(dir)
            if (currentExpected == 0) continue

            val stampExpected = Regex(""""$suite":\s*\{[^}]*"expected":\s*(\d+)""")
                .find(content)?.groupValues?.get(1)?.toIntOrNull()
            val stampRan = Regex(""""$suite":\s*\{[^}]*"ran":\s*(\d+)""")
                .find(content)?.groupValues?.get(1)?.toIntOrNull()
            val stampStatus = Regex(""""$suite":\s*\{[^}]*"status":\s*"([^"]+)"""")
                .find(content)?.groupValues?.get(1)

            if (stampExpected == null || stampRan == null || stampStatus == null) { testsMatch = false; break }
            if (stampStatus != "passed" && stampStatus != "skipped") { testsMatch = false; break }
            if (currentExpected != stampExpected) {
                logger.lifecycle("Gate stamp: $suite test count changed ($stampExpected → $currentExpected)")
                testsMatch = false; break
            }
            if (stampRan != stampExpected) { testsMatch = false; break }
        }

        if (!testsMatch) {
            return GateStampResult.TESTS_CHANGED
        }

        // 4. Check distHash — if dist/ matches too, skip everything (local)
        val stampDistHash = Regex(""""distHash"\s*:\s*"([^"]+)"""").find(content)?.groupValues?.get(1)
        val currentDistHash = try { computeDistHash() } catch (_: Exception) { "" }
        if (stampDistHash != null && stampDistHash == currentDistHash) {
            logger.lifecycle("Gate stamp valid (distHash match) — skipping all gate tasks")
            return GateStampResult.FULL
        }

        logger.lifecycle("Gate stamp valid (sourceHash match) — skipping tests, rebuild required")
        GateStampResult.SOURCE
    } catch (e: Exception) {
        logger.warn("Gate stamp unreadable: ${e.message}")
        GateStampResult.INVALID
    }
}

val gateStampResult: GateStampResult by lazy { checkGateStamp() }

val writeGateStamp by tasks.registering {
    group = "lifecycle"
    description = "Write gate stamp after successful gate pass"
    mustRunAfter(gate)
    outputs.upToDateWhen { false } // Always rewrite — stamp includes timestamp and task states
    doLast {
        val sourceHash = computeSourceHash()
        val distHash = computeDistHash()
        val taskNames = listOf("validate", "lint", "compile", "test", "testDirect", "testDocker", "buildArtifacts")
        val taskResults = taskNames.map { taskName ->
            val task = project.tasks.findByName(taskName)
            val state = task?.state
            val status = when {
                state == null -> "not-found"
                state.skipped -> "skipped"
                state.executed -> "passed"
                state.upToDate -> "up-to-date"
                else -> "unknown"
            }
            """"$taskName": "$status""""
        }

        // Count expected tests from source files
        val testSuites = mapOf(
            "unit" to project.file("test/unit"),
            "integration" to project.file("test/integration"),
            "e2e" to project.file("test/e2e")
        )
        val testEntries = testSuites.map { (suite, dir) ->
            val expected = countExpectedTests(dir)
            val taskName = when (suite) {
                "unit" -> "testUnit"
                "integration" -> "testIntegration"
                "e2e" -> "testDirect"
                else -> suite
            }
            val task = project.tasks.findByName(taskName)
            val ran = task?.state?.executed == true
            val skipped = task?.state?.skipped == true
            val passed = if (ran) expected else 0
            val status = when {
                skipped || expected == 0 -> "skipped"
                ran -> "passed"
                else -> "not-run"
            }
            """      "$suite": { "expected": $expected, "ran": $passed, "status": "$status" }"""
        }

        val stamp = """{
  "version": "${project.version}",
  "branch": "$branch",
  "timestamp": "${java.time.Instant.now()}",
  "sourceHash": "$sourceHash",
  "distHash": "$distHash",
  "tasks": {
    ${taskResults.joinToString(",\n    ")}
  },
  "tests": {
${testEntries.joinToString(",\n")}
  }
}
"""
        val stampFile = gateStampFile.asFile
        stampFile.parentFile.mkdirs()
        stampFile.writeText(stamp)

        logger.lifecycle("Gate stamp written:")
        for ((suite, dir) in testSuites) {
            val expected = countExpectedTests(dir)
            if (expected > 0) {
                logger.lifecycle("  $suite: $expected/$expected passed")
            }
        }
    }
}

gate.configure {
    finalizedBy(writeGateStamp)
}

// When publish is in the task graph, decide what to skip based on gate stamp.
//
// LOCAL scenarios:
//   1. No stamp or sourceHash mismatch (INVALID) → gate runs fully, writes new stamp
//   2. sourceHash matches, distHash mismatch (SOURCE) → skip tests, rebuild
//   3. distHash matches (FULL) → skip all gate tasks
//
// CI scenarios:
//   4. No stamp or sourceHash mismatch → preflight hard-fails (handled in preflight check)
//   5. sourceHash matches → skip tests, run npm ci + build (always SOURCE in CI since no dist/)
gradle.taskGraph.whenReady {
    val publishInGraph = try {
        hasTask(tasks.named("publish").get()) ||
        hasTask(tasks.named("publishAll").get())
    } catch (_: Exception) { false }

    if (!publishInGraph) return@whenReady

    val testAndValidationTasks = setOf(
        "validate", "validateSpec", "lint", "lintExec",
        "test", "testUnit", "testUnitExec",
        "testIntegration", "testIntegrationExec",
        "testDirect", "testDirectExec",
        "testDocker", "testDockerExec",
        "testHub", "testHubExec",
        "startModule", "startModuleExec",
        "stopModule", "stopModuleExec"
    )

    val buildTasks = setOf(
        "compile", "compileExec", "compileServer",
        "buildArtifacts", "buildHubSdk", "buildHubSdkExec",
        "buildOpenApiSdk", "buildImage", "buildImageExec", "build",
        "installServerDeps", "generateServerApi", "generateServerEntry", "generateDockerfile",
        "assembleSpec", "bundleSpec", "dereferenceSpec", "generateCode",
        "npmInstall", "installDeps"
    )

    val isCI = System.getenv("CI") == "true"

    when (gateStampResult) {
        GateStampResult.FULL -> {
            // Local: distHash + test counts match — skip everything
            for (task in project.tasks) {
                if (task.name in testAndValidationTasks || task.name in buildTasks) {
                    task.enabled = false
                }
            }
            project.tasks.findByName("gate")?.enabled = false
            project.tasks.findByName("writeGateStamp")?.enabled = false
        }
        GateStampResult.SOURCE -> {
            // sourceHash + test counts match, dist missing — skip tests, rebuild
            for (task in project.tasks) {
                if (task.name in testAndValidationTasks) {
                    task.enabled = false
                }
            }
            project.tasks.findByName("gate")?.enabled = false
            project.tasks.findByName("writeGateStamp")?.enabled = false
        }
        GateStampResult.TESTS_CHANGED -> {
            if (isCI) {
                // CI: test count mismatch — fail fast (preflight will catch it)
                // Don't skip anything so preflight runs and fails with clear message
            } else {
                // Local: source is fine but tests changed — re-run tests, skip validation/build
                // Let gate run which includes tests, then writeGateStamp updates the stamp
                for (task in project.tasks) {
                    if (task.name in buildTasks) {
                        task.enabled = false
                    }
                }
                logger.lifecycle("Gate stamp: test count changed — re-running tests")
            }
        }
        GateStampResult.INVALID -> {
            // Local: let gate run fully — it writes a new stamp
            // CI: preflight will hard-fail
            logger.lifecycle("Gate stamp invalid — full gate will run")
        }
    }
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
    onlyIf { !isInterface }
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

// On branches, resolve version against registry before publishing to avoid conflicts.
// On main, bumpVersion handles this via commit-and-tag-version.
val resolvePublishVersion by tasks.registering {
    group = "publish"
    description = "Resolve a non-conflicting version for branch publish"
    onlyIf { branch != "main" && branchSuffix != null }
    doLast {
        val resolved = resolvePreReleaseVersion(baseVersion, branchSuffix!!, gitCounter)
        if (resolved != project.version.toString()) {
            logger.lifecycle("Resolved publish version: ${project.version} → $resolved")
            project.version = resolved
        }
    }
}

val publishAll by tasks.registering {
    group = "publish"
    description = "Publish all artifacts (staging -- uses --tag next)"
    dependsOn(bumpVersion, resolvePublishVersion, publishNpm, publishImage, publishSdk, publishHubSdk)
}

// Ensure version resolution runs before any publish task reads version
listOf("publishNpm", "publishImage", "publishSdk", "publishHubSdk").forEach { taskName ->
    tasks.named(taskName) { mustRunAfter(bumpVersion, resolvePublishVersion) }
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

// Shared success flags for publish pipeline coordination.
// publishAllSucceeded: gates promoteAll, commitVersion, tagVersion
// promoteAllSucceeded: gates commitVersion, tagVersion (only commit if fully promoted)
var publishAllSucceeded = false
var promoteAllSucceeded = false

// Track which npm packages were staged to 'next' (for rollback on failure)
val stagedPackages = mutableListOf<Pair<String, java.io.File>>() // (packageName, workingDir)
extra["stagedPackages"] = stagedPackages

publishAll.configure {
    doLast {
        publishAllSucceeded = true
        logger.lifecycle("All staging publishes succeeded -- ready to promote")
    }
}

// Rollback on any publish failure — remove 'next' dist-tags and revert package.json bump.
// Fires on both partial staging failure and promote failure.
gradle.buildFinished {
    if (!isDryRun && branch == "main" && stagedPackages.isNotEmpty() && !promoteAllSucceeded) {
        logger.warn("⚠ Publish pipeline failed — rolling back ${stagedPackages.size} staged package(s)")

        // Remove 'next' dist-tags for all packages that were staged
        for ((pkgName, workDir) in stagedPackages) {
            try {
                com.zerobias.buildtools.util.ExecUtils.exec(
                    command = listOf("npm", "dist-tag", "rm", pkgName, "next"),
                    workingDir = workDir,
                    throwOnError = false
                )
                logger.warn("  Removed 'next' dist-tag from $pkgName")
            } catch (e: Exception) {
                logger.warn("  Failed to remove 'next' tag from $pkgName: ${e.message}")
            }
        }

        // Revert package.json bump
        try {
            com.zerobias.buildtools.util.ExecUtils.exec(
                command = listOf("git", "checkout", "--", "package.json"),
                workingDir = project.projectDir,
                throwOnError = false
            )
            logger.warn("  Reverted package.json version bump")
        } catch (e: Exception) {
            logger.warn("  Failed to revert package.json: ${e.message}")
        }
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
    doLast {
        promoteAllSucceeded = true
        logger.lifecycle("All promotions succeeded")
    }
}

// Commit published version after successful promote
val commitVersion by tasks.registering {
    group = "publish"
    description = "Commit bumped package.json version"
    mustRunAfter(promoteAll)
    onlyIf { !isDryRun && promoteAllSucceeded }
    doLast {
        val ver = project.version.toString()
        val pkgFile = project.file("package.json")
        val moduleDir = project.projectDir.relativeTo(project.rootDir).path
        val pkgPath = "${moduleDir}/package.json"

        // Write the published version into package.json (restorePackageJson may have reverted it)
        val content = pkgFile.readText()
        val updated = content.replace(Regex(""""version"\s*:\s*"[^"]+""""), """"version": "$ver"""")
        pkgFile.writeText(updated)

        // Stage and commit
        com.zerobias.buildtools.util.ExecUtils.exec(
            command = listOf("git", "add", pkgPath),
            workingDir = project.rootDir,
            throwOnError = true
        )

        com.zerobias.buildtools.util.ExecUtils.exec(
            command = listOf("git", "commit", "-m", "chore(release): ${zb.vendor.get()}-${zb.product.get()} v${ver}"),
            workingDir = project.rootDir,
            throwOnError = true
        )
        logger.lifecycle("Committed version bump: v${ver}")
    }
}

// Publish release event to the global event router (AWS Lambda)
val publishReleaseEvent by tasks.registering {
    group = "publish"
    description = "Publish release event to event router Lambda"
    mustRunAfter(tagVersion)
    onlyIf { !isDryRun && promoteAllSucceeded }
    doLast {
        val pkgJson = project.file("package.json")
        if (!pkgJson.exists()) return@doLast

        val content = pkgJson.readText()
        val name = Regex(""""name"\s*:\s*"([^"]+)"""").find(content)?.groupValues?.get(1) ?: return@doLast
        val ver = project.version.toString()

        // Get dist-tags
        val distTags = try {
            com.zerobias.buildtools.util.ExecUtils.execCapture(
                command = listOf("npm", "view", "${name}@${ver}", "dist-tags", "--json"),
                workingDir = project.projectDir,
                throwOnError = false
            ).trim()
        } catch (e: Exception) { "{}" }

        // Get git info
        val commitHash = try {
            providers.exec { commandLine("git", "rev-parse", "HEAD") }
                .standardOutput.asText.get().trim()
        } catch (e: Exception) { "" }

        val repository = try {
            providers.exec { commandLine("git", "remote", "get-url", "origin") }
                .standardOutput.asText.get().trim()
                .replace(Regex("""\.git$"""), "")
                .replace(Regex("""^git@github\.com:"""), "https://github.com/")
        } catch (e: Exception) { "" }

        // Extract zerobias/auditmation metadata from package.json
        val zerobias = Regex(""""zerobias"\s*:\s*(\{[^}]*\})""").find(content)?.groupValues?.get(1) ?: "{}"
        val auditmation = Regex(""""auditmation"\s*:\s*(\{[^}]*\})""").find(content)?.groupValues?.get(1) ?: "{}"

        val eventId = java.util.UUID.randomUUID().toString()
        val payload = """{"body":{"id":"$eventId","service":"release","eventType":"release","name":"$name","version":"$ver","repository":"$repository","commitHash":"$commitHash","distTags":$distTags,"zerobias":$zerobias,"auditmation":$auditmation}}"""

        logger.lifecycle("Publishing release event for ${name}@${ver}")

        try {
            val result = com.zerobias.buildtools.util.ExecUtils.execCapture(
                command = listOf(
                    "aws", "lambda", "invoke",
                    "--function-name", "auditmation-event-router-events",
                    "--payload", payload,
                    "--cli-binary-format", "raw-in-base64-out",
                    "--region", "us-east-1",
                    "/dev/stdout"
                ),
                workingDir = project.projectDir,
                throwOnError = true
            ).trim()
            logger.lifecycle("Release event published: $result")
        } catch (e: Exception) {
            logger.warn("Failed to publish release event: ${e.message}")
            // Non-fatal — don't fail the publish for an event routing issue
        }
    }
}

// Top-level publish task: bump → stage → promote → commit → tag → release event
val publish by tasks.registering {
    group = "publish"
    description = "Publish all artifacts then promote from 'next' to correct dist-tag (staging-then-promote)"
    dependsOn(publishAll, promoteAll, commitVersion, tagVersion, publishReleaseEvent)
}

// Ordering: promote → commit → tag → release event
tagVersion.configure { mustRunAfter(commitVersion) }
commitVersion.configure { mustRunAfter(promoteAll) }
publishReleaseEvent.configure { mustRunAfter(tagVersion) }

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
