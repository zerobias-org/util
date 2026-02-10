plugins {
    `kotlin-dsl`
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
