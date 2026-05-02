// ────────────────────────────────────────────────────────────────────────
// zb.typescript-lib — pre-composed appliance TypeScript module plugin
//
// Use this for the common case (lib, cli, node, manager). One line in the
// module's build.gradle.kts:
//
//     plugins { id("zb.typescript-lib") }
//
// Modules that ship a binary (cli, node) configure the chmod path:
//
//     plugins { id("zb.typescript-lib") }
//     appliance { chmodBin = "src/bin/hub-node.js" }
//
// Modules that need a different mix (e.g. manager has lint disabled because
// of pre-existing `++` violations carried over from the hub source) should
// fall back to `id("zb.typescript-base")` and call register* manually.
// ────────────────────────────────────────────────────────────────────────

import com.zerobias.buildtools.appliance.ApplianceDebExtension
import com.zerobias.buildtools.appliance.registerBuildDeb
import com.zerobias.buildtools.appliance.registerEslintLint
import com.zerobias.buildtools.appliance.registerMochaTest
import com.zerobias.buildtools.appliance.registerTscTranspile

plugins {
    id("zb.typescript-base")
}

project.registerEslintLint()
project.registerTscTranspile()
project.registerMochaTest()

// Register `buildDeb` only when the module declared `applianceDeb { binPath = ... }`.
// Lib (no binary, no binPath) leaves the extension empty and gets no buildDeb task.
// The `afterEvaluate` is required because the module's `applianceDeb { ... }` block
// runs after the plugin applies — we can't read `binPath` synchronously here.
afterEvaluate {
    val ext = extensions.getByType(ApplianceDebExtension::class.java)
    if (ext.binPath.isPresent) {
        project.registerBuildDeb()
    }
}
