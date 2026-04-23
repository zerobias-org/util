rootProject.name = "lite-filter"

pluginManagement {
    includeBuild("../build-tools")
}

// Map clean slot env vars (SONATYPE_*, GPG_*) to the gradle property
// names Vanniktech + signing plugins read via providers.gradleProperty().
// Settings phase is the only reliable place: startParameter.projectProperties
// is what providers.gradleProperty sees. Repeated in codegen + build-tools
// since each is its own standalone Gradle root.
run {
    val updated = gradle.startParameter.projectProperties.toMutableMap()
    listOf(
        "SONATYPE_USERNAME"        to "mavenCentralUsername",
        "SONATYPE_PASSWORD"        to "mavenCentralPassword",
        "GPG_SIGNING_KEY"          to "signingInMemoryKey",
        "GPG_SIGNING_KEY_PASSWORD" to "signingInMemoryKeyPassword",
    ).forEach { (envVar, propName) ->
        System.getenv(envVar)?.takeIf { it.isNotEmpty() }?.let { updated[propName] = it }
    }
    gradle.startParameter.projectProperties = updated
}
