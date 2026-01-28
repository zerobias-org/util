package com.zerobias.buildtools.module

import org.gradle.api.provider.ListProperty
import org.gradle.api.provider.Property

/**
 * Gradle extension for Hub Module build configuration.
 *
 * Convention-over-configuration: most properties auto-detect from the directory
 * structure and file presence. Override in build.gradle.kts for edge cases.
 */
interface ZbExtension {
    /** Vendor directory name (auto-detected from parent dir) */
    val vendor: Property<String>

    /** Product directory name (auto-detected from current dir) */
    val product: Property<String>

    /** Whether this module has a connectionProfile.yml (auto-detected) */
    val hasConnectionProfile: Property<Boolean>

    /** Whether to build a standalone OpenAPI SDK (opt-in, default false) */
    val hasOpenApiSdk: Property<Boolean>

    /** Docker image name (default: {vendor}-{product}) */
    val dockerImageName: Property<String>

    /**
     * Include ConnectionProfile schema in the distribution spec (module-{name}.yml).
     * Default: false — distribution spec describes "what the module does", not "how to connect".
     * Set true for backward compatibility if downstream tooling expects it.
     */
    val includeConnectionProfileInDist: Property<Boolean>

    /**
     * Extra arguments passed to hub-generator (e.g., ["-p", "useSpecHttpMethods=true"]).
     * These are appended after the standard args.
     */
    val generatorArgs: ListProperty<String>

    /**
     * Post-generation script for edge-case fixes (e.g., "./fix-gen-code.sh").
     * Runs after generateApi. Disabled by default (not present = skipped).
     */
    val postGenerateScript: Property<String>
}
