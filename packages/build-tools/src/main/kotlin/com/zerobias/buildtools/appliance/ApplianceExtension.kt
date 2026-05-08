package com.zerobias.buildtools.appliance

import org.gradle.api.provider.Property

/**
 * Per-module configuration for appliance TypeScript modules.
 *
 * Registered as `appliance` on every project that applies `zb.typescript-base`
 * (or any plugin that applies it transitively, like `zb.typescript-lib` and
 * `zb.typescript-bundle`).
 *
 * The single property is `chmodBin`: a path under `dist/` whose execute bit
 * must be set after tsc finishes (cli/bin/hub-node.js, node/bootstrap.js, …).
 * Modules that don't ship a binary leave it unset.
 */
interface ApplianceExtension {
    /**
     * Path (relative to the module's `dist/` directory) that the
     * `posttranspile` finalizer should chmod +x.
     *
     * Example: `"src/bin/hub-node.js"` → `chmod +x dist/src/bin/hub-node.js`.
     *
     * Unset = no chmod (libraries with no binaries).
     */
    val chmodBin: Property<String>
}
