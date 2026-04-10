# prepublish-standalone Parity Test — Fixture Corpus

This document maps each prepublish-standalone edge case to **real packages**
from the 6 production repos. These will be used as test fixtures for the
Kotlin port parity tests in Phase 2.

**Approach:** rather than synthesize fixtures, copy snapshots of real packages
(source files + `package.json` + relevant root context) into the test
resources directory. Run both bash and Kotlin paths against each fixture and
assert byte-identical output.

**Fixture format:** each fixture is a directory containing a minimal
reproduction:
```
fixtures/<fixture-name>/
  root/
    package.json            # subset of real root package.json (deps + workspaces)
    node_modules/           # only the bin-relevant subset for binMap discovery
  pkg/
    package.json            # the package being prepublished
    src/                    # source files for import scanning
    scripts/                # shell scripts (if applicable)
    *.yml                   # YAML config (if applicable)
  expected/
    package.json            # expected output (byte-equal)
```

---

## Edge case → fixture mapping

### 1. Empty package (zero deps, minimal scan)
- **Fixture:** `util-dynamodb`
- **Source:** `com/util/packages/dynamodb`
- **Why:** 0 deps, 0 dev deps. Tests the "everything resolves cleanly with no
  required deps" path.

### 2. Simple package with workspace deps (transitive expansion)
- **Fixture:** `hub-node-lib`
- **Source:** `com/hub/node-lib`
- **Why:** 16 deps, 2 workspace deps (`hub-core`, `hydra-core`). Tests
  workspace-aware version resolution and recursive transitive expansion through
  one level of workspace deps.

### 3. Heavy package with many workspace deps (deep transitive)
- **Fixture:** `hub-server`
- **Source:** `com/hub/server`
- **Why:** 30 deps, 5+ workspace deps including `hub-secrets-manager`,
  `hub-node-lib`, `hydra-core`, `hydra-dao`, `util-core`. Tests multi-level
  transitive expansion. Highest-value real-world fixture — if this matches
  byte-for-byte, most production packages will too.

### 4. Bin field — single command (object form)
- **Fixture:** `hub-cli`
- **Source:** `com/hub/cli`
- **Why:** `bin: { "hub-cli": "./dist/src/bin/hub-node.js" }`. Tests bin
  discovery for object-form bin with a single key.

### 5. Bin field — multiple commands (object form)
- **Fixture:** `platform-dataloader`
- **Source:** `com/platform/dataloader`
- **Why:** `bin: { "datasync": "...", "dataloader": "..." }`. Tests bin
  discovery when one package contributes multiple commands to the binMap.

### 6. Shell scripts as runtime artifacts (`*.sh` in files array)
- **Fixture:** `platform-dynamodb`
- **Source:** `com/platform/dynamodb`
- **Why:** `files: ["*.sh", "dist", "generated", "src", "scripts", "*.yml", "bom.json"]`.
  Tests the rule that shell scripts get scanned for runtime deps even when
  build tools are skipped, because they're packaged with the artifact.

### 7. Hardcoded additional-deps map
- **Fixture:** `util-api-client-base-consumer` (synthetic)
- **Source:** Copy any package and set its name to
  `@zerobias-org/util-api-client-base`. The hardcoded rule adds `qs` regardless
  of imports.
- **Why:** Tests `PACKAGE_ADDITIONAL_DEPS` map. No real package in our 6 repos
  has this name, so this is a synthetic name-only fixture.

### 8. Implicit-deps from name pattern (eslint-config, prettier-config)
- **Fixture:** `eslint-config-stub` (synthetic)
- **Source:** Synthesize. None of the 6 target repos contain eslint-config or
  prettier-config workspace packages.
