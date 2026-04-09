# Handoff: zbb→Gradle Monorepo Migration — Remaining Work

**For: a future Claude session continuing this work on a different machine.**

---

## Quick Context

We're in the middle of migrating zbb's monorepo build/test/gate/publish flow
from a TypeScript implementation in `org/util/packages/zbb/lib/monorepo/` to
Gradle plugins in `org/util/packages/build-tools/`. **zbb is now a wrapper** —
all build orchestration logic lives in the Gradle plugins. zbb just applies
cleanse/preflight/slot env, then spawns gradle.

**Architecture decisions** (locked, don't revisit):

- Several focused plugins (`zb.monorepo-base`, `zb.monorepo-build`,
  `zb.monorepo-gate`, `zb.monorepo-publish`) — not one big plugin
- npm packages become real Gradle subprojects via dynamic discovery in
  `settings.gradle.kts`
- Repos declare delegation in `.zbb.yaml` `lifecycle:` block (mirroring stack
  `zbb.yaml` lifecycle pattern) — zbb has zero hardcoded gradle task names
- Default: new Gradle path. `ZBB_USE_LEGACY_MONOREPO=1` is the escape hatch
- TTY display stays in zbb TypeScript (`Display.ts`), fed by JSON-line events
  from a Gradle `BuildEventListener` written to `.zbb-monorepo/events.jsonl`
- Per-task stdout/stderr captured to `.zbb-monorepo/logs/<safe>.log` for
  post-mortem inspection
- The 6 monorepo target repos: `com/util`, `com/hub`, `com/dana`,
  `com/hydra-service`, `com/fileservice`, `com/platform`

---

## Current State (committed)

**`org/util` branch:** `feature/zbb-monorepo-gradle-migration`
**`com/util` branch:** `feature/zbb-monorepo-gradle-pilot` (the pilot repo,
fully working end-to-end)

**What works locally against com/util:**

| Command | Status |
|---|---|
| `zbb gate --check` | ✓ cheap CI pre-flight via `monorepoGateCheck` |
| `zbb gate` / `zbb gate --all` | ✓ full gate, writes stamp, TTY display |
| `zbb build` / `zbb build --all` | ✓ TTY display, caching works |
| `zbb test` | ✓ TTY display |
| `zbb publish --dry-run` | ✓ prepublish + would-publish + restore per package |
| `zbb publish` | ✓ branch guard fails on non-main; would publish on main |
| `ZBB_USE_LEGACY_MONOREPO=1 zbb <cmd>` | ✓ legacy TS escape hatch |

**Tests:** 116 Kotlin tests passing in `build-tools` (`./gradlew test`).

**Key files** (so you can orient quickly):

- `org/util/packages/build-tools/docs/monorepo-spec.md` — full behavior spec,
  TS→Kotlin mapping table, all 10 OQ decisions
- `org/util/packages/build-tools/docs/prepublish-fixtures.md` — fixture
  catalog for prepublish parity tests
- `org/util/packages/build-tools/src/main/kotlin/com/zerobias/buildtools/monorepo/`
  — Workspace, ChangeDetector, GateStamp, Prepublish, MonorepoGraphService,
  MonorepoEventEmitter, RegistryInjectionService, DockerSemaphore
- `org/util/packages/build-tools/src/main/kotlin/zb.monorepo-{base,build,gate,publish}.gradle.kts`
  — the plugins
- `org/util/packages/zbb/lib/monorepo/Display.ts` — project-centric TTY display
- `org/util/packages/zbb/lib/monorepo/index.ts` — lifecycle routing layer
- `com/util/{settings,build}.gradle.kts` + `.zbb.yaml` lifecycle block — pilot wiring

**Important project memories** (in `~/.claude/projects/-root-nfa-repos-org-util/memory/`):

- `project_zb_base_gate_already_kotlin.md` — gate logic was already in zb.base
- `project_zbb_display_event_bridge.md` — display + event bridge architecture
  (project-centric refinement)
- `project_registry_injection_requirements.md` — 3 TS bugs to fix in Verdaccio
  injection (already fixed in `RegistryInjectionService.kt`)
- `project_gate_workflow_intent.md` — two-tier gate (local-first, CI as backup)
- `feedback_zbb_is_entrypoint.md`, `feedback_gradle_native.md`,
  `feedback_plugin_granularity.md`, `feedback_prepublish_parity.md`

---

## Remaining Work (in priority order)

### 1. Publish `build-tools` to GitHub Packages Maven 🚧 **BLOCKER for CI**

The new `zb.monorepo-*` plugins exist locally but aren't published. CI
workflows resolve `com.zerobias:build-tools:1.+` from GitHub Packages, so
currently CI would fail to find the new plugins.

```bash
cd org/util/packages/build-tools
# Auto-bumps version (currently 1.0.17 locally — published is older)
GITHUB_TOKEN=<token-with-write:packages> ./gradlew publish
```

After this, com/util's CI workflows should work (assuming the merge to main +
workflow trigger).

