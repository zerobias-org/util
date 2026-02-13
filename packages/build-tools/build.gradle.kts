plugins {
    `kotlin-dsl`
    `maven-publish`
}

group = "com.zerobias"
version = "1.0-SNAPSHOT"

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
    implementation("com.github.node-gradle:gradle-node-plugin:7.0.1")

    // Vault Java driver for secret resolution
    implementation("io.github.jopenlibs:vault-java-driver:6.2.0")

    // YAML manipulation (replaces yq CLI dependency)
    implementation("org.yaml:snakeyaml:2.2")
}
