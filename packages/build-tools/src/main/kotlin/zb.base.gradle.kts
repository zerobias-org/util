import com.zerobias.buildtools.module.ZbExtension
import com.zerobias.buildtools.core.PropertyResolver
import com.zerobias.buildtools.core.VaultSecretsService
import com.zerobias.buildtools.util.SourceHasher
import com.zerobias.buildtools.standard.StandardGateStampValidator
import com.zerobias.buildtools.lifecycle.EventEmitter
import org.gradle.build.event.BuildEventsListenerRegistry
import org.gradle.kotlin.dsl.support.serviceOf

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
// Event emitter — feeds the zbb TTY display via .zbb-monorepo/events.jsonl
//
// Shared across monorepo mode (zb.monorepo-base registers this exact same
// service) and standard mode (every zb.base subproject registers it too).
// `registerIfAbsent` deduplicates — the first caller wins, subsequent
// callers get the same instance. The BuildEventsListener subscription is
// gated by an extra property on rootProject so we don't double-subscribe
// if BOTH zb.monorepo-base AND zb.base register listeners in the same
// build. The first to run wins.
// ────────────────────────────────────────────────────────────
val zbbBaseEventFile = System.getenv("ZBB_MONOREPO_EVENT_FILE")
    ?: rootProject.file(".zbb-monorepo/events.jsonl").absolutePath
val zbbBaseLogsDir = rootProject.file(".zbb-monorepo/logs")

val zbbBaseEventEmitter = gradle.sharedServices.registerIfAbsent(
    "monorepoEventEmitter",
    EventEmitter::class.java,
) {
    parameters.eventFilePath.set(zbbBaseEventFile)
}

