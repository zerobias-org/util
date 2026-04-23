pluginManagement {
    includeBuild("../build-tools")
}

buildscript {
    repositories {
        mavenLocal()
        maven {
            url = uri("https://maven.pkg.github.com/zerobias-org/util")
            credentials {
                username = System.getenv("GITHUB_ACTOR") ?: "zerobias-org"
                password = System.getenv("NPM_TOKEN") ?: System.getenv("GITHUB_TOKEN") ?: ""
            }
        }
        gradlePluginPortal()
        mavenCentral()
    }
    dependencies {
        classpath("com.zerobias:build-tools:1.+")
    }
}

rootProject.name = "lite-filter"

// Load zbb slot + stack env via build-tools' canonical ZbbSlotProvider.
// Reads .env files directly from $ZB_SLOT_DIR (slot) and $ZB_SLOT_DIR/
// stacks/$ZB_STACK/.env (stack) — independent of shell env, daemon cache,
// multiline quoting. Stack env overlays slot env (same precedence as
// `zbb env list`).
//
// Declared env vars (SONATYPE_*, GPG_*, …) from zbb.yaml `env:` live at
// the stack level, so getStackEnv() is the required source; getSlotEnv()
// alone only returns ZBB_SLOT_VARS.
//
// Map to gradle property names Vanniktech + signing plugins read via
// providers.gradleProperty(). startParameter.projectProperties is the
// only settings-phase API the provider layer observes.
import com.zerobias.buildtools.util.ZbbSlotProvider

if (ZbbSlotProvider.isInsideSlot()) {
    val merged = buildMap<String, String> {
        putAll(ZbbSlotProvider.getSlotEnv())
        if (ZbbSlotProvider.activeStackName() != null) {
            putAll(ZbbSlotProvider.getStackEnv())
        }
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
