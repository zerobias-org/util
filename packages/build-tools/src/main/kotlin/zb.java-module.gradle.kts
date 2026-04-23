import com.zerobias.buildtools.module.ZbExtension
import com.zerobias.buildtools.module.ManifestPatcher

plugins {
    id("zb.typescript")
}

val zb = extensions.getByType<ZbExtension>()

// ── VALIDATE ──

val validatePom by tasks.registering {
    group = "lifecycle"
    description = "Validate pom.xml exists in java/ directory"
    doLast {
        require(project.file("java/pom.xml").exists()) {
            "Java HTTP modules must have java/pom.xml"
        }
    }
}

tasks.named("validate") {
    dependsOn(validatePom)
}

// ════════════════════════════════════════════════════════════
// G9: Patch manifest — set implementationType for java-http
// ════════════════════════════════════════════════════════════

val patchManifest by tasks.registering {
    group = "lifecycle"
    description = "Patch generated manifest.json with implementationType=java-http"
    dependsOn(tasks.named("generateApi"))
    doLast {
        ManifestPatcher.patchField(
            project.file("generated/api/manifest.json"),
            "implementationType",
            "java-http"
        )
    }
}

tasks.named("generate") {
    dependsOn(patchManifest)
}

// ════════════════════════════════════════════════════════════
// COMPILE — Maven build (after TypeScript transpile)
// ════════════════════════════════════════════════════════════

val mavenBuild by tasks.registering(Exec::class) {
    group = "lifecycle"
    description = "Build Java module with Maven"
    dependsOn(tasks.named("transpile"))
    workingDir(project.file("java"))
    commandLine("mvn", "clean", "package", "-DskipTests", "-U")
    // Declare inputs/outputs so gradle tracks the jar properly. Without this,
    // downstream tasks (buildImageExec) treat the jar as implicit state and
    // never invalidate their own up-to-date check when java sources change.
    inputs.dir(project.file("java/src"))
    inputs.file(project.file("java/pom.xml"))
    outputs.dir(project.file("java/target"))
}

tasks.named("compile") {
    dependsOn(mavenBuild)
}

// Wire the maven-built jar as an input to buildImageExec so Docker image
// rebuilds when the jar content changes. Without this, buildImageExec only
// tracks Dockerfile/dist/package.json and stays "UP-TO-DATE" forever after
// the first successful build, silently testing stale code.
tasks.named("buildImageExec") {
    inputs.dir(project.file("java/target"))
}

// ════════════════════════════════════════════════════════════
// TEST — Maven tests
// ════════════════════════════════════════════════════════════

val mavenTestUnit by tasks.registering(Exec::class) {
    group = "lifecycle"
    description = "Run Maven unit tests (surefire)"
    dependsOn(mavenBuild)
    workingDir(project.file("java"))
    commandLine("mvn", "test")
}

tasks.named("testUnit") {
    dependsOn(mavenTestUnit)
}

val mavenTestIntegration by tasks.registering(Exec::class) {
    group = "lifecycle"
    description = "Run Maven integration tests (failsafe)"
    dependsOn(mavenBuild)
    workingDir(project.file("java"))
    // Run failsafe plugin directly to avoid re-running surefire unit tests
    commandLine("mvn", "failsafe:integration-test", "failsafe:verify")
}

tasks.named("testIntegration") {
    dependsOn(mavenTestIntegration)
}

// Skip testDirect for java-http modules — the implementation runs as a
// container, not a TypeScript class loaded in-process. testDocker covers
// the equivalent coverage against the real HTTP surface.
tasks.named("testDirectExec") {
    enabled = false
}

// ════════════════════════════════════════════════════════════
// Java Module Docker Image Publish (Multi-Arch buildx -> ECR + GHCR)
// Same pattern as zb.typescript.gradle.kts publishImageEcr/publishImageGhcr.
// Java connector modules produce Docker images using the Maven-built JAR
// and a module-provided Dockerfile. ECR and GHCR are pushed separately.
// ════════════════════════════════════════════════════════════

@Suppress("UNCHECKED_CAST")
val javaPreflightChecks = extra["preflightChecks"] as TaskProvider<*>
val javaIsDryRun: Boolean = extra["isDryRun"] as Boolean

