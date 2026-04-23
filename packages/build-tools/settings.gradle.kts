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
    // Multi-line-aware reader: zbb writes PGP keys / certs as a KEY=<first>
    // line followed by the body as continuation lines. Only treat a line as
    // a new key when it matches ^[A-Za-z_][A-Za-z0-9_]*= — otherwise append
    // to the current value. Mirrors ZbbSlotProvider.readEnvFile.
    fun readEnvFile(file: java.io.File): Map<String, String> {
        if (!file.exists()) return emptyMap()
        val envKeyPattern = Regex("^([A-Za-z_][A-Za-z0-9_]*)=(.*)$")
        val result = mutableMapOf<String, String>()
        var currentKey: String? = null
        val currentValue = StringBuilder()
        for (line in file.readLines()) {
            val match = envKeyPattern.matchEntire(line)
            if (match != null) {
                currentKey?.let { result[it] = currentValue.toString().trim() }
                currentKey = match.groupValues[1]
                currentValue.clear()
                currentValue.append(match.groupValues[2])
            } else if (currentKey != null) {
                if (currentValue.isNotEmpty()) currentValue.append('\n')
                currentValue.append(line)
            }
        }
        currentKey?.let { result[it] = currentValue.toString().trim() }
        return result
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