### 2. Test CI workflows end-to-end against com/util

The `pull-request.yml` and `publish.yml` in `com/util` are updated for the new
flow but haven't been verified in actual CI. Steps:

1. Push the `feature/zbb-monorepo-gradle-pilot` branch to com/util
2. Open a PR
3. Verify `gate-check` job passes (cheap, just reads stamp)
4. If stamp invalid, verify `gate-run` job passes (Java setup + gradle gate +
   commit stamp)
5. Merge to main
6. Verify `publish` job runs `zbb publish` successfully (or use `--dry-run`
   first via workflow_dispatch)

You may need to add `--dry-run` mode to `publish.yml` initially for safety,
then remove once validated.

### 3. Migrate the other 5 repos

Each repo needs the same scaffolding com/util got. Mechanical work but
per-repo testing required.

**Per-repo checklist:**

- Create branch `feature/zbb-monorepo-gradle-pilot`
- Add/update `settings.gradle.kts`:
  - `pluginManagement.includeBuild("../../org/util/packages/build-tools")`
    (already there in 5 of 6)
  - Add `id("zb.monorepo-base/build/gate/publish") version "1.+"` to
    `pluginManagement.plugins`
  - Buildscript classpath block to load build-tools jar via flatDir or maven
    (needed for `Workspace.discoverWorkspaces()` direct call in settings)
  - Replace existing `include(...)` calls with the dynamic discovery loop
    (copy from `com/util/settings.gradle.kts`)
- Add/update `build.gradle.kts`:
  - Apply `id("zb.monorepo-base")`, `id("zb.monorepo-gate")`,
    `id("zb.monorepo-build")`, `id("zb.monorepo-publish")`
- Update `.zbb.yaml`:
  - Add `lifecycle:` block with clean/build/test/gate/gateCheck/publish entries
    pointing at `./gradlew monorepo*`
- Verify gradlew exists at root (most repos already have it)
- Update `.gitignore` to add `.zbb-monorepo/`
- Update `.github/workflows/pull-request.yml` and `publish.yml` to add
  `setup-java@v4` (Java 21) + `GITHUB_TOKEN`/`READ_TOKEN` env on zbb steps
- Test locally: `zbb gate --check`, `zbb build --all`, `zbb gate --all`,
  `zbb publish --dry-run`