val ensureJavaEcrRepo by tasks.registering(Exec::class) {
    group = "publish"
    description = "Create ECR repository for Java module if it does not exist"
    onlyIf { zb.hasConnectionProfile.get() && !javaIsDryRun }
    workingDir(project.projectDir)
    commandLine("echo", "placeholder")
    doFirst {
        val awsRegion = System.getenv("AWS_REGION")
            ?: throw GradleException("AWS_REGION not set in slot env — add to zbb.yaml")
        // Derive from package name (matches zb.typescript pattern). ECR_REPO_NAME
        // env var is honoured as an override when explicitly set.
        val ecrRepoName = System.getenv("ECR_REPO_NAME")?.takeIf { it.isNotBlank() }
            ?: zb.dockerImageName.get()
        commandLine("aws", "ecr", "create-repository",
            "--repository-name", ecrRepoName,
            "--region", awsRegion)
        isIgnoreExitValue = true
    }
}

val publishJavaImageEcr by tasks.registering(Exec::class) {
    group = "publish"
    description = "Build and push multi-arch Java module Docker image to ECR"
    dependsOn(tasks.named("buildImage"), ensureJavaEcrRepo, javaPreflightChecks)
    onlyIf { zb.hasConnectionProfile.get() }
    workingDir(project.projectDir)
    commandLine("echo", "placeholder")
    doFirst {
        val ver = project.version.toString().substringBefore("+")
        if (javaIsDryRun) {
            val ecrRepoName = System.getenv("ECR_REPO_NAME")?.takeIf { it.isNotBlank() }
                ?: zb.dockerImageName.get()
            val ecrRegistry = System.getenv("ECR_REGISTRY") ?: "<ECR_REGISTRY>"
            logger.lifecycle("[DRY RUN] Would push multi-arch Java module image to ECR: ${ecrRegistry}/${ecrRepoName}:${ver}")
            throw org.gradle.api.tasks.StopExecutionException()
        }
        val ecrRegistry = System.getenv("ECR_REGISTRY")
            ?: throw GradleException("ECR_REGISTRY not set in slot env — add to zbb.yaml")
        // Derive from package name (matches zb.typescript pattern). ECR_REPO_NAME
        // env var is honoured as an override when explicitly set.
        val ecrRepoName = System.getenv("ECR_REPO_NAME")?.takeIf { it.isNotBlank() }
            ?: zb.dockerImageName.get()
        commandLine("docker", "buildx", "build",
            "--platform", "linux/amd64,linux/arm64",
            "-t", "${ecrRegistry}/${ecrRepoName}:${ver}", "--push", ".")
    }
}

val publishJavaImageGhcr by tasks.registering(Exec::class) {
    group = "publish"
    description = "Build and push multi-arch Java module Docker image to GHCR"
    dependsOn(tasks.named("buildImage"), publishJavaImageEcr, javaPreflightChecks)
    onlyIf { zb.hasConnectionProfile.get() }
    workingDir(project.projectDir)
    commandLine("echo", "placeholder")
    doFirst {
        val ver = project.version.toString().substringBefore("+")
        if (javaIsDryRun) {
            val ecrRepoName = System.getenv("ECR_REPO_NAME")?.takeIf { it.isNotBlank() }
                ?: zb.dockerImageName.get()
            val ghcrRegistry = System.getenv("GHCR_REGISTRY") ?: "<GHCR_REGISTRY>"
            logger.lifecycle("[DRY RUN] Would push multi-arch Java module image to GHCR: ${ghcrRegistry}/${ecrRepoName}:${ver}")
            throw org.gradle.api.tasks.StopExecutionException()
        }
        val ghcrRegistry = System.getenv("GHCR_REGISTRY")
            ?: throw GradleException("GHCR_REGISTRY not set in slot env — add to zbb.yaml")
        // Derive from package name (matches zb.typescript pattern). ECR_REPO_NAME
        // env var is honoured as an override when explicitly set.
        val ecrRepoName = System.getenv("ECR_REPO_NAME")?.takeIf { it.isNotBlank() }
            ?: zb.dockerImageName.get()
        commandLine("docker", "buildx", "build",
            "--platform", "linux/amd64,linux/arm64",
            "-t", "${ghcrRegistry}/${ecrRepoName}:${ver}", "--push", ".")
    }
}

tasks.named("publishImage") {
    dependsOn(publishJavaImageEcr, publishJavaImageGhcr)
}

// -- Changed-since-tag guard on Java exec tasks --
// Same pattern as zb.typescript.gradle.kts -- exec tasks need the guard directly.
// Capture at plugin config time (project.extra, not task.extra) to avoid
// UnknownPropertyException inside task onlyIf lambdas.
val javaChangedSinceTag: Boolean = extra["changedSinceTag"] as Boolean

listOf(
    "publishJavaImageEcr",
    "publishJavaImageGhcr"
).forEach { taskName ->
    tasks.named(taskName) {
        onlyIf {
            if (!javaChangedSinceTag) {
                logger.lifecycle("[$taskName] Skipping -- no changes since last tag")
            }
            javaChangedSinceTag
        }
    }
}