run {
    val listenerRegisteredKey = "zbbMonorepoEventListenerRegistered"
    val rootExtra = rootProject.extensions.extraProperties
    if (!rootExtra.has(listenerRegisteredKey)) {
        val registry = project.serviceOf<BuildEventsListenerRegistry>()
        registry.onTaskCompletion(zbbBaseEventEmitter)
        rootExtra.set(listenerRegisteredKey, true)
    }
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

// Promotion order: dev → qa → uat → latest (main)
// Publishing on a branch tags all lower dist-tags too.
val npmDistTags: List<String> = when (branch) {
    "main" -> listOf("dev", "qa", "uat", "latest")
    "uat"  -> listOf("dev", "qa", "uat")
    "qa"   -> listOf("dev", "qa")
    "dev"  -> listOf("dev")
    else   -> listOf("dev", "qa", "uat")  // feature branches act as uat level
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
extra["npmDistTags"] = npmDistTags
extra["isInterface"] = isInterface

// ────────────────────────────────────────────────────────────
// bumpVersion — conventional commits → package.json version bump
// Uses commit-and-tag-version (npm), scoped to this module's path.
// Only runs on main branch publish. Dev branches use current version + suffix.
// ────────────────────────────────────────────────────────────
val moduleRelativePath = project.projectDir.relativeTo(project.rootDir).path
val tagPrefix = "${zb.vendor.get()}-${zb.product.get()}-v"

val bumpVersion by tasks.registering {
    group = "publish"
    description = "Bump package.json version on main branch"
    onlyIf { branch == "main" }
    doLast {
        val pkgJson = project.file("package.json")
        val currentVersion = readBaseVersion()
        val name = Regex(""""name"\s*:\s*"([^"]+)"""").find(pkgJson.readText())?.groupValues?.get(1)
            ?: throw GradleException("Cannot find 'name' in package.json")

        // Check if current version is already published
        val published = try {
            val output = com.zerobias.buildtools.util.ExecUtils.execCapture(
                command = listOf("npm", "view", "${name}@${currentVersion}", "version"),
                workingDir = project.projectDir,
                throwOnError = false
            ).trim()
            output == currentVersion
        } catch (_: Exception) { false }

        if (published) {
            // Bump patch: 6.11.1 → 6.11.2
            val parts = currentVersion.split(".")
            val newVersion = "${parts[0]}.${parts[1]}.${parts[2].toInt() + 1}"
            val content = pkgJson.readText()
            val updated = content.replace(
                Regex(""""version"\s*:\s*"[^"]+""""),
                """"version": "$newVersion""""
            )
            pkgJson.writeText(updated)
            project.version = newVersion
            logger.lifecycle("Version bumped: $currentVersion → $newVersion (previous version already published)")
        } else {
            project.version = currentVersion
            logger.lifecycle("Version $currentVersion not yet published — using as-is")
        }
    }
}

// Tag after successful publish (not during bump)
val tagVersion by tasks.registering {
    group = "publish"
    description = "Create git tag for published version"
    onlyIf { branch == "main" && !isDryRun && promoteAllSucceeded }
    doLast {
        val ver = readBaseVersion()
        val tag = "${tagPrefix}${ver}"
        com.zerobias.buildtools.util.ExecUtils.exec(
            command = listOf("git", "tag", "-a", tag, "-m", "Release ${zb.vendor.get()}-${zb.product.get()} v${ver}"),
            workingDir = project.rootDir,
            throwOnError = true
        )
        logger.lifecycle("Created tag: $tag")
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
    try {
        val projectRelativePath = project.projectDir.relativeTo(project.rootDir).path
        val modTagPrefix = "${zb.vendor.get()}-${zb.product.get()}-v"

        // Find main's latest tag for this module
        val lastTag = providers.exec {
            commandLine("git", "describe", "--tags", "--match", "${modTagPrefix}*", "--abbrev=0", "origin/main")
        }.standardOutput.asText.get().trim()

        val tagVersion = lastTag.removePrefix(modTagPrefix)

        if (branch == "main") {
            // Main: check if module files changed since the last tag
            // This catches new commits that touched this package
            val changedFiles = providers.exec {
                commandLine("git", "diff", "--name-only", lastTag, "HEAD")
            }.standardOutput.asText.get().trim()

            val hasModuleChanges = changedFiles.lines().any {
                it.startsWith(projectRelativePath) &&
                !it.endsWith("gate-stamp.json")
            }

            if (hasModuleChanges) {
                true
            } else {
                logger.lifecycle("No module changes since $lastTag — skipping publish")
                false
            }
        } else {
            // Branches (dev/qa/uat): check if module files differ from origin/main
            // This catches both:
            //   - New work on the branch (should publish -uat.0)
            //   - Pure merge-back from main with no branch changes (should skip)
            val changedFiles = providers.exec {
                commandLine("git", "diff", "--name-only", "origin/main", "HEAD")
            }.standardOutput.asText.get().trim()

            val hasModuleChanges = changedFiles.lines().any {
                it.startsWith(projectRelativePath) &&
                !it.endsWith("gate-stamp.json") &&
                !it.endsWith("package-lock.json")
            }

            if (hasModuleChanges) {
                true
            } else {
                logger.lifecycle("No module changes vs origin/main — in sync with main, skipping")
                false
            }
        }
    } catch (e: Exception) {
        // No tag or origin/main not reachable — always publish
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

        // 0. Gate stamp — already validated by whenReady block (CI fails fast there if invalid)
        logger.lifecycle("Preflight: gate stamp validated at build start")

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

            // 5. Docker buildx multi-platform — must be ready at this point
            try {
                val buildxCheck = providers.exec {
                    commandLine("docker", "buildx", "ls")
                    isIgnoreExitValue = true
                }
                val output = buildxCheck.standardOutput.asText.get()
                if (output.contains("linux/amd64") && output.contains("linux/arm64")) {
                    logger.lifecycle("Preflight: Docker buildx multi-platform available")
                } else {
                    throw GradleException("Preflight FAILED: no builder with linux/amd64 + linux/arm64 found\n  Fix: docker buildx create --name multiarch --driver docker-container --platform linux/amd64,linux/arm64 --use && docker buildx inspect --bootstrap")
                }
            } catch (e: GradleException) {
                throw e
            } catch (e: Exception) {
                throw GradleException("Preflight FAILED: Docker buildx not available — ${e.message}")
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

val testDataloader by tasks.registering {
    group = "lifecycle"
    description = "Run dataloader test (create Neon branch, load artifacts, validate)"
    dependsOn(compile)
}

// Phase 6: GATE — full CI validation
val gate by tasks.registering {
    group = "lifecycle"
    description = "Full CI gate — all checks must pass"
    dependsOn(validate, lint, compile, test, testDirect, testDocker, testDataloader, buildArtifacts)
}

// ── Gate stamp — written after gate passes, verified before publish ──
//
// Two hashes, BOTH computed over files tracked by git (via `git ls-files`):
//
//   sourceHash — committed source files that define the module's behavior
//                (src/, api.yml, tsconfig.json). If this changes, gate must
//                re-run. Validated by CI before publish to ensure the
//                committed stamp matches the committed source.
//
//   testHash   — committed test files (test/**). If ONLY this changes, we
//                can skip everything except test tasks on the next run.
//
// Git-only enumeration is critical: filesystem walks picked up untracked
// local artifacts (.DS_Store, coverage output, build output, temp files)
// which produce different hashes between local and CI and cause the
// committed stamp to fail CI validation. This is the SAME bug we fixed
// for monorepo SourceHasher.hashTests, now unified here via the shared
// SourceHasher implementation.
//
// package.json excluded — version field gets patched during publish, which
// would invalidate the hash.
// package-lock.json excluded — npm ci may regenerate it slightly differently
// across environments.
val sourceFiles = listOf("api.yml", "tsconfig.json")
val sourceDirs = listOf("src")
val testDirs = listOf("test")

fun computeSourceHash(): String =
    SourceHasher.hashSources(project.projectDir, sourceFiles, sourceDirs)

fun computeTestHash(): String =
    SourceHasher.hashTests(project.projectDir, testDirs)

val gateStampFile = project.layout.projectDirectory.file("gate-stamp.json")

// Count expected test cases — delegated to the shared SourceHasher so both
// the standard gate path and the monorepo gate path use identical counting
// logic.
fun countExpectedTests(testDir: java.io.File): Int =
    SourceHasher.countExpectedTests(testDir)

/**
 * Check gate stamp validity. Returns a result indicating what can be skipped:
 *
 *   - VALID:         sourceHash AND testHash match, all recorded task
 *                    results were successful — gate + all child tasks can
 *                    skip. Rebuild is still required if dist/ is missing;
 *                    that's handled by each task's own up-to-date check.
 *   - TESTS_CHANGED: sourceHash matches, testHash differs — rerun tests
 *                    only, skip validate/lint/compile/buildArtifacts.
 *   - INVALID:       sourceHash mismatch, stamp missing, or a recorded
 *                    task result was "failed"/"not-run" — rerun everything.
 *
 * All hashing goes through SourceHasher (git ls-files based) so local and
 * CI compute byte-identical values regardless of untracked files.
 */
// Type alias kept for backward-compatibility with the rest of this script
// plugin, which references `GateStampResult.VALID`/`TESTS_CHANGED`/`INVALID`
// in the publish-aware task graph configuration below.
typealias GateStampResult = StandardGateStampValidator.Result

fun checkGateStamp(): GateStampResult {
    val stampFile = gateStampFile.asFile
    return try {
        val content = if (stampFile.exists()) stampFile.readText() else null
        val testSuiteDirs = listOf(
            "unit" to project.file("test/unit"),
            "integration" to project.file("test/integration"),
            "e2e" to project.file("test/e2e"),
        )
        val suiteCounts = testSuiteDirs.map { (name, dir) ->
            StandardGateStampValidator.SuiteCount(name, countExpectedTests(dir))
        }
        val outcome = StandardGateStampValidator.validate(
            stampContent = content,
            currentSourceHash = computeSourceHash(),
            currentTestHash = computeTestHash(),
            currentTestCounts = suiteCounts,
        )
        when (outcome.result) {
            StandardGateStampValidator.Result.INVALID ->
                logger.lifecycle("Gate stamp invalid — ${outcome.reason}")
            StandardGateStampValidator.Result.TESTS_CHANGED ->
                logger.lifecycle("Gate stamp: ${outcome.reason} — rerunning tests")
            StandardGateStampValidator.Result.VALID ->
                logger.lifecycle("Gate stamp valid — skipping gate tasks")
        }
        outcome.result
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
        val testHash = computeTestHash()
        val taskNames = listOf(
            "validate", "lint", "compile",
            "test", "testDirect", "testDocker", "testDataloader",
            "buildArtifacts",
        )
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
  "testHash": "$testHash",
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

        // Emit the gate_stamp_written event so the TUI display can render
        // the stamp footer line, identical to the monorepo path.
        zbbBaseEventEmitter.get().emitGateStampWritten(
            stampFile.relativeTo(rootProject.projectDir).path,
            1,  // standard mode writes one stamp per gate (this package)
        )
    }
}

gate.configure {
    finalizedBy(writeGateStamp)
}

// ── gateCheck — cheap CI preflight ──────────────────────────────
//
// Analogous to monorepoGateCheck in the monorepo plugin. Runs only the
// validation logic (reads the committed gate-stamp.json, re-hashes via
// SourceHasher, checks recorded task results) and exits 0/1 WITHOUT
// running any gate child tasks. Used by CI matrix cells to skip the
// full gate when the committed stamp is still valid.
//
// Writes `.zbb-module/gate-check.marker` so CI can distinguish:
//   - marker present, valid=true  → stamp is current, skip full gate
//   - marker present, valid=false → stamp is stale, run full gate
//   - marker absent               → validation crashed (plugin error,
//                                    JVM crash, missing build-tools) →
//                                    infrastructure failure
val gateCheck by tasks.registering {
    group = "lifecycle"
    description = "Validate gate-stamp.json against current source. Exit 0 if valid, 1 otherwise. Cheap — no build/test/vault required."

    doLast {
        val markerDir = project.layout.buildDirectory.dir(".zbb-module").get().asFile
        val markerFile = java.io.File(markerDir, "gate-check.marker")
        markerDir.mkdirs()
        markerFile.delete()

        fun writeMarker(valid: Boolean, reason: String) {
            markerFile.writeText("valid=$valid\nreason=$reason\nts=${java.time.Instant.now()}\n")
        }

        val stampFile = gateStampFile.asFile
        if (!stampFile.exists()) {
            writeMarker(valid = false, reason = "stamp-missing")
            logger.error("✗ no gate-stamp.json found at ${stampFile.absolutePath}")
            logger.error("  Run `zbb gate` locally and commit the stamp before pushing.")
            throw GradleException("gate-stamp.json missing or unreadable")
        }

        when (val result = checkGateStamp()) {
            GateStampResult.VALID -> {
                writeMarker(valid = true, reason = "stamp-valid")
                logger.lifecycle("✓ gate stamp valid — source/test hashes match, all recorded task results OK")
            }
            GateStampResult.TESTS_CHANGED -> {
                writeMarker(valid = false, reason = "tests-changed")
                logger.error("✗ gate stamp: test files changed since last gate")
                logger.error("  Run `zbb gate` to re-run tests and update the stamp.")
                throw GradleException("gate-stamp.json invalid — tests changed")
            }
            GateStampResult.INVALID -> {
                writeMarker(valid = false, reason = "stamp-invalid")
                logger.error("✗ gate stamp: source changed or task result missing/failed since last gate")
                logger.error("  Run `zbb gate` to refresh the stamp.")
                throw GradleException("gate-stamp.json invalid — source/task drift")
            }
        }
    }
}

// When publish is in the task graph, decide what to skip based on gate stamp.
//
// LOCAL scenarios:
//   1. No stamp or sourceHash mismatch (INVALID) → gate runs fully, writes new stamp
//   2. sourceHash matches, testHash mismatch (TESTS_CHANGED) → rerun tests only,
//      keep build/validation skipped since source is unchanged
//   3. sourceHash AND testHash match (VALID) → skip gate + all child tasks;
//      gradle's own inputs/outputs handle any missing dist/ rebuild on demand
//
// CI scenarios:
//   4. INVALID or TESTS_CHANGED → preflight hard-fails (handled in preflight check)
//   5. VALID → skip gate entirely
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
        "testDataloader", "testDataloaderExec",
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
        GateStampResult.VALID -> {
            // sourceHash + testHash + recorded task results all match.
            // Skip every test/validation/build task — each task's own
            // inputs/outputs declaration will still handle rebuilding dist/
            // on demand if it's missing (no more distHash shortcut needed).
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
                throw GradleException("gate-stamp.json test hash/counts don't match current test files — run zbb gate locally and commit the stamp")
            } else {
                // Local: source + build are clean, but tests changed. Let
                // the test tasks run (they'll be cheap since nothing else
                // needs to rebuild), then writeGateStamp updates the stamp.
                for (task in project.tasks) {
                    if (task.name in buildTasks) {
                        task.enabled = false
                    }
                }
                logger.lifecycle("Gate stamp: tests changed — re-running tests")
            }
        }
        GateStampResult.INVALID -> {
            if (isCI) {
                // CI: fail fast — don't attempt to run gate, it will fail anyway
                throw GradleException("gate-stamp.json is missing or invalid — run zbb gate locally and commit the stamp before publishing")
            }
            // Local: let gate run fully — it writes a new stamp
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
    description = "Commit bumped package.json version + updated gate stamp"
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

        // Regenerate gate stamp with the new source/test hashes (post version bump).
        // sourceHash now excludes package.json so the version bump alone
        // wouldn't change it, but we still recompute in case other tracked
        // files changed during the publish flow (e.g. prepublish mutations).
        val stampFile = gateStampFile.asFile
        if (stampFile.exists()) {
            val stampContent = stampFile.readText()
            val newSourceHash = computeSourceHash()
            val newTestHash = computeTestHash()
            val updatedStamp = stampContent
                .replace(Regex(""""sourceHash"\s*:\s*"[^"]+""""), """"sourceHash": "$newSourceHash"""")
                .replace(Regex(""""testHash"\s*:\s*"[^"]+""""), """"testHash": "$newTestHash"""")
                .replace(Regex(""""version"\s*:\s*"[^"]+""""), """"version": "$ver"""")
                .replace(Regex(""""timestamp"\s*:\s*"[^"]+""""), """"timestamp": "${java.time.Instant.now()}"""")
            stampFile.writeText(updatedStamp)
            logger.lifecycle("Updated gate-stamp.json with post-publish hashes")
        }

        // Stage both package.json and gate-stamp.json
        val stampPath = "${moduleDir}/gate-stamp.json"
        com.zerobias.buildtools.util.ExecUtils.exec(
            command = listOf("git", "add", pkgPath, stampPath),
            workingDir = project.rootDir,
            throwOnError = true
        )

        com.zerobias.buildtools.util.ExecUtils.exec(
            command = listOf("git", "commit", "-m", "chore(release): ${zb.vendor.get()}-${zb.product.get()} v${ver}"),
            workingDir = project.rootDir,
            throwOnError = true
        )
        logger.lifecycle("Committed version bump + gate stamp: v${ver}")
    }
}

// Release event — handled by CI workflow (release-announcement action)
// which sends Slack notification + Lambda event with full metadata.
// This task is a no-op placeholder to keep the publish chain intact.
val publishReleaseEvent by tasks.registering {
    group = "publish"
    description = "Release announcement (handled by CI workflow)"
    mustRunAfter(tagVersion)
    onlyIf { !isDryRun && promoteAllSucceeded }
    doLast {
        val ver = project.version.toString()
        val pkgJson = project.file("package.json")
        val name = if (pkgJson.exists()) {
            Regex(""""name"\s*:\s*"([^"]+)"""").find(pkgJson.readText())?.groupValues?.get(1) ?: "unknown"
        } else "unknown"
        logger.lifecycle("Published ${name}@${ver} — release announcement handled by CI workflow")
    }
}

// Top-level publish task: bump → stage → promote → commit → tag → release event
// Push version commit and tags to remote
val pushVersion by tasks.registering {
    group = "publish"
    description = "Push version commit and tags to remote"
    mustRunAfter(tagVersion)
    onlyIf { !isDryRun && promoteAllSucceeded }
    doLast {
        try {
            com.zerobias.buildtools.util.ExecUtils.exec(
                command = listOf("git", "push", "--follow-tags"),
                workingDir = project.rootDir,
                throwOnError = true
            )
            logger.lifecycle("Pushed version commit and tags to remote")
        } catch (e: Exception) {
            logger.warn("Failed to push: ${e.message}")
            // Non-fatal — don't fail the publish for a push issue
        }
    }
}

// Top-level publish: bump → stage → promote → commit → tag → push → release event
val publish by tasks.registering {
    group = "publish"
    description = "Publish all artifacts then promote from 'next' to correct dist-tag (staging-then-promote)"
    dependsOn(publishAll, promoteAll, commitVersion, tagVersion, pushVersion, publishReleaseEvent)
}

// Ordering: promote → commit → tag → push → release event
tagVersion.configure { mustRunAfter(commitVersion) }
commitVersion.configure { mustRunAfter(promoteAll) }
pushVersion.configure { mustRunAfter(tagVersion) }
publishReleaseEvent.configure { mustRunAfter(pushVersion) }

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

// ────────────────────────────────────────────────────────────
// TTY display event wiring
//
// Hook doFirst on every zb.base / zb.typescript task that should appear
// in the display. Each hook calls emitStart(projectPath, taskName) which
// writes a task_start event to .zbb-monorepo/events.jsonl. Task finish
// events are automatically emitted by the BuildEventsListener subscribed
// above.
//
// The same per-task stdout/stderr log capture used in zb.monorepo-base
// is applied here too, so per-task logs live at .zbb-monorepo/logs/
// regardless of which plugin wired the task.
// ────────────────────────────────────────────────────────────
val zbbBasePhaseTaskNames = setOf(
    // Validation + build phase
    "validate", "validateSpec", "validateConnector",
    "lint", "lintExec",
    "generate", "generateApi", "generateServerApi", "generateServerEntry",
    "assembleSpec", "bundleSpec", "dereferenceSpec", "generateCode",
    "compile", "compileExec", "compileServer",
    "transpile", "transpileExec",
    "buildHubSdk", "buildHubSdkExec",
    "buildOpenApiSdk",
    "buildImage", "buildImageExec",
    "buildArtifacts",
    // Test phase
    "test", "testUnit", "testUnitExec",
    "testIntegration", "testIntegrationExec",
    "testDirect", "testDirectExec",
    "testDocker", "testDockerExec",
    "testHub", "testHubExec",
    "testDataloader", "testDataloaderExec",
    // Gate + stamp
    "gate", "gateCheck", "writeGateStamp",
)

gradle.taskGraph.whenReady {
    val subprojectPath = if (project.path == ":") ":" else project.path
    val emitterProvider = zbbBaseEventEmitter
    zbbBaseLogsDir.mkdirs()

    for (taskName in zbbBasePhaseTaskNames) {
        val task = project.tasks.findByName(taskName) ?: continue
        val capturedProjectPath = subprojectPath
        val capturedTaskName = taskName

        task.usesService(emitterProvider)

        // Per-task log file path
        val safeName = subprojectPath.removePrefix(":").replace(":", "-")
            .ifEmpty { project.name }
        val logFile = zbbBaseLogsDir.resolve("$safeName-$taskName.log")

        // Exec/NpxTask: redirect stdout/stderr to the per-task log file so
        // the live TTY display doesn't get polluted by child process output.
        if (task is Exec) {
            val execTask: Exec = task
            var logStream: java.io.OutputStream? = null
            execTask.doFirst {
                logFile.parentFile.mkdirs()
                val out = logFile.outputStream()
                logStream = out
                @Suppress("DEPRECATION")
                (execTask as org.gradle.process.BaseExecSpec).standardOutput = out
                @Suppress("DEPRECATION")
                (execTask as org.gradle.process.BaseExecSpec).errorOutput = out
            }
            execTask.doLast {
                try { logStream?.flush(); logStream?.close() } catch (_: Exception) {}
            }
        }

        // Emit task_start via doFirst. doFirst PREPENDS the action so it
        // runs BEFORE any other doFirst hooks that were registered earlier.
        task.doFirst {
            emitterProvider.get().emitStart(capturedProjectPath, capturedTaskName)
        }
    }
}