- The `verify-parity` script (see #6) should produce identical stamps to
  legacy TS path

**Migration order (smallest to largest):**

1. `com/dana` (4 packages)
2. `com/hydra-service` (2 packages — easiest)
3. `com/fileservice` (6 packages, has Neon test DB requirement — special case)
4. `com/hub` (16 packages, has docker images via `zb.typescript-service`,
   has stack)
5. `com/platform` (24+ packages, biggest, has `testDatabase` Neon block in
   .zbb.yaml)

`com/hub` and `com/platform` have **per-package `build.gradle.kts` files
applying `zb.typescript-service`** — the new monorepo-build plugin auto-detects
these and uses their existing `dockerBuild` etc. tasks instead of registering
fallbacks. Verify this works in practice for those repos.

### 4. Per-package change detection in publish (Phase 2.6e)

Currently `monorepoPublish` publishes ALL non-private, non-skipPublish
packages. The legacy TS Publisher.ts compares each package's version against
the last published version on the registry, only publishes the changed ones.
Need to port this logic.

**Where:** `zb.monorepo-publish.gradle.kts` — add a `detectPublishChanges`
step that runs before per-package publish tasks.

**Approach:** for each package, query npm registry for `<name>@latest`,
compare versions. If current > published, publish. Cache the result in a
BuildService so it only runs once per build.

Reference: `lib/monorepo/Publisher.ts detectPublishChanges`.

### 5. Image dispatch after publish (Phase 2.6f)

For packages with `monorepo.images.<relDir>.workflow` set in `.zbb.yaml`,
after a successful publish, dispatch a GitHub workflow:

```bash
gh workflow run <workflow> --repo <owner/repo> -f version=<published-version>
```

**Where:** new task `dispatchImageWorkflows` in `zb.monorepo-publish`, runs
after `monorepoPublish`. Reads `monorepo.images` from `MonorepoConfig` (the
field exists already, parsed in `MonorepoGraphService.kt loadMonorepoConfig`).

Reference: `lib/monorepo/Publisher.ts dispatchImageWorkflows`. Detect repo via
`git remote get-url origin` if not configured.

### 6. `zbb monorepo verify-parity` command (Phase 2.6g)

Per OQ8 decision — a CLI command to validate the new Gradle path produces
equivalent output to the legacy TS path for a repo. Run before merging each
repo's migration PR.

**Approach:**

1. Run `ZBB_USE_LEGACY_MONOREPO=1 zbb gate` → capture `gate-stamp.json`
   (call it `stamp-ts.json`)
2. Run `zbb gate` (default — Gradle path) → capture `gate-stamp.json`
   (`stamp-gradle.json`)
3. Diff the two (normalize for ordering since user said ordering doesn't matter)
4. Run `zbb publish --dry-run` on both paths, capture would-publish package
   list + resolved deps
5. Diff
6. Report any drift

**Where:** new file `org/util/packages/zbb/lib/monorepo/VerifyParity.ts`.
Plumbed via `zbb monorepo verify-parity` subcommand in `lib/cli.ts`.

### 7. Display polish (low priority)

Currently `clean` and `gate --check` use inherited stdio (no display). They're
fast single-task commands so it's fine, but for consistency you could:

- Show a single status line for `clean` ("monorepoClean: removed N artifacts")
- Show the per-package validation list for `gate --check` (already does this
  via gradle output)

Skip unless you have time.

### 8. Phase 7 cleanup (months out, after migration complete)

Per the original plan, after all 6 repos are validated on the new path for
~1-2 months:

- Delete `org/util/packages/zbb/lib/monorepo/{Builder,ChangeDetector,GateStamp,Publisher,Workspace,index}.ts`
  (the legacy TS implementation)
- Keep `Display.ts` (project-centric TTY rendering — that's NOT going away)
- Delete `verify-parity` command
- Delete `ZBB_USE_LEGACY_MONOREPO` env var handling
- Delete the bash `prepublish-standalone.sh`/`.js` from `org/devops/tools/`
  (after confirming no other callers)

---

## Important Quirks to Know About

**1. The dev workflow with `includeBuild`**

For local dev, com/util uses
`pluginManagement.includeBuild("../../org/util/packages/build-tools")`. This
works for project plugins (`zb.monorepo-base/build/gate/publish`) but **NOT
for settings plugins** — Gradle resolves settings plugins before composite
builds are wired up. Workaround: settings.gradle.kts uses a `buildscript`
block to load the build-tools jar via `flatDir` (pointing at `build/libs/`),
then calls `Workspace.discoverWorkspaces()` directly. The user manually
rebuilds the jar after editing build-tools (`./gradlew jar`).

**2. Registry injection bug fixes**

The legacy `lib/stack/Stack.ts injectRegistryNpmrc` has 3 bugs that we
explicitly fixed in the new `RegistryInjectionService.kt` and the user told us
to **NOT touch the legacy TS code**. The fixes are:

- Lockfile MOVE not COPY (so npm doesn't honor the original lockfile's
  resolved URLs)
- Real `npm_config_@<scope>:registry` env vars set on the Exec spec (the TS
  function name `injectRegistryNpmrc` was a misnomer — it never wrote an npmrc)
- UNCONDITIONAL taint (the TS skips silently on cold cache)

See `project_registry_injection_requirements.md` memory for full details.

**3. Display gotchas (in case TTY display breaks)**

- Use **Node clock** (`Date.now()`) not JVM clock (event `ts`) for `startedAt`
  to avoid cross-process clock skew producing negative or stuck-at-0.0s elapsed
- Cursor-up positioning uses `lastRowCount` (not current count) so newly-added
  rows don't desync
- Project status derived from STEP statuses, NOT gradle's exit code (so other
  projects show ✓ even when one fails)
- Spawn gradle with `detached: true` (uses `setsid`) so Java's
  `System.console()` returns null and gradle's rich console doesn't bleed to
  /dev/tty
- Pass `--console=plain --parallel` to gradle
- Set `TERM=dumb` in spawn env

**4. Caching gotchas**

- `inputs.file(path).optional()` does NOT actually allow missing files at
  validation time. Only declare single-file inputs (`packageJson`,
  `tsconfigJson`, `apiYml`) when they exist
- `inputs.files(fileTree(dir))` handles missing dirs (empty FileTree) — use
  this for directory inputs
- Don't include `generated/` as input for `lint` (lint runs BEFORE generate in
  our canonical order; including it would invalidate lint every time generate
  produces new output)
- Each fallback Exec task writes a stamp file in `build/<phase>.stamp` via
  `doLast` so Gradle has a stable up-to-date marker even when the npm script
  produces no real output (e.g. lint)

**5. The `lifecycle:` block in `.zbb.yaml` is the key abstraction**

zbb has zero hardcoded knowledge of gradle task names. Each repo declares its
own command-to-action mapping. zbb just looks it up and spawns. This means
migrating a repo is mostly: add `.zbb.yaml` lifecycle entries pointing at
`./gradlew monorepo*`, add the plugin includes, done.

**6. Per-subproject build.gradle.kts files**

For repos like com/hub where some packages already have their own
`build.gradle.kts` applying `zb.typescript-service` (with `dockerBuild`,
`npmTranspile`, etc.), `zb.monorepo-build` auto-detects these via presence of
an `npmTranspile` task and DEFERS to them — doesn't register duplicate
fallback Exec tasks. Pure-npm packages without per-package gradle files get
the simple Exec fallbacks.

---

## How to Resume

```bash
# Check branches
cd ~/zerobias/org/util && git log --oneline feature/zbb-monorepo-gradle-migration | head -20
cd ~/zerobias/com/util && git log --oneline feature/zbb-monorepo-gradle-pilot | head -10

# Verify build-tools tests still pass
cd ~/zerobias/org/util/packages/build-tools && ./gradlew test

# Smoke test against com/util
cd ~/zerobias/com/util
zbb gate --check       # should be fast, cached
zbb build --all        # should show project-centric display
zbb publish --dry-run  # should run prepublish + would-publish + restore
```

If anything's broken locally, the stale `build-tools` jar is the most likely
culprit:

```bash
cd ~/zerobias/org/util/packages/build-tools && ./gradlew clean jar
```

Read the spec doc first:
`org/util/packages/build-tools/docs/monorepo-spec.md`. It's the source of
truth for behavior + the TS→Kotlin mapping table + all 10 OQ decisions.
