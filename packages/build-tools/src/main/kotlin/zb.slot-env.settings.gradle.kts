/**
 * Settings plugin — load zbb slot + stack env vars and map them to the
 * gradle property names that downstream plugins (Vanniktech
 * maven.publish, Gradle signing) read via providers.gradleProperty().
 *
 * Reads .env files directly from $ZB_SLOT_DIR and
 * $ZB_SLOT_DIR/stacks/$ZB_STACK/ via ZbbSlotProvider — independent of
 * shell env export, daemon cache, and multiline-value quoting issues.
 * Stack env overlays slot env, matching `zbb env list` precedence.
 *
 * The settings phase is the only reliable injection point:
 * startParameter.projectProperties is the only mutable projectProperties
 * map the provider layer observes. Project-level extensions and
 * extra[...] are invisible to providers.gradleProperty().
 *
 * Usage in a consumer's settings.gradle.kts:
 *
 *   plugins { id("zb.slot-env") }
 *
 * Apply before (or without) any other settings logic — the map runs once
 * during settings evaluation.
 *
 * Default mappings cover Maven Central + GPG credentials. Extend here if
 * a new slot env var needs to flow into a new gradle property.
 */

import com.zerobias.buildtools.util.ZbbSlotProvider

// ── Default env var → gradle property mappings ──────────────────────
// envVarName → gradlePropertyName
val mappings: Map<String, String> = linkedMapOf(
    // Sonatype Central Portal (central.sonatype.com user tokens)
    "SONATYPE_USERNAME"        to "mavenCentralUsername",
    "SONATYPE_PASSWORD"        to "mavenCentralPassword",
    // GPG signing — ASCII-armored private key + passphrase
    "GPG_SIGNING_KEY"          to "signingInMemoryKey",
    "GPG_SIGNING_KEY_PASSWORD" to "signingInMemoryKeyPassword",
)

if (ZbbSlotProvider.isInsideSlot()) {
    val merged = buildMap<String, String> {
        putAll(ZbbSlotProvider.getSlotEnv())
        if (ZbbSlotProvider.activeStackName() != null) {
            putAll(ZbbSlotProvider.getStackEnv())
        }
    }
    val updated = gradle.startParameter.projectProperties.toMutableMap()
    val mapped = mutableListOf<String>()
    mappings.forEach { (envVar, propName) ->
        merged[envVar]?.takeIf { it.isNotEmpty() }?.let {
            updated[propName] = it
            mapped += "$envVar→$propName"
        }
    }
    gradle.startParameter.projectProperties = updated
    if (mapped.isNotEmpty()) {
        println("[zb.slot-env] mapped ${mapped.size} slot var(s) to gradle properties: ${mapped.joinToString(", ")}")
    } else {
        println("[zb.slot-env] no env vars matched any configured mapping (slot=${ZbbSlotProvider.activeSlotName()}, stack=${ZbbSlotProvider.activeStackName()})")
    }
} else {
    println("[zb.slot-env] not inside a loaded slot — no credentials mapped (run: zbb slot load <name>)")
}
