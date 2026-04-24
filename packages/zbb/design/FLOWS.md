# zbb — End-to-End Flow Reference

Canonical reference for how `zbb` does what it does: slots, stacks, env
resolution, the shell hook, and the lifecycle dispatcher. Every flow
below traces from the CLI entry point through the code to the files
that end up on disk, with the **monorepo mode** and **standard mode**
paths called out separately wherever they diverge.

If a command, file path, or invariant in this doc disagrees with the
code, the code is authoritative and this doc is wrong — file a fix.

---

## Contents

1. [Mental model](#1-mental-model)
2. [Core concepts](#2-core-concepts)
3. [zbb.yaml schema reference](#3-zbbyaml-schema-reference)
4. [build-tools — what zbb invokes under the hood](#4-build-tools--what-zbb-invokes-under-the-hood)
5. [Flow: `zbb slot create`](#5-flow-zbb-slot-create)
6. [Flow: `zbb slot load`](#6-flow-zbb-slot-load)
7. [Flow: `zbb stack add`](#7-flow-zbb-stack-add)
8. [Env handling — layers, sources, resolution](#8-env-handling--layers-sources-resolution)
9. [Shell cd hook](#9-shell-cd-hook)
10. [Flow: command dispatch (the big one)](#10-flow-command-dispatch)
11. [Scenarios — concrete walk-throughs](#11-scenarios--concrete-walk-throughs)
12. [On-disk file layout](#12-on-disk-file-layout)
13. [Glossary](#13-glossary)

---

## 1. Mental model

zbb is two things glued together:

1. **A slot/stack orchestrator.** A *slot* is a named isolated
   environment (env vars, ports, secrets, state directories) at
   `~/.zbb/slots/<name>/`. A *stack* is a composable unit (docker
   compose services + env schema + lifecycle verbs) you add into a slot.
2. **A gradle-aware lifecycle dispatcher.** `zbb build` / `test` /
   `gate` / `publish` / `clean` / `dockerBuild` look up what to run
   from `zbb.yaml` and dispatch to either the **monorepo** Gradle
   plugins (aggregator tasks that span the whole workspace) or a
   **standard** per-subproject Gradle invocation, depending on whether
   a `monorepo:` block is present in the zbb.yaml.

These two things share one config file (`zbb.yaml`) at the repo root.
The same file is both the stack manifest (identity, env schema,
substacks, state, lifecycle) AND the repo-level config (tools registry,
monorepo block, cleanse list). Which subset of fields is read depends
on what zbb is doing.

---

## 2. Core concepts

### Slot

A named env context. Created once per developer workflow; reused
across many sessions. Lives at `~/.zbb/slots/<name>/`. Carries only
identity/path vars (the `ZB_SLOT_*` family) — stack env lives under
each added stack's directory, never in the slot `.env`.

### Stack

A composable unit added into a slot via `zbb stack add <source>`.
Identified by `name:` in its `zbb.yaml` (npm package name shape:
`@scope/short-name`). Carries its own env schema, optional substacks,
state declarations, and lifecycle verbs. Two stacks in one slot
communicate via declared `imports:` / `exports:` (typed at add-time).

### Stack manifest vs overlay

A `zbb.yaml` is a **stack** only when it has been added to the current
slot via `zbb stack add`. Everything else is an **overlay** — a
lifecycle / env override layer that contributes to dispatch but isn't
a standalone stack.

Three shapes in practice:

1. **Stack manifest (added).** Has `name:` and `version:`. Lives at
   the repo root for the common case, or as a standalone stack repo
   (e.g. `com/hub/zbb.yaml`, `com/hub/node-stack/zbb.yaml` when added
   as a separate stack). Authoritative for its own `env:`, `tools:`,
   `require:`, `lifecycle:`.

2. **Overlay (nameless).** No `name:`. Exists purely to override
   `lifecycle:` entries for the directory it lives in — e.g. a
   workspace package that wants its own `build: ./my-special-build.sh`.
   Borrows `env:` / `tools:` / stack identity from the nearest added
   stack ancestor.

3. **Overlay (`overlay: true`).** Has `name:` but the author has
   explicitly marked it as an overlay with the `overlay: true` field.
   Cannot be added via `zbb stack add` — refused with a clear error.
   Dispatch walk-up skips it for stack-context resolution regardless
   of what's in the slot. Use this when a sub-package happens to have
   an npm name but should NEVER be a standalone stack.

**Runtime fallback:** a `zbb.yaml` with `name:` but **not** marked
`overlay: true` that simply hasn't been added yet is treated as an
overlay at dispatch time (walked past for stack context). It becomes
a stack the moment someone runs `zbb stack add` against it. The
marker is for authors who want to prevent that from happening
accidentally.

**The rule the dispatcher uses** (see `config.ts:findActiveStackInChain`):
walk the chain closest-first, skip entries that are (a) nameless, (b)
marked `overlay: true`, or (c) named but not in `slot.stacks.list()`.
The first surviving entry is the active stack — its `tools:`, `env:`,
and `require:` blocks drive preflight and gate resolution. The
*lifecycle owner* for the running command is resolved separately (the
closest chain entry whose `lifecycle[command]` is defined) and can be
a different file — typically an overlay closer to cwd than the active
stack.

### Chain / walk-up

When you run a zbb command from some `cwd`, the dispatcher walks up
the directory tree collecting every `zbb.yaml` it finds. The walk
stops at the first `zbb.yaml` that declares a `monorepo:` block (that
file is the aggregator root — nothing above it matters), at filesystem
root, or when crossing a `.git` boundary upward. See
`config.ts:findZbbChain()`.

### Monorepo mode vs standard mode

The lifecycle dispatcher picks a mode based on whether a
`monorepo:` block is present anywhere in the chain:

| Mode | Trigger | Dispatches to | Display | Per-task events |
|------|---------|---------------|---------|-----------------|
| **Monorepo** | `monorepo:` block present in the chain (e.g. `com/hub/zbb.yaml`, `org/util/zbb.yaml`) | Root aggregators (`monorepoBuild`, `monorepoTest`, `monorepoGate`, `monorepoPublish`, `monorepoClean`, `monorepoDockerBuild`) from `zb.monorepo-*` Gradle plugins | `MonorepoDisplay` TTY UI (phases + per-project table + gate stamp + publish plan) | Yes — via `EventEmitter` BuildService writing JSONL |
| **Standard** | No `monorepo:` block anywhere in the chain | Plain `./gradlew <cmd>` with cwd-aware subproject prefixing (`:packages:foo:build`) | Inherited stdio (no TUI display yet) | No |

The two paths share most of the dispatcher — the split happens late,
after preflight and env resolution. See [§10](#10-flow-command-dispatch).

### Scope (cwd → package)

When in monorepo mode and cwd is inside a workspace package, the
dispatcher classifies cwd via `derivePackageScope(cwd, monorepoRoot)`:

- `root` — cwd == monorepo root. No scoping, run full aggregator.
- `gradle` — workspace package with `build.gradle.kts` registered in
  `settings.gradle.kts`.
- `npm` — pure-npm workspace package (no `build.gradle.kts`).
- `invalid` — cwd has `package.json` but isn't a workspace member, or
  has no `package.json` at all. Dispatcher refuses.

For `gradle` and `npm` scopes, the dispatcher appends
`-Pmonorepo.scope=<npm-pkg-name>` to the gradle invocation. The
Kotlin `MonorepoGraphService` reads this property and clamps the
`affected` set to just that one package, so `monorepoBuild` /
`monorepoTest` / `monorepoGate` / `monorepoDockerBuild` all run on a
single package.

**Standard mode's equivalent:** `resolveCommandForCwd` in
`standardLifecycle.ts` rewrites `./gradlew build` →
`./gradlew :packages:foo:build` when cwd is a registered gradle
subproject. Pure-npm packages in standard mode error out
("package.json but no build.gradle.kts").

### Publish subdir block

`zbb publish` is **blocked** when cwd is not the monorepo root. The
publish change-detector from PR #52 has caveats that haven't been
resolved; until they are, publish requires root invocation. See
`cli.ts` and the `project_publish_subdir_block` memory.

---

## 3. zbb.yaml schema reference

Every `zbb.yaml` mixes *repo-level* and *stack-manifest-level* fields.
Which ones are read depends on which code path loads the file.

### Stack identity (manifest-level)

```yaml
name: "@zerobias-com/hub"
version: "1.0.0"
```

Any `zbb.yaml` that declares `name:` is a stack manifest and can be
added to a slot with `zbb stack add <path-or-package>`.

### Dependencies / imports / exports (manifest-level)

```yaml
depends:
  dana:
    package: "@zerobias-com/dana-stack@^1.0.12"
    ready_when:
      status: healthy

exports: [HUB_SERVER_PORT, HUB_SERVER_URL, ...]

imports:
  dana:
    - DANA_URL
    - DANA_PORT
    - "DANA_URL as SERVER_URL"   # aliased import
```

`depends:` triggers `StackManager.resolveDeps()` to fetch + add the
dependency stack. `imports:` validates at add-time that every listed
var is actually in the source stack's `exports:` list, then pulls the
live value at `stack.load()`.

### Substacks (manifest-level)

```yaml
substacks:
  server:
    compose: test/docker-compose.hub-server.yml
    services: [hub-server]
    exports: [HUB_SERVER_PORT, HUB_SERVER_URL]
    logs:
      source: docker
      container: "${ZB_SLOT}-hub-server"
    state:
      pid: { type: number }
      status: { type: enum, values: [running, stopped] }
  alerts:
    state:
      collection: true    # collection substack — directory of YAMLs
      schema:
        severity: { type: enum, values: [info, warn, error] }
```

### Env schema (manifest-level)

```yaml
env:
  NPM_TOKEN:
    type: string
    source: env
    required: true
    mask: true
  SERVER_URL:
    type: string
    value: "http://localhost:${DANA_PORT}"   # live formula
  PGPORT:
    type: port   # auto-allocated from slot's port range
  PGPASSWORD:
    type: secret
    generate: hex:12   # random 12-byte hex
  NEON_API_KEY:
    source: vault
    vault: "operations-kv/neon/content.api-key"
    mask: true
  VAULT_TOKEN:
    source: file
    file: "~/.vault-token"
  WEBSOCKET_URL:
    source: expression:jsonata
    expr: "$replace(HUB_SERVER_URL, /^https:/, 'wss:')"
```

Sources in priority order (highest wins): `override` (user-set via
`zbb env set`, stored in `.env` with `source: 'override'` in
`manifest.yaml`) > `source: vault|file|env` > `value:` (live formula)
> `default:` > resolver output.

See [§8](#8-env-handling--layers-sources-resolution) for the full
resolution flow.

### Overlay marker

```yaml
overlay: true
```

Declares that this `zbb.yaml` is intentionally an overlay — lifecycle
overrides only, never a standalone stack. `zbb stack add` refuses to
add it, and the dispatcher walks past it when resolving the active
stack. Use on sub-package `zbb.yaml` files that exist solely to
override lifecycle commands (e.g., a workspace package with its own
`build: ./my-special-build.sh`).

Omitting `overlay:` means "addable if someone runs `zbb stack add`
against it" — a sub-package can become a real stack later without a
schema change.

### Tools registry (manifest-level, NEW in Phase 4)

```yaml
tools:
  node:
    check: "node --version"
    parse: "v(\\S+)"
    version: ">=22"
    install: "nvm install 22"
  docker:
    check: "docker --version"
    parse: "Docker version (\\S+),"
    version: ">=24"
  vault:
    check: "vault --version"
    parse: "Vault v(\\S+)"
    version: ">=1.0.0"
```

A named registry of preflight tool definitions. Referenced by
`require:` (stack-add preflight) and per-command `lifecycle.<cmd>.tools`
(per-invocation gates). One canonical definition per tool, no
duplication.

### Stack-level preflight (manifest-level, NEW in Phase 4)

```yaml
require:
  - nvm
  - node
  - java
```

Name references into the `tools:` registry. Checked at **slot load**
and **stack add/start**. No `commands:` filter — if a tool is only
needed for specific lifecycle verbs, declare it in that verb's
`tools:` gate instead.

### Lifecycle (manifest-level + repo-level)

Either shorthand (just a command string) or object form (command +
per-command preflight gates):

```yaml
lifecycle:
  clean:
    command: ./gradlew monorepoClean          # no gates — shorthand OK too
  build:
    command: ./gradlew monorepoBuild
    env:   [NPM_TOKEN]                         # must resolve non-empty
  gate:
    command: ./scripts/gate-with-neon.sh
    tools: [docker, vault]                     # refs into tools: registry
    env:   [NPM_TOKEN, NEON_API_KEY, NEON_PROJECT_ID, VAULT_ADDR, VAULT_TOKEN]
  gateCheck:
    command: ./gradlew monorepoGateCheck       # shorthand

  # Stack-level verbs — same object form
  start:
    command: docker compose ... up -d
    tools: [docker, ghcr-auth, psql]
  stop:
    command: docker stop ...
    tools: [docker]

  # Special shapes — kept from pre-Phase-4
  health:
    command: curl -sf http://...
    interval: 3
    timeout: 30
  cleanup:
    - "docker stop ..."
    - "rm -rf ..."
```

Canonical lifecycle verbs that route through the **monorepo/standard
split**: `clean`, `build`, `test`, `gate` (and `gate --check`),
`publish`, `dockerBuild`. Everything else (`start`, `stop`, `health`,
`seed`, `cleanup`, `buildVm`, etc.) is handled by the
custom-verb dispatcher.

### Monorepo block (repo-level)

```yaml
monorepo:
  registry: https://npm.pkg.github.com/
  sourceDirs: [src]
  sourceFiles: [tsconfig.json, api.yml]
  buildPhases: [lint, generate, transpile]
  testPhases: [test]
  skipPublish: [test]
  images:
    server:
      context: image/server
      name: hub-server
      workflow: server-image-publish.yml
```

**Presence of this block switches the dispatcher into monorepo mode.**
Consumed by the Gradle plugins (`zb.monorepo-base` → `-build` →
`-gate` → `-publish`) via `MonorepoGraphService.config`. The TS layer
does NOT read its individual fields — it only checks whether the
block exists. See [§4](#4-build-tools--what-zbb-invokes-under-the-hood).

### Cleanse (repo-level)

```yaml
cleanse:
  - AWS_PROFILE
  - KUBECONFIG
  - DATABASE_URL
```

Env vars to unset from the parent shell on slot load AND at the top of
every lifecycle command. Prevents developer-env leakage from poisoning
the slot's deterministic env.

### Ports range (repo-level)

```yaml
ports:
  range: [15000, 16000]
```

Informational — port allocation is slot-level, not per-repo. The slot
chooses a 100-port block from the global port space at `slot create`.

---

## 4. build-tools — what zbb invokes under the hood

zbb's monorepo mode delegates the actual work to Gradle plugins
implemented in `org/util/packages/build-tools/src/main/kotlin`. When
`zbb build` runs `./gradlew monorepoBuild`, this is what's on the
other end.

### Plugin hierarchy

```
zb.monorepo-base        ← BuildService registration, event emitter, cd hook
├── zb.monorepo-build   ← workspaceInstall + per-package build wiring
├── zb.monorepo-gate    ← monorepoGate + monorepoGateCheck + stamp write
└── zb.monorepo-publish ← monorepoPublish + publish plan + prepublish + guards

zb.base                 ← per-package lifecycle skeleton (non-monorepo)
├── zb.typescript       ← npm / tsc / hub-generator per-package
│   ├── zb.typescript-connector
│   └── zb.typescript-agent
└── zb.java-module      ← maven / pom.xml per-package
```

### What the TS layer knows about

zbb (TypeScript) interacts with these plugins through **three
channels** and nothing else:

1. **Task invocation** — `./gradlew monorepoBuild` (etc).
2. **Project properties** — `-Pmonorepo.all`, `-Pmonorepo.base`,
   `-Pmonorepo.scope`, `-PdryRun`, `-Pforce`, `-PskipStampCheck`.
3. **Event file** — `<repo>/.zbb-monorepo/events.jsonl` (JSONL
   stream), read by `MonorepoDisplay` in `monorepo/Display.ts`. Plus
   per-task log files under `<repo>/.zbb-monorepo/logs/`.

### Key plugin tasks

| Task | Plugin | What it does |
|------|--------|--------------|
| `workspaceInstall` | `zb.monorepo-build` | `npm install` at the repo root. Runs before every monorepo task. Now reported as a display phase (`Install`). |
| `workspaceInstallRestore` | `zb.monorepo-build` | `finalizedBy(workspaceInstall)` — restores lockfile + cleans tarballs after a registry-injected install. |
| `monorepoBuild` | `zb.monorepo-build` | Aggregator: `dependsOn(workspaceInstall)` + per-subproject `build` (or per-phase fallbacks for pure-npm packages). Iterates `changeResult.affected`. |
| `monorepoTest` | `zb.monorepo-build` | Aggregator: `dependsOn(monorepoBuild)` + per-subproject `test`. |
| `monorepoDockerBuild` | `zb.monorepo-build` | Aggregator: `dependsOn(monorepoBuild)` + per-subproject `dockerBuild` (for dockerized packages only). |
| `monorepoClean` | `zb.monorepo-build` | Runs each package's `npm run clean` then a standard sweep of `dist/`, `generated/`, `build/`, `*.tsbuildinfo`. |
| `monorepoGateCheck` | `zb.monorepo-gate` | Cheap: reads `gate-stamp.json` + validates each affected package's stamp entry. No slot, no vault, no gradle build. |
| `monorepoGate` | `zb.monorepo-gate` | Full: `dependsOn(monorepoBuild, monorepoTest, monorepoDockerBuild, monorepoPublishDryRun)` + writes unified `gate-stamp.json`. Scope-aware merge. |
| `monorepoPublishDryRun` | `zb.monorepo-publish` | Validates full publish path (change detection + prepublish + `npm pack --dry-run`) without mutating files. Wired into gate chain. |
| `monorepoPublish` | `zb.monorepo-publish` | Per-package `prepublishPackage` → `publishPackage` (`npm publish`) → `restorePackage`. Branch-gated (main/master only unless `--dry-run`). Stamp-validated unless `-PskipStampCheck`. |
| `publishGuard` | `zb.monorepo-publish` | Branch + stamp validation, runs before any `npm publish`. |
| `publishPlan` | `zb.monorepo-publish` | Tag-based `PublishChangeDetector.detectChanges` → writes `.zbb-monorepo/publish-plan.json`. |

### MonorepoGraphService — shared state

`MonorepoGraphService` (`build-tools/src/main/kotlin/.../MonorepoGraphService.kt`)
is a Gradle `BuildService` registered by `zb.monorepo-base`. It holds:

- **`packages`** — `Map<npmName, WorkspacePackage>` discovered from the
  root `package.json` `workspaces:` globs.
- **`graph`** — internal dep graph built from each package's
  `dependencies` / `devDependencies`.
- **`config`** — the parsed `monorepo:` block (buildPhases, testPhases,
  images, skipPublish, registry).
- **`changeResult`** — git-diff-based affected set (`ChangeDetector`),
  OR substituted with `{scope}` when `-Pmonorepo.scope` is set.

**Scope substitution:** when `-Pmonorepo.scope=<npm-pkg>` is set AND
`-Pmonorepo.all` is not, `changeResult` becomes
`{changed={scope}, affected={scope}, affectedOrdered=[scope]}`
regardless of git state. Cascades automatically to every `for (pkgName
in affected)` loop in the plugins.

### EventEmitter — the JSONL event pipeline

`EventEmitter` is another BuildService registered by `zb.monorepo-base`.
Subscribes to Gradle's `OperationCompletionListener` and writes JSONL
events to `.zbb-monorepo/events.jsonl`. The TS `MonorepoDisplay`
tails this file and renders a live TTY table.

Event types:

- `phase_start` / `phase_done` — root aggregator tasks
  (`workspaceInstall`, `monorepoBuild`, `monorepoTest`,
  `monorepoDockerBuild`, `monorepoPublishDryRun`, `monorepoPublish`,
  `monorepoGate`, `monorepoGateCheck`, `monorepoClean`).
- `task_start` / `task_done` — per-subproject phase tasks (lint,
  generate, transpile, test, dockerBuild).
- `publish_plan` — emitted by `monorepoPublishDryRun` /
  `monorepoPublish`, carries the list of packages to publish + their
  resolved versions.
- `gate_stamp_written` — emitted at end of `monorepoGate` after the
  stamp file is written.

### Standard mode doesn't use any of this

When there's no `monorepo:` block, zbb calls `./gradlew <task>`
directly (with a subproject prefix when appropriate). No
BuildService, no EventEmitter, no TUI. Just plain inherited stdio.

---

## 5. Flow: `zbb slot create`

Entry: `cli.ts` → `handleSlot('create')` → `SlotManager.create()`.

### Step-by-step

1. **Parse args.** Reads slot name (or generates `e2e-<hex>` for
   `--ephemeral`), TTL, CI mode.
2. **Validate name.** Alphanumeric + dashes; no clashes with existing
   slot dirs.
3. **Allocate port range.** `PortAllocator.allocateSlotPortRange()`:
   scans existing slots' `slot.yaml.portRange`, picks next
   non-overlapping 100-port block (starts at 15000 for the first slot).
4. **Create directories** under `~/.zbb/slots/<name>/`:
   `config/`, `logs/`, `state/`, `state/tmp/`, `stacks/`.
5. **Build slot framework env vars** (`Slot.getSlotEnvVars()`):
   `ZB_SLOT`, `ZB_SLOT_DIR`, `ZB_SLOT_CONFIG`, `ZB_SLOT_LOGS`,
   `ZB_SLOT_STATE`, `ZB_SLOT_TMP`, `ZB_STACKS_DIR`. These are the
   ONLY vars a slot owns — stack vars live under each stack, not here.
6. **Write `.env` + `manifest.yaml`** via
   `SlotEnvironment.writeDeclaredEnv()`. Manifest carries per-var
   provenance (`source: 'zbb'`, `type: 'slot'`).
7. **Write `slot.yaml`** with `{name, created, portRange, ephemeral?,
   ttl?, expires?}`.
8. **Return `Slot.load()`** — reads everything back, emits `'ready'`.

### What ends up on disk

```
~/.zbb/slots/<name>/
  slot.yaml           # metadata
  .env                # ZB_SLOT=..., ZB_SLOT_DIR=..., ... (the 7 framework vars)
  manifest.yaml       # per-var provenance
  config/             # (empty — stacks populate)
  logs/               # (empty)
  state/tmp/          # (empty)
  stacks/             # (empty — `zbb stack add` populates)
```

**No stacks yet.** `slot create` is pure infrastructure. The user
still has to `zbb stack add <source>` (or cd into a repo and let slot
load auto-extend) to get the project's env.

### Notes

- **`--ephemeral`** adds `expires` to `slot.yaml`. On every
  `SlotManager.load()` and `SlotManager.list()`, any slot whose
  `expires` is in the past is garbage-collected (`SlotManager.gc()`).
- **`--ci`** snapshots `process.env` as the source-of-truth for
  declared vars, so vault-action's pre-injected secrets are picked up
  directly.

---

## 6. Flow: `zbb slot load`

Entry: `cli.ts` → `handleSlot('load')`.

This is the flow that actually puts you "inside" a slot — it spawns
a bash subshell with all the env vars set and the cd hook installed.

### Step-by-step

1. **GC expired ephemeral slots** (`SlotManager.gc()`).
2. **Load slot** (`SlotManager.load(name)`). Reads `slot.yaml`, env,
   manifest, overrides into the Slot instance. Emits `'ready'`.
3. **Walk up from cwd** with `findRepoRoot(process.cwd())` to find a
   nearby `zbb.yaml`. (This is the legacy walk-up used for slot
   preflight — the newer chain walk-up is used by lifecycle dispatch,
   not here.)
4. **Run `prepareSlot(slot)`** (see [§8](#8-env-handling--layers-sources-resolution)):
   - `slot.resolve()` — DNS TXT provisioning only (no args).
   - `slot.stacks.refreshAll({repoRoot})` — two-pass external refresh
     for every added stack: per-stack `refreshSourcedVars` (file/env)
     + repo-root vault scan, then import re-eval across stacks so
     dependents see freshly-refreshed dep values.
   - Apply slot-level vars to `process.env` (the 7 framework vars).
   - No stack context yet — stack env isn't loaded until cd into a
     stack dir fires the shell hook.
5. **Run preflight from `require:`** if the repo has `zbb.yaml` and it
   declares any (filtered to entries with `commands: [slot]` or no
   commands filter for back-compat; new-schema entries always run).
   - Resolves name-reference entries against the stack manifest's
     `tools:` registry via `resolveRequireEntries()`. Hard error on
     unresolved names.
   - Runs `runPreflightChecks(applicable, userConfig.skip_checks)`.
     Fails slot load if any check fails.
6. **Build subshell env**: slot env vars + user's `process.env` (with
   cleanse applied) + `JAVA_HOME` override + `ZBB_PS1` prompt template.
7. **Generate rcfile** at `<slot>/.zbb-bashrc`: sources
   `/etc/bash.bashrc`, user's `~/.bashrc`, applies cleanse unsets,
   sources `lib/shell/hook.sh`. The hook installs the cd-based stack
   scoping via `PROMPT_COMMAND`.
8. **Stack health check.** If the slot has any stacks, runs
   `handleStack(['heartbeat'], slot)` to show statuses + update stale
   state. Starts a background heartbeat loop if any stack is healthy
   or partial.
9. **Spawn bash** with `--rcfile <slot>/.zbb-bashrc -i`. User is now
   "in" the slot; prompt is `[zb:myslot]:~/path$`.

### What you see

```
$ zbb slot load myslot
Stack health:
  ✓ hub        healthy   (3/3 containers up)
  ✓ dana       healthy   (1/1 containers up)
Loading slot 'myslot'...
[zb:myslot]:~/nfa-repos/com/hub$ _
```

### Reload (already inside a slot)

`zbb slot load` with no name, while `ZB_SLOT` is already set in env,
does a **re-eval** instead of spawning a new shell — re-runs
`prepareSlot` and prints `Slot 'myslot' re-evaluated from <cwd>`. No
subshell recursion.

---

## 7. Flow: `zbb stack add`

Entry: `cli.ts` → `handleStack('add')` → `slot.stacks.add(source, {as})`
→ `StackManager.add()`.

### Mode detection

**Local (dev) mode:** source starts with `.`, `/`, `~`, or resolves to
an existing directory. Stack is added in dev mode — the manifest is
re-read from the source path on every `stack.load()`, image tags
default to `:dev`.

**Packaged (npm) mode:** source looks like `@scope/pkg@version` or
`pkg@version`. Fetched via `npm pack`, extracted under
`~/.zbb/cache/stacks/<name>@<version>/`. Manifest is read once from
the extracted tarball; image tags come from the manifest as-is.

### Step-by-step (both modes)

1. **Resolve source to a manifest path.**
   - Dev: `<sourcePath>/zbb.yaml`.
   - Packaged: `npm pack <pkg@version>` → extract → use extract dir.
2. **Load manifest** (`loadStackManifest`). Throws if no `name:` field.
3. **Short name** = last segment of scoped name
   (`@zerobias-com/hub-node` → `hub-node`). Overridden by `--as
   <alias>` if provided.
4. **Resolve dependencies** (`StackManager.resolveDeps()`). For each
   entry in `manifest.depends:`:
   - Skip if already added to slot.
   - Check built-in stacks at `packages/zbb/stacks/<name>/`.
   - Else fetch from npm registry (packaged mode).
   - **Recurse** — transitive deps resolve too.
5. **Resolve imports**. For each entry in `manifest.imports:`, parse
   into `{from, as, optional?}` form. Validate that the source stack
   exists in the slot AND lists each imported var in its `exports:`.
   Optional imports (`optional: true`) don't error if the source is
   missing.
6. **Create stack directory** at
   `<slot>/stacks/<shortName-or-alias>/`.
7. **Allocate ports** for every `type: port` var in the manifest's env
   schema. Uses `PortAllocator.allocatePorts()` with a per-slot cache
   (so re-adding a removed stack gets stable ports).
8. **Generate secrets** for every `type: secret, generate: ...` var.
   Supported: `hex:N`, `base64:N`, `uuid`, `rsa:BITS`,
   `rsa_public:<refVar>`.
9. **Initialize stack env** via `StackEnvironment.initialize()`.
   Composes three layers:
   - Schema (the manifest's `env:` block)
   - Manifest (per-var provenance — resolution type, source, formula,
     inputs)
   - .env (computed key=value output)
10. **Write stack files** to disk:
    - `stack.yaml` — identity `{name, version, mode, source, added, alias?}`
    - `.env` — computed env vars
    - `manifest.yaml` — per-var provenance
    - `state.yaml` — `{status: stopped}`
    - `logs/`, `state/secrets/`
    - `substacks/<name>/` directories with `state.yaml` (for object
      substacks) — collection substacks are empty dirs.
11. **Dev-mode image tag override.** Rewrites any `_IMAGE` env var
    whose default points at `ghcr.io` to a local `:dev` tag.

### What ends up on disk

```
~/.zbb/slots/<slot>/stacks/hub/
  stack.yaml          # {name: "@zerobias-com/hub", version: "1.0.0", mode: "dev", source: "/home/.../com/hub", added: "...", alias: "hub"}
  .env                # NPM_TOKEN=xxx, VAULT_TOKEN=..., HUB_SERVER_PORT=15030, SERVER_URL=http://localhost:..., ...
  manifest.yaml       # per-var provenance — how each value was resolved
  state.yaml          # {status: stopped, server_ready: false, ...}
  logs/
  state/secrets/
  substacks/
    server/state.yaml
    events/state.yaml
    pkg-proxy/state.yaml
```

### After `zbb stack start`

- `lifecycle.start.command` runs from the stack's source dir with
  slot+stack env in `process.env`.
- Docker containers launch under the slot's compose project name
  (`-p ${ZB_SLOT}`).
- Health check polls until success or timeout; stack `state.yaml` is
  updated with `status: healthy` (or `degraded` / `error`).

### Removal

`zbb stack remove <name>`:
1. Cascade — find and refuse if any OTHER stack in the slot imports
   from this one (unless `--force`).
2. Run `lifecycle.cleanup` (if defined) — tears down containers,
   volumes, etc.
3. Delete `<slot>/stacks/<name>/` from disk.

---

## 8. Env handling — layers, sources, resolution

### Two separate env namespaces

| Namespace | Lives at | Contains | Owned by |
|-----------|----------|----------|----------|
| **Slot env** | `<slot>/.env` + `<slot>/manifest.yaml` | Only the 7 `ZB_SLOT_*` framework vars; overrides tagged via manifest `source: 'override'` | `SlotManager` / `Slot` |
| **Stack env** | `<slot>/stacks/<name>/.env` | Everything declared in the stack manifest's `env:` block, resolved | `StackManager` / `Stack` |

These do NOT merge at write time. `slot.env.getAll()` returns ONLY
slot-level vars (the filter is enforced — writes of non-slot-vars to
slot.env throw). Stack vars come in on `cd` via the shell hook, or on
lifecycle dispatch via `prepareSlot(slot, {stack})`.

### The three-layer resolution model (per stack)

When `stack.load()` runs (at stack add, env refresh, or lifecycle
dispatch), it calls `StackEnvironment.resolve()`:

1. **Layer 1 — Schema:** the stack manifest's `env:` block. Types,
   defaults, formulas (`value:`), sources (`env|vault|file|expression`).
2. **Layer 2 — Manifest:** `<stack>/manifest.yaml`. Per-var provenance
   tracked on every value — `{resolution: 'override' | 'imported' |
   'dns' | 'allocated' | 'generated' | 'inherited' | 'derived' |
   'expression', value, source, formula?, inputs?}`.
3. **Layer 3 — .env:** `<stack>/.env`. Computed key=value output,
   written only if content changed (avoids inotify storms).

### Priority order for a given variable

```
override  (from user's zbb env set)
  ↓
imported  (from dep stack's .env via manifest.imports)
  ↓
dns       (from _hub.<domain> TXT records)
  ↓
allocated (auto-port)
  ↓
generated (auto-secret)
  ↓
inherited (source: env — from parent shell at slot create, CI mode)
  ↓
derived   (value: "${FOO}-${BAR}" — live formula)
  ↓
expression (source: expression:jsonata)
  ↓
default   (from schema)
  ↓
vault     (source: vault — refreshed at resolve time)
  ↓
file      (source: file — re-read at resolve time)
  ↓
(undefined)
```

### Sources explained

| `source:` | What it does | When fetched |
|-----------|--------------|--------------|
| `env` | Read from `process.env` at slot create (or CI mode), then frozen | Once at create; `env refresh` / `stacks.refreshAll` re-reads |
| `vault` | Read from Vault KV v2 via `vault:` path + field | At `env refresh` / lifecycle dispatch (via `stacks.refreshAll`) |
| `file` | Read file contents (supports `~`) | At `env refresh` / lifecycle dispatch |
| `expression:jsonata` | Evaluate `expr:` with other env vars as input | At every `stack.load()` — values are always current |
| `cwd` | Set to `process.cwd()` at the zbb invocation | At dispatch time |

### `value:` vs `default:`

Both look similar. The difference is re-evaluation:

- **`default:`** — "initial value, frozen after first resolve." Only
  re-evaluates if the inputs change AND the manifest gets reset.
- **`value:`** — "live formula, always re-evaluated." Every
  `stack.load()` recomputes. Reference other vars with `${FOO}`.

### `slot.resolve()` vs `slot.stacks.refreshAll()` — the refresh pipeline

Two distinct steps, both called at slot load and before every lifecycle
command via `prepareSlot()`.

**`slot.resolve()` — DNS only.** No args, no per-stack work.
- Queries `_hub.<domain>` TXT records for `KEY=value` pairs.
- Results cached to `<slot>/dns-cache.yml` with 30-second TTL.
- Never overwrites user overrides.

**`slot.stacks.refreshAll({repoRoot?, stack?})` — per-stack external
refresh + import re-eval.** Two passes:
1. **External re-fetch.** Per-stack `refreshSourcedVars()` handles
   `source: file` and `source: env`. Repo-root vault scan (when
   `repoRoot` provided) fetches `source: vault` vars and writes them
   to the provided stack context. Each stack's `.env` is recomputed
   via `computeEnv()` at the end of this pass.
2. **Import re-eval.** Every stack gets `stack.env.resolve()` called
   so cross-stack `manifest.imports` entries pick up the freshly-
   written dep values. Without this pass, a stack that imports a
   newly-rotated Vault secret from a dep would carry the stale value.

**CLI surface.** `zbb env refresh` runs both. `zbb env resolve` is a
narrower "recompute without external calls" — useful after `zbb env
set` changes a formula input, rarely needed in normal workflows.

### Stack dep chain recursion

`stack.load()` is recursive. When hub's load runs:

1. Compute union of `manifest.depends` keys + `manifest.imports` keys
   → `{dana}`.
2. Recursively call `slot.stacks.load('dana')` → dana's env resolves
   first.
3. Back in hub: `StackEnvironment.resolve()` reads dana's `.env` to
   satisfy the `imports: dana: [DANA_URL, ...]` list.
4. Hub's own derived/expression vars then evaluate with the imports
   available.

Diamond deps (stack A depends on B and C, both depend on D) resolve
D exactly once per invocation — `load()` takes a shared `visited`
Set.

### `stack.setState()` idempotency

`Stack.setState(partial)` merges + stringifies + compares. If nothing
changed, skips the write AND the `state:change` emit. This prevents
event storms from heartbeat/health polling where the same state is
re-asserted repeatedly.

---

## 9. Shell cd hook

Installed by `slot load` via the generated rcfile which sources
`lib/shell/hook.sh`.

### PROMPT_COMMAND integration

```bash
PROMPT_COMMAND="${PROMPT_COMMAND:+$PROMPT_COMMAND;}_zbb_scope_env;_zbb_check_heartbeat_alerts"
```

Runs on every prompt redraw. The hook:

1. Walks up from `$PWD` looking for the first `zbb.yaml` whose `name:`
   matches a stack that's added to this slot. Nested sub-manifests
   that AREN'T in the slot are skipped — the walk continues upward.
2. Updates `PS1` to `[zb:<slot>:<scope>:<stack>]` (or just
   `[zb:<slot>]` if no added stack matches).
3. If the matched stack changed (compared to previous prompt), unsets
   the previous stack's vars (preserving slot-level `ZB_SLOT_*`
   vars) and sources the new stack's `.env`.

### Stack env swap on cd

```
[zb:myslot]:~/nfa-repos$ cd com/hub
[stack: hub]
[zb:myslot:com:hub]:~/nfa-repos/com/hub$ echo $HUB_SERVER_PORT
15030
[zb:myslot:com:hub]:~/nfa-repos/com/hub$ cd ../../org/util
[stack: util]
[zb:myslot:org:util]:~/nfa-repos/org/util$ echo $HUB_SERVER_PORT
                                                                          # unset
```

### zbb() wrapper

After mutating subcommands (`env set/unset/reset/refresh`, `stack
add/remove/start/stop/restart`), the wrapper forces a
`_zbb_scope_env` reload so your current shell sees the new state
immediately.

---

## 10. Flow: command dispatch

**This is where the monorepo-vs-standard split lives.** Every other
flow above feeds into this.

Entry: `bin/zbb.mjs` → `cli-entry.js` → `cli.ts:main(argv)`.

### Phase 1 — Argument parsing

1. Extract global `--stack <name>` flag → sets `process.env.ZB_STACK`.
2. Extract global `--slot <name>` flag → loads the slot, resolves the
   stack from cwd (or from `--stack`), calls `prepareSlot(slot,
   {stack})`. From here, the rest of the dispatch runs with
   slot+stack env fully applied to `process.env`.
3. Check for `--help` / `--version` — early exit if matched.
4. Peel off the command verb: `args[0]`.

### Phase 2 — Subcommand routing

Before the lifecycle dispatch, check for non-lifecycle subcommands:

| Command | Handler | Notes |
|---------|---------|-------|
| `slot <sub>` | `handleSlot` | create/load/list/info/delete/gc |
| `stack <sub>` | `handleStack` | add/list/info/remove/start/stop/status/build/test/gate |
| `registry <sub>` | `handleRegistry` | Local Verdaccio cache |
| `secret <sub>` | `handleSecret` | create/get/list/update/delete |
| `env <sub>` | `handleEnv` | list/get/set/unset/reset/resolve/refresh/explain/diff |
| `logs <sub>` | `handleLogs` | list/show/debug/info |
| `dataloader` | `handleDataloader` | Platform dataloader wrapper |
| `run <script>` | Inline | zbb.yaml `scripts:` → package.json fallback |
| `exec <cmd>` | Inline | Arbitrary command with slot+stack env |
| `publishRemote` | Inline | Publish Gradle plugins to GitHub Packages Maven |
| Deprecated aliases | `checkDeprecatedAlias` | up/down/destroy/info — print migration hint |

**If none of those match AND the command is one of the canonical
lifecycle verbs (`clean`, `build`, `test`, `gate`, `publish`,
`dockerBuild`), we enter the lifecycle dispatch.**

### Phase 3 — Walk-up chain

```ts
const chain = await findZbbChain(process.cwd());
const monorepoEntry = findMonorepoRoot(chain);
```

- `findZbbChain` collects every `zbb.yaml` from cwd up to the first
  one with a `monorepo:` block (or `.git` / fs root).
- `findMonorepoRoot` returns that `monorepo:`-bearing entry, or null.

**Mode determination:** `isMonorepo = monorepoEntry != null`.

### Phase 4 — Lifecycle owner resolution

```ts
const owner = findLifecycleOwner(chain, command, parsed);
```

Walks the chain closest-first, returns the first entry whose
`lifecycle[command]` is defined. If none match, returns the outermost
entry with `lifecycleCmd: null` and `isFallback: true` — signaling
the dispatcher to fall through to `./gradlew <command>`.

The owner's entry is parsed via `normalizeLifecycleEntry()`:

- **Shorthand** (`build: ./gradlew monorepoBuild`) → `{command, tools: undefined, env: undefined}`.
- **Object form** (`build: {command: ..., tools: [node], env: [NPM_TOKEN]}`)
  → tools/env gates carry into the `LifecycleOwner` result.

### Phase 5 — Scope derivation (monorepo mode only)

```ts
const scope = isMonorepo
  ? derivePackageScope(process.cwd(), monorepoEntry.dir)
  : null;
```

Returns `{kind: 'root' | 'gradle' | 'npm' | 'invalid', ...}`. See
[§2 Scope](#scope-cwd--package).

### Phase 6 — Publish subdir block

```ts
if (command === 'publish' && scope && scope.kind !== 'root') {
  error("zbb publish must be run from the monorepo root (...). ");
  exit(1);
}
```

Hard error before touching the slot. Publish-from-subdir is
unsupported. See the `project_publish_subdir_block` memory.

### Phase 7 — `gate --check` fast path

```ts
if (command === 'gate' && parsed.check) { ... }
```

Skips slot loading, stack preflight, and env gates. Runs only the
lifecycle command (`./gradlew monorepoGateCheck` in monorepo mode,
or the standard equivalent). Scope-aware — passes
`-Pmonorepo.scope=<pkg>` if applicable, so the gate-stamp validation
loop skips unrelated packages.

**Monorepo mode path:**
```
spawnLifecycleAndExit(ownerDir, command, lifecycleCmd, parsed, {scopePackage?})
                                                                       ↓
                                     ./gradlew monorepoGateCheck -Pmonorepo.scope=<pkg> (+ --all / --base)
```

**Standard mode path:**
```
spawnStandardLifecycleAndExit(ownerDir, command, cmd, parsed)
                                                         ↓
                              ./gradlew [-PdryRun] [:subproject:]gateCheck  (via resolveCommandForCwd)
```

### Phase 8 — Slot + active-stack resolution + preflight

For any lifecycle command that is NOT `gate --check`:

1. **Require ZB_SLOT.** Fail fast if not inside a loaded slot via
   `requireLoadedSlot()`.
2. **Resolve the active stack.** `findActiveStackInChain(chain,
   addedShortNames, addedIdentityNames)` walks the chain closest-first
   and returns the first entry that:
   - Has a `name:`
   - Is NOT marked `overlay: true`
   - Is currently added to the slot
   Entries that fail any of those checks are skipped — so a sub-dir
   `zbb.yaml` with just lifecycle overrides (or with `name:` but not
   yet added) is walked past; the active stack ends up at the nearest
   added ancestor.
3. **If no active stack is reachable,** error with the list of added
   stacks in this slot and suggest `--stack <name>`, `cd`, or
   `zbb stack add <path>`. Do NOT tell the user to `zbb stack add .`
   (wrong direction when cwd is an overlay).
4. **Apply repo-level cleanse** — unset any vars listed in `cleanse:`
   BEFORE prepareSlot (so the stack's own values aren't overwritten
   later).
5. **`prepareSlot(slot, {stack})`:**
   - `slot.resolve()` — DNS TXT lookup only.
   - `slot.stacks.refreshAll({repoRoot, stack})` — two-pass external
     refresh (file/env/vault) + import re-eval across stacks.
   - Apply slot-level vars to `process.env`.
   - Recursively `stack.load()` the dep chain.
   - Apply stack env (resolved imports included) to `process.env`.
   - Set `ZB_STACK` to the active stack's short name.
6. **Stack-level `require:` preflight.** Resolve name references
   against the active stack's `tools:` registry. Inline `ToolRequirement`
   entries pass through for back-compat. Run the `runPreflightChecks()`
   pipeline. Fail if any tool is missing.

### Phase 9 — Per-command tools/env gates (object form only)

For lifecycle entries in object form:

1. **Resolve gate registry.** `resolveGateRegistry(activeStackEntry)` is
   a simple getter — pulls `tools:` and `env:` blocks off the active
   stack. Overlay entries borrow the stack's vocabulary, so the lookup
   always uses the active stack's registry regardless of which file
   defined the lifecycle entry.
2. **Tool gates** (`checkToolGates`). Each name in `owner.tools`
   looks up in the registry; undefined name → hard error. Resolved
   definitions go through `runPreflightChecks()` just like `require:`
   entries.
3. **Env gates** (`checkEnvGates`). Each name in `owner.env` looks
   up in the manifest's `env:` declarations (undeclared → error),
   then `stack.env.get(name) ?? slot.env.get(name)` — empty or
   unresolved → fail with the declared `source:` as a hint.
4. If any gate failed → exit 1 before spawning.

### Phase 10 — Dispatch (the monorepo vs standard split)

```
                        ┌─────────────────────┐
                        │  isMonorepo == true │
                        │  (monorepoEntry set)│
                        └────┬────────────────┘
                             │
               ┌─────────────┴─────────────┐
               │                           │
          owner.lifecycleCmd           owner.lifecycleCmd == null
          is defined                   (fallback)
               │                           │
               ▼                           ▼
  spawnLifecycleAndExit(ownerDir,   spawnGradleFallbackAndExit(
     command,                          ownerDir,
     owner.lifecycleCmd,               command,
     parsed,                           parsed,
     {scopePackage?})                  {scopePackage?})
               │                           │
               └──┬────────────────────────┘
                  │  Both append:
                  │   -Pmonorepo.all / -Pmonorepo.base (if --all / --base)
                  │   -PdryRun / -Pforce (if --dry-run / --force)
                  │   -Pmonorepo.scope=<pkg> (when scope != 'root')
                  │  Both use runWithDisplay() via MonorepoDisplay if TTY
                  │  and command ∈ {build, test, gate, dockerBuild}.
                  ▼
             monorepoGraphService reads -Pmonorepo.scope,
             clamps changeResult.affected to {scope}
             (or keeps git-diff affected set otherwise).
             Cascades to all for-affected loops in the plugins.
```

```
                        ┌─────────────────────┐
                        │  isMonorepo == false│
                        └────┬────────────────┘
                             │
                             ▼
    spawnStandardLifecycleAndExit(ownerDir, command, cmd, parsed)
                             │
                  cmd = owner.lifecycleCmd ?? `./gradlew ${command}`
                             │
                             ▼
                   resolveCommandForCwd(ownerDir, cmd)
                             │
               ┌─────────────┼──────────────────┐
               │             │                  │
          cwd == ownerDir    cwd is gradle      cwd has package.json
               │             subproject         but no build.gradle.kts
               ▼             (build.gradle.kts    │
        cmd unchanged        + in settings)       ▼
               │             │                 ERROR: not a gradle
               │             ▼                 subproject — add
               │    cmd becomes:               build.gradle.kts
               │    `./gradlew :foo:bar:build` or run from root
               │
               ▼
    spawnSync('bash', ['-c', cmd + passthrough], {cwd: ownerDir, ...})
```

### Phase 11 — Custom verb dispatch

If the command is NOT a canonical lifecycle verb (i.e. not
`clean/build/test/gate/publish/dockerBuild`), the dispatcher checks
the chain for a custom verb:

```ts
const customOwner = findCustomVerbOwner(chain, command);
```

Walks the chain closest-first. If any entry's `lifecycle[command]` is
a string (or object form's `command`), it's a custom verb — executes
via `bash -c` with slot+stack env, from the owner's directory. This
is how `zbb buildVm` from `com/hub/appliance/` works.

### Phase 12 — Permissive gradle fallback

If nothing above matched — no lifecycle entry, no custom verb — fall
through to `runGradle(args)`. This preserves the "smart wrapper"
behavior for repos without a `zbb.yaml`: `findGradleRoot(cwd)` → run
`./gradlew <args>` with cwd-aware subproject prefixing.

---

## 11. Scenarios — concrete walk-throughs

Using the hub and util repos as examples.

### Scenario A — `zbb build` from `com/hub/` (monorepo root)

1. Chain = `[com/hub/zbb.yaml]` — stops at monorepo block.
2. `monorepoEntry = com/hub/zbb.yaml`. `isMonorepo = true`.
3. `owner = com/hub/zbb.yaml`, `lifecycleCmd = "./gradlew
   monorepoBuild"`, `env: ["NPM_TOKEN"]`, `tools: undefined`.
4. Scope = `{kind: 'root'}` → no scope flag.
5. Preflight: `require: [nvm, node, java]` → resolved against tools
   registry → all pass.
6. Env gate: `NPM_TOKEN` is declared in `env:` and `source: env,
   required: true` → must have resolved via `process.env.NPM_TOKEN`
   at slot create; if empty, gate fails.
7. Dispatch: `spawnLifecycleAndExit(com/hub, 'build', './gradlew
   monorepoBuild', parsed, undefined)`.
8. Gradle runs `./gradlew monorepoBuild` from `com/hub/`. Plugin
   computes `changeResult.affected` via git diff; per-subproject
   `build` tasks wire up via `dependsOn`. TTY display renders
   per-phase rows.

### Scenario B — `zbb build` from `com/hub/server/` (workspace subpackage)

1. Chain = `[com/hub/zbb.yaml]` — `com/hub/server/` has no
   `zbb.yaml` of its own; walk up to hub's root.
2. `isMonorepo = true` (same monorepo entry).
3. `owner = com/hub/zbb.yaml`, `lifecycleCmd = "./gradlew
   monorepoBuild"`.
4. Scope: `derivePackageScope("com/hub/server", "com/hub")` →
   workspace member in `workspaces: [server]` → `{kind: 'npm',
   packageName: '@zerobias-com/hub-server', relPath: 'server'}`.
5. Preflight + env gate: same as A.
6. Dispatch: `spawnLifecycleAndExit(com/hub, 'build', './gradlew
   monorepoBuild', parsed, {scopePackage:
   '@zerobias-com/hub-server'})`.
7. Final gradle command: `./gradlew monorepoBuild
   -Pmonorepo.scope=@zerobias-com/hub-server`.
8. `MonorepoGraphService.changeResult` substitutes to
   `{affected={@zerobias-com/hub-server}}`. `monorepoBuild`'s for-each
   loop only wires one subproject's tasks.

### Scenario C — `zbb build` from `com/hub/node-stack/` (nested stack)

Setup: both `hub` and `node-stack` are added as separate stacks in
the slot. `node-stack/zbb.yaml` has `name:` and defines
`lifecycle.start/stop/health` but NO `build`.

1. Chain walk from `com/hub/node-stack/`:
   - `node-stack/zbb.yaml` — has name, no `lifecycle.build`.
   - `com/hub/zbb.yaml` — has monorepo block. Stops chain.
   - Chain = `[node-stack, hub]`.
2. `isMonorepo = true` (hub's monorepo block).
3. **Active stack** (`findActiveStackInChain`): node-stack is named AND
   added → returns node-stack. (It's closer than hub.)
4. **Lifecycle owner** (`findLifecycleOwner`): node-stack has no
   `build` → walk up → hub has `lifecycle.build`. Owner = hub.
   `lifecycleCmd = "./gradlew monorepoBuild"`, `env: ["NPM_TOKEN"]`.
5. Scope: `derivePackageScope("com/hub/node-stack", "com/hub")` →
   `{kind: 'npm', packageName: '@zerobias-com/hub-node-stack', ...}`.
6. Preflight + gate registry: pulled from the **active stack**
   (node-stack), NOT the lifecycle owner. So `NPM_TOKEN` must be
   declared in node-stack's `env:` block, not hub's. If it isn't, the
   gate fails with "NPM_TOKEN not declared in the stack manifest's
   env: block" — an intentional enforcement: a standalone stack
   borrowing a parent's lifecycle command must declare the vocabulary
   that command expects.
7. **If you want node-stack to transparently use hub's registry
   instead,** mark `node-stack/zbb.yaml` with `overlay: true`. The
   walk-up will skip it and the active stack becomes hub.
8. Dispatch: same as scenario B but scope is node-stack's npm name.

**Key points:**
- Walk-up finds the lifecycle definition; scope is driven by cwd.
- Registry comes from the **active stack** (closest added). The
  lifecycle owner and the active stack can be different files — the
  owner authors the command, the active stack authors the vocabulary.
- To suppress a sub-stack's own identity and borrow the parent's, use
  `overlay: true`.

### Scenario C2 — `zbb build` from a pure overlay sub-dir

Setup: `com/hub/zbb.yaml` (stack `hub`, added) + `com/hub/packages/server/zbb.yaml`
(nameless, pure overlay with its own `lifecycle.build`):

```yaml
# com/hub/packages/server/zbb.yaml
lifecycle:
  build:
    command: ./my-special-build.sh
    tools: [node]
    env:   [NPM_TOKEN]
```

1. Chain = `[server/zbb.yaml, hub/zbb.yaml]`.
2. **Active stack**: server is nameless → skip; hub is named + added
   → active = hub.
3. **Lifecycle owner**: server has `lifecycle.build` → owner = server.
4. Scope: `derivePackageScope` → `{kind: 'npm', packageName: '@scope/server'}`.
5. Gate registry: hub's `tools:` + `env:` blocks. server's overlay
   borrows hub's vocabulary — `[node]` resolves to hub's `tools.node`,
   `[NPM_TOKEN]` resolves to hub's `env.NPM_TOKEN`.
6. Dispatch: runs `./my-special-build.sh` (server's override command)
   from `server/` directory, with hub's env applied to `process.env`
   and `ZB_STACK=hub`.

**Same scenario with `overlay: true` on server:** identical behavior.
The marker is belt-and-suspenders — it just prevents a teammate from
running `zbb stack add packages/server/` and accidentally promoting
the overlay to a real stack.

### Scenario D — `zbb gate --check` from any cwd

1. Chain walk + monorepo detection + scope derivation same as above.
2. **Fast path triggers before slot preflight.** No slot, no stack,
   no prepareSlot. No env gates (no slot env yet).
3. If invalid scope (cwd isn't a workspace member) → refuse.
4. Dispatch: `spawnLifecycleAndExit(ownerDir, 'gate', './gradlew
   monorepoGateCheck', parsed, {scopePackage?})`.
5. Gradle runs `monorepoGateCheck`. The plugin's gate-check loop
   skips packages not in scope — only the scoped package's stamp
   entry is validated.

### Scenario E — `zbb publish` from `com/hub/server/`

1. Chain + owner + scope resolution runs normally. Scope = `{kind:
   'npm', packageName: '@zerobias-com/hub-server'}`.
2. **Publish subdir block fires** (Phase 6): `command === 'publish'
   && scope.kind !== 'root'` → error, exit 1, no gradle invocation.
3. User message: "zbb publish must be run from the monorepo root
   (/home/cscarola/nfa-repos/com/hub)."

### Scenario F — `zbb buildVm` from `com/hub/appliance/`

Appliance has a custom lifecycle verb:

```yaml
# com/hub/appliance/zbb.yaml
lifecycle:
  buildVm: ./scripts/build-vm.sh
```

1. Chain = `[appliance, hub]`.
2. `buildVm` is not a canonical lifecycle verb → skip lifecycle
   dispatch entirely.
3. Custom verb dispatch: `findCustomVerbOwner(chain, 'buildVm')` →
   appliance.
4. Load slot (required for custom verbs), resolve stack, prepareSlot.
5. `spawnSync('bash', ['-c', './scripts/build-vm.sh'], {cwd:
   applianceDir, env: process.env})`.

### Scenario G — `zbb build` in a repo with no `monorepo:` block (standard mode)

1. Chain = `[someRepo/zbb.yaml]`. No monorepo block → `isMonorepo =
   false`.
2. Owner = same zbb.yaml, `lifecycleCmd = "./gradlew build"` (or
   whatever the repo declares).
3. Scope is not derived (standard mode).
4. Preflight + env gate same as monorepo.
5. Dispatch: `spawnStandardLifecycleAndExit`.
6. `resolveCommandForCwd(someRepo, "./gradlew build")`:
   - If cwd == someRepo → `./gradlew build` unchanged.
   - If cwd has `build.gradle.kts` + in settings →
     `./gradlew :packages:foo:build`.
   - If cwd has `package.json` but no `build.gradle.kts` → error out.
7. No monorepo flags, no TUI display — plain inherited stdio.

---

## 12. On-disk file layout

### Slot

```
~/.zbb/slots/<name>/
  slot.yaml                   # {name, created, portRange, ephemeral?, ttl?, expires?}
  .env                        # ZB_SLOT_* framework vars only
  manifest.yaml               # per-slot-var provenance
  # (slot overrides: value goes to .env, manifest.yaml tags source: 'override')
  dns-cache.yml               # DNS TXT resolution cache (TTL-based)
  .zbb-bashrc                 # generated rcfile for `slot load` subshell
  config/                     # app-specific config (stacks populate)
  logs/                       # app log files
  state/
    tmp/                      # scratch
    secrets/                  # cached secrets per stack (for re-add stability)
    heartbeat-alerts.log      # pending alerts to display at next prompt
  stacks/                     # one dir per added stack (see below)
```

### Stack (inside a slot)

```
~/.zbb/slots/<slot>/stacks/<stack-short-name>/
  stack.yaml                  # {name, version, mode: dev|packaged, source, added, alias?}
  .env                        # computed env (all 3 layers resolved)
  manifest.yaml               # per-var provenance
  state.yaml                  # stack-level state (status, ...)
  logs/                       # stack log files
  state/
    secrets/                  # secret values (hex, rsa keys) cached here
  substacks/                  # one dir per substack declared in manifest
    <object-substack>/
      state.yaml              # object substack state (single file)
    <collection-substack>/
      <id>.yml                # collection items (one file per item)
```

### Monorepo event + log directory (at repo root)

```
<repo>/.zbb-monorepo/
  events.jsonl                # JSONL event stream (EventEmitter output)
  logs/                       # per-task Exec output (cleared on each monorepoGate run)
    <safe-subproject>-<task>.log
  gate-check.marker           # valid=true|false, reason=..., ts=...
  publish-plan.json           # PublishPlan output
```

### Global zbb state

```
~/.zbb/
  config.yaml                 # user config (java home, node version, prompt template, skip_checks)
  cache/
    stacks/<name>@<version>/  # extracted npm stack packages
  slots/                      # (see above)
```

### Repo-level

```
<repo>/
  zbb.yaml                    # stack manifest + repo config (monorepo: block, tools:, etc)
  package.json                # workspaces:, npm deps
  gradlew, settings.gradle.kts, build.gradle.kts   # gradle
  gate-stamp.json             # unified gate stamp (written by monorepoGate)
  .gradle/zbb-projects.json   # cached project-path map (projectPaths Gradle task output)
```

---

## 13. Glossary

- **Slot** — Named env context at `~/.zbb/slots/<name>/`. Holds
  identity/path vars and per-stack env files. See [§2](#slot).
- **Stack** — Composable unit added to a slot. Identified by
  `name:` in its `zbb.yaml`. See [§2](#stack).
- **Active stack** — The closest chain entry whose name matches a
  stack currently added to the slot. Skips nameless overlays, entries
  marked `overlay: true`, and entries whose names aren't added. See
  `config.ts:findActiveStackInChain`.
- **Overlay** — A `zbb.yaml` that contributes lifecycle entries but
  isn't the active stack. Either nameless, or `overlay: true`, or
  named-but-not-added. Borrows `env:`/`tools:`/`require:` from the
  active stack above it.
- **Stack manifest** — A `zbb.yaml` with a `name:` field. One
  registry per manifest for tools/env. See [§2](#stack-manifest).
- **Chain** — Ordered list of ancestor `zbb.yaml` files from cwd to
  monorepo root (or `.git` / fs boundary). See [§2](#chain--walk-up).
- **Monorepo mode / standard mode** — Dispatcher mode, determined by
  presence of a `monorepo:` block in the chain. See [§2](#monorepo-mode-vs-standard-mode).
- **Scope** — Classification of cwd relative to the monorepo root:
  `root | gradle | npm | invalid`. Drives `-Pmonorepo.scope=<pkg>`.
  See [§2](#scope-cwd--package).
- **Lifecycle owner** — The chain entry whose `lifecycle[command]`
  is defined, picked closest-first. See [§10 Phase 4](#phase-4--lifecycle-owner-resolution).
- **Gate registry** — The stack manifest's `tools:` + `env:` blocks,
  looked up at or above the lifecycle owner's dir. See [§10 Phase 9](#phase-9--per-command-toolsenv-gates-object-form-only).
- **Require (stack-level)** — Preflight checked at slot load + stack
  add. New schema: name references into `tools:` registry. See [§3 Stack-level preflight](#stack-level-preflight-manifest-level-new-in-phase-4).
- **Tool gate / env gate** — Per-lifecycle-command preflight from
  `lifecycle.<cmd>.tools` / `.env`. Runs after slot+stack env
  resolution, before command spawns. See [§10 Phase 9](#phase-9--per-command-toolsenv-gates-object-form-only).
- **Aggregator task** — Root `monorepo*` Gradle tasks (monorepoBuild,
  monorepoTest, etc) that iterate `affected` and wire up
  per-subproject tasks. See [§4](#key-plugin-tasks).
- **Affected set** — Git-diff-computed set of changed +
  transitively-dependent packages, or `{scope}` when scope is set.
  See [§4 MonorepoGraphService](#monorepograpservice--shared-state).
- **Gate stamp** — `gate-stamp.json` at the repo root. Unified
  per-package record of source hashes + task states written by
  `monorepoGate`, validated by `monorepoGateCheck`. See [§4](#key-plugin-tasks).
