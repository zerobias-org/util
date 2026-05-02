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

import com.zerobias.buildtools.appliance.registerEslintLint
import com.zerobias.buildtools.appliance.registerMochaTest
import com.zerobias.buildtools.appliance.registerTscTranspile

plugins {
    id("zb.typescript-base")
}

project.registerEslintLint()
project.registerTscTranspile()
project.registerMochaTest()
