rootProject.name = "build-tools"

// Load zbb slot + stack env from the slot's .env files on disk
// (same data ZbbSlotProvider reads — inlined here because build-tools
// can't depend on its own compiled classes in its own settings phase).
// Stack env overlays slot env — matches `zbb env list` precedence.
//
// Map SONATYPE_* / GPG_SIGNING_* to the gradle property names that
// Vanniktech's maven.publish + Gradle's signing plugins read via
// providers.gradleProperty(). startParameter.projectProperties is the
// only settings-phase API the provider layer observes.
run {
    fun readEnvFile(file: java.io.File): Map<String, String> {
        if (!file.exists()) return emptyMap()
        return file.readLines()
            .filter { it.isNotBlank() && !it.trimStart().startsWith("#") }
            .mapNotNull { line ->
                val idx = line.indexOf('=')
                if (idx > 0) line.substring(0, idx).trim() to line.substring(idx + 1).trim()
                else null
            }
            .toMap()
    }

    val slotDir = System.getenv("ZB_SLOT_DIR") ?: return@run
    val merged = mutableMapOf<String, String>()
    merged += readEnvFile(java.io.File(slotDir, ".env"))
    merged += readEnvFile(java.io.File(slotDir, "overrides.env"))
    val stack = System.getenv("ZB_STACK")
    if (stack != null) {
        merged += readEnvFile(java.io.File(slotDir, "stacks/$stack/.env"))
    }

    val updated = gradle.startParameter.projectProperties.toMutableMap()
    listOf(
        "SONATYPE_USERNAME"        to "mavenCentralUsername",
        "SONATYPE_PASSWORD"        to "mavenCentralPassword",
        "GPG_SIGNING_KEY"          to "signingInMemoryKey",
        "GPG_SIGNING_KEY_PASSWORD" to "signingInMemoryKeyPassword",
    ).forEach { (envVar, propName) ->
        merged[envVar]?.takeIf { it.isNotEmpty() }?.let { updated[propName] = it }
    }
    gradle.startParameter.projectProperties = updated
}
