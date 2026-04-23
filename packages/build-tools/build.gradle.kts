import com.vanniktech.maven.publish.GradlePlugin
import com.vanniktech.maven.publish.JavadocJar
import com.vanniktech.maven.publish.SonatypeHost

plugins {
    `kotlin-dsl`
    `maven-publish`
    id("com.vanniktech.maven.publish") version "0.30.0"
}

group = "com.zerobias"

// Map clean env vars to Vanniktech / signing property names
listOf(
    "SONATYPE_USERNAME"        to "mavenCentralUsername",
    "SONATYPE_PASSWORD"        to "mavenCentralPassword",
    "GPG_SIGNING_KEY"          to "signingInMemoryKey",
    "GPG_SIGNING_KEY_PASSWORD" to "signingInMemoryKeyPassword",
).forEach { (envVar, propName) ->
    System.getenv(envVar)?.takeIf { it.isNotEmpty() }?.let { extra[propName] = it }
}

// Auto-bump patch version: check what's published, use next available
val baseVersion = "1.0"
version = run {
    val token = System.getenv("GITHUB_TOKEN") ?: System.getenv("NPM_TOKEN") ?: ""
    if (token.isEmpty()) return@run "$baseVersion.0"

    val repoUrl = "https://maven.pkg.github.com/zerobias-org/util"
    val metadataUrl = "$repoUrl/com/zerobias/build-tools/maven-metadata.xml"
    try {
        val url = uri(metadataUrl).toURL()
        val conn = url.openConnection()
        conn.setRequestProperty("Authorization", "Bearer $token")
        conn.connectTimeout = 5000
        conn.readTimeout = 5000

        val xml = conn.getInputStream().bufferedReader().readText()
        // Find all versions matching baseVersion.N
        val pattern = Regex("""\Q$baseVersion\E\.(\d+)""")
        val maxPatch = pattern.findAll(xml)
            .mapNotNull { it.groupValues[1].toIntOrNull() }
            .maxOrNull() ?: -1
        "$baseVersion.${maxPatch + 1}"
    } catch (_: Exception) {
        "$baseVersion.0"
    }
}

java {
    toolchain {
        languageVersion.set(JavaLanguageVersion.of(21))
    }
}

tasks.withType<org.jetbrains.kotlin.gradle.tasks.KotlinCompile>().configureEach {
    compilerOptions {
        jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_21)
    }
}

repositories {
    mavenCentral()
    gradlePluginPortal()
}

dependencies {
    // Gradle Node plugin for managed Node.js/npm execution
    implementation("com.github.node-gradle:gradle-node-plugin:7.1.0")

    // Vault Java driver for secret resolution
    implementation("io.github.jopenlibs:vault-java-driver:6.2.0")

    // YAML manipulation (replaces yq CLI dependency)
    implementation("org.yaml:snakeyaml:2.2")

    // JSON serialization for monorepo gate stamp (matches JS JSON.stringify byte-for-byte)
    implementation("com.fasterxml.jackson.module:jackson-module-kotlin:2.17.2")

    // Kotlin test runner
    testImplementation("org.junit.jupiter:junit-jupiter:5.10.2")
    testRuntimeOnly("org.junit.platform:junit-platform-launcher")
}

tasks.withType<Test>().configureEach {
    useJUnitPlatform()
}

// ── Maven Central publishing (Vanniktech, GradlePlugin config) ──────
// Gradle plugin projects publish both the main jar and a plugin marker
// per plugin id; Vanniktech's GradlePlugin handles both.
mavenPublishing {
    publishToMavenCentral(SonatypeHost.CENTRAL_PORTAL, automaticRelease = false)
    signAllPublications()
    configure(GradlePlugin(javadocJar = JavadocJar.Javadoc(), sourcesJar = true))

    coordinates("com.zerobias", "build-tools", project.version.toString())

    pom {
        name.set("build-tools")
        description.set("ZeroBias Gradle convention plugins for Hub module + monorepo builds")
        url.set("https://github.com/zerobias-org/util")
        licenses {
            license {
                name.set("Apache License, Version 2.0")
                url.set("http://www.apache.org/licenses/LICENSE-2.0.txt")
                distribution.set("repo")
            }
        }
        developers {
            developer {
                id.set("kmccarthy")
                name.set("Kevin McCarthy")
                email.set("kmccarthy@zerobias.com")
                organization.set("Zerobias")
                organizationUrl.set("https://github.com/zerobias-org")
            }
        }
        scm {
            url.set("https://github.com/zerobias-org/util/tree/main")
            connection.set("scm:git:git://github.com/zerobias-org/util.git")
            developerConnection.set("scm:git:ssh://github.com:zerobias-org/util.git")
        }
    }
}

// ── GitHub Packages (second publish target) ──────────────────────────
publishing {
    repositories {
        maven {
            name = "github"
            url = uri("https://maven.pkg.github.com/zerobias-org/util")
            credentials {
                username = System.getenv("GITHUB_ACTOR") ?: "zerobias-org"
                password = System.getenv("NPM_TOKEN") ?: System.getenv("GITHUB_TOKEN") ?: ""
            }
        }
    }
}

tasks.register("publishToGithub") {
    group = "publishing"
    description = "Publish to GitHub Packages Maven repository"
    dependsOn("publishAllPublicationsToGithubRepository")
}

tasks.named("publish") {
    dependsOn("publishToMavenLocal", "publishToMavenCentral", "publishToGithub")
}