- **Why:** Tests the implicit-deps name-pattern matching. Set name to something
  containing `eslint-config` and assert eslint, @typescript-eslint/*,
  eslint-plugin-unicorn are added to deps.

### 9. Root overrides copied to output
- **Fixture:** any platform package
- **Source:** `com/platform/dataloader` (or any other platform pkg)
- **Why:** `com/platform/package.json` has 8 overrides. Tests that overrides
  are copied verbatim into the published package.json. Note one override is
  self-referential: `"@zerobias-org/types-core-js": "$@zerobias-org/types-core-js"`.
  Confirm whether bash preserves this literal or normalizes.

### 10. CommonJS require imports
- **Fixture:** check for `.js` files using `require(...)` in any of the 6 repos
- **Source:** TBD — search needed in Phase 2
- **Why:** Tests the `require()` regex branch of `scanImports`.

### 11. Multi-line ES6 import
- **Fixture:** `hub-server` or `hub-node-lib`
- **Source:** Most TS source files use multi-line imports
  (`import {\n  a,\n  b,\n} from 'pkg';`)
- **Why:** Tests the `\bfrom\s+['"]([^'"]+)['"]` regex on multi-line imports.

### 12. Side-effect (bare) import
- **Fixture:** TBD
- **Source:** Search for `import 'pkg-name';` lines in Phase 2
- **Why:** Tests the bareImportRegex branch.

### 13. node: protocol imports (must be skipped)
- **Fixture:** `hub-node-lib` or any TS package
- **Source:** Most modern TS files use `import { readFileSync } from 'node:fs'`
- **Why:** Tests that `node:` protocol imports are skipped (not added to deps).

### 14. YAML extends — array form
- **Fixture:** TBD — none of our 6 repos use Spectral configs (the .redocly.yaml
  files in com/clients use a different format).
- **Source:** Synthesize a `.spectral.yaml` with `extends: [- "@scope/pkg"]`
- **Why:** Tests `scanYamlFiles` with array-form extends.

### 15. YAML extends — single string
- **Fixture:** synthetic
- **Source:** Synthesize a YAML with `extends: "@scope/pkg"`
- **Why:** Tests single-string extends regex.

### 16. Build tools skip (default behavior)
- **Fixture:** any library package without `import-artifact: service`
- **Source:** `hub-core`, `hub-node-lib`, etc.
- **Why:** Tests the default skip-build-tools rule. Asserts that npm scripts
  scanning is skipped, devDeps stripped from output.

### 17. Build tools INCLUDED (`--include-build-tools` or `import-artifact: service`)
- **Fixture:** TBD — search for `zerobias.import-artifact: service` in Phase 2
- **Source:** Search needed
- **Why:** Tests the opt-in path. Confirms scripts get scanned and binMap
  resolution kicks in.

### 18. Missing root deps (warning report)
- **Fixture:** synthetic
- **Source:** Take a real package and remove one of its deps from root
  `package.json`. Should appear in the "missing" warning section.
- **Why:** Tests the missingDeps reporting path.

### 19. Self-reference must be skipped
- **Fixture:** any workspace package
- **Source:** Any package — they should never include themselves as a dep even
  if their own package name appears in source comments
- **Why:** Tests the `pkg === servicePackageJson.name` skip.

### 20. Built-in modules must be skipped
- **Fixture:** any TS package using node builtins without `node:` prefix
- **Source:** Check for `import fs from 'fs'` etc. (uncommon now but legal)
- **Why:** Tests the builtins set: `fs path http https crypto stream url util
  os child_process events assert buffer net tls dns readline zlib`.

### 21. devDependencies stripped from output
- **Fixture:** any package with devDeps
- **Source:** `com/platform/package.json` (root) has many devDeps
- **Why:** Output `devDependencies` field must be deleted entirely.

### 22. Dependencies sorted alphabetically
- **Fixture:** `hub-server` (30 deps, easy to verify ordering)
- **Source:** `com/hub/server`
- **Why:** Output `dependencies` keys must be alphabetically sorted.

### 23. Trailing newline in output
- **Fixture:** any
- **Source:** any
- **Why:** Output JSON ends with `\n`. Tests byte-equality at the file level.

### 24. `--target-dir` mode
- **Fixture:** `target-dir-stub` (synthetic)
- **Source:** Synthesize a package with a `dist/package.json` containing
  `exports`, `typings`. Run with `--target-dir=dist`. Source `package.json` must
  not be modified; `dist/package.json` should get deps merged in while
  preserving exports/typings.
- **Why:** Tests the ng-packagr code path. None of our 6 repos use ng-packagr,
  so this is synthetic.

### 25. `--restore` mode
- **Fixture:** any
- **Source:** any
- **Why:** Run prepublish, then `--restore`. Original `package.json` must be
  byte-equal to the pre-prepublish state, and the `.prepublish-backup` file
  must be deleted.

### 26. `--dry-run` mode
- **Fixture:** any
- **Source:** any
- **Why:** No file modifications. Stdout must contain "Dependencies that would
  be included:" section that the change-detector parses to find affected
  packages by root deps.

---

## Edge cases that DON'T exist in our 6 repos

These are unused features in production. Decide in Phase 2 whether to:
- (a) Skip parity testing for them and remove from the Kotlin port (delete code)
- (b) Test with synthetic fixtures only
- (c) Keep code path "just in case"

| Feature | Used by | Recommendation |
|---|---|---|
| `workspace:*` / `workspace:^` / `workspace:~` protocol | none | (a) — npm workspaces don't use this, it's a yarn/pnpm thing |
| `peerDependencies` field | none | (a) — devops doesn't include peer deps in output anyway |
| `optionalDependencies` field | none | (a) — same |
| `eslint-config-*` name pattern | none | (b) — synthetic test only, keep code |
| `prettier-config-*` name pattern | none | (b) — synthetic test only, keep code |
| `--target-dir` (ng-packagr) | none in target repos (only com/clients/angular) | (c) — keep, but synthetic test |
| `--include-build-tools` | unknown | (b) — synthetic test |
| `import-artifact: service` | none found in target repos | (b) — synthetic test |
| YAML extends (Spectral config) | none in target repos | (b) — synthetic test |

---

## Recommended fixture set for Phase 2

**Minimum real-package fixtures (cover 80% of behavior):**
1. `util-dynamodb` — empty package
2. `hub-core` — minimal package with no workspace deps
3. `hub-node-lib` — moderate package with 2 workspace deps
4. `hub-server` — large package with 5+ workspace deps (transitive expansion)
5. `hub-cli` — bin object with single command
6. `platform-dataloader` — bin object with multiple commands
7. `platform-dynamodb` — shell scripts as runtime artifacts
8. `hub-hub-client-codegen` — bin object + small dep set

**Synthetic fixtures (cover the remaining 20%):**
9. `eslint-config-stub` — implicit deps from name pattern
10. `util-api-client-base-stub` — hardcoded additional deps
11. `target-dir-stub` — `--target-dir` ng-packagr mode
12. `yaml-extends-stub` — Spectral-style extends directives
13. `missing-root-dep-stub` — exercises the warning path

**Mode-only fixtures (reuse fixture #4 with different flags):**
14. `--dry-run` — assert stdout format only
15. `--restore` — assert backup roundtrip
16. `--include-build-tools` — assert script scanning happens

Total: 16 fixtures, ~8 real and ~8 synthetic.

---

## Next steps (Phase 2)

1. Build a fixture extractor script: given a repo + package name + git ref,
   copy the package source files + relevant root `package.json` subset into
   `build-tools/src/test/resources/fixtures/<name>/`.
2. Run bash prepublish on each fixture, capture output, save to `expected/`.
3. Implement Kotlin `Prepublish.kt`.
4. Run Kotlin against each fixture, diff against `expected/`. Fail on any drift.
5. Iterate until all fixtures pass byte-equality.
6. Add fixtures to CI for regression protection.
