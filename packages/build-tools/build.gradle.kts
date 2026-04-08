plugins {
    `kotlin-dsl`
    `maven-publish`
}

group = "com.zerobias"

// Auto-bump patch version: check what's published, use next available
val baseVersion = "1.0"
version = run {
    val token = System.getenv("GITHUB_TOKEN") ?: System.getenv("NPM_TOKEN") ?: ""
    if (token.isEmpty()) return@run "$baseVersion.0"

    val repoUrl = "https://maven.pkg.github.com/zerobias-com/util"
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

publishing {
    repositories {
        maven {
            name = "GitHubPackages"
            url = uri("https://maven.pkg.github.com/zerobias-com/util")
            credentials {
                username = System.getenv("GITHUB_ACTOR") ?: "zerobias-com"
                password = System.getenv("GITHUB_TOKEN") ?: System.getenv("NPM_TOKEN") ?: ""
            }
        }
    }
}
