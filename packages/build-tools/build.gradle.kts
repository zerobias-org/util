plugins {
    `kotlin-dsl`
    `maven-publish`
}

group = "com.zerobias"
version = "1.0.0"

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
