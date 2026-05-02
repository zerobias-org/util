// ────────────────────────────────────────────────────────────────────────
// zb.typescript-bundle — appliance TypeScript module + bun bundle step
//
// Use this for SolidJS/bun modules (today: ui). Lifecycle is:
//   transpile (tsc -b) → bunBundle (bun build.bun.ts)
//
// Lint and mocha are NOT registered. Bundle modules today (ui) ship their
// own no-op `lint` npm script and have no unit tests in the gradle graph
// (any `.test.tsx` files run separately under bun's test runner). If a
// future bundle module wants lint or tests it can call `registerEslintLint`
// / `registerMochaTest` from its build.gradle.kts.
//
//     plugins { id("zb.typescript-bundle") }
// ────────────────────────────────────────────────────────────────────────

import com.zerobias.buildtools.appliance.registerBunBundle
import com.zerobias.buildtools.appliance.registerTscTranspile

plugins {
    id("zb.typescript-base")
}

project.registerTscTranspile()
project.registerBunBundle()
