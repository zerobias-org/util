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
}

tasks.named("compile") {
    dependsOn(mavenBuild)
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
