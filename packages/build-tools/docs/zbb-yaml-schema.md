# `zbb.yaml` schema (Phase 3 — single-file model)

**Status:** locked design, implementation in progress.

This document is the contract for the merged `zbb.yaml` file that replaces the
old two-file split between `.zbb.yaml` (repo-level) and `<stack>/zbb.yaml`
(stack-level). It is the source of truth for the Phase 3 migration tasks
(#44–#57).

## Why one file

Splitting config across two files created collisions: env vars declared at the
repo level shadowed (or were shadowed by) the same vars in the stack manifest,
preflight checks ran twice, and the routing logic in `cli.ts` had to dispatch
across three tiers (monorepo handler → stack-from-cwd → gradle pass-through) to
figure out which lifecycle entry to honour. Phase 3 collapses all of that into
a single file at the repo root and a single dispatch tier in zbb.

**Result:** one spot for `require:`, one spot for `env:`, one spot for
`lifecycle:`, one spot for `monorepo:`. No merge precedence rules to remember.

## File location

```
<repo>/zbb.yaml
```

That's it. No `.zbb.yaml`. No `<repo>/stack/zbb.yaml`. The `<repo>/stack/`
directory remains as an npm publishing artifact for the `*-stack` package, but
the `zbb.yaml` lives at the repo root.

## Discovery

`zbb` walks up from cwd looking for `zbb.yaml`. The first match wins. `gradlew`
remains a fallback marker for "smart Gradle wrapper" mode (when there's no
`zbb.yaml` at all — see [Permissive fallback](#permissive-fallback)).

## Top-level shape

```yaml
# ── Stack identity ──────────────────────────────────────────────────────
name: "@zerobias-com/dana-stack"   # full npm package name (required)
version: "1.0.0"                    # semver (required for stack add)

# ── Tool preflight ──────────────────────────────────────────────────────
require:
  - tool: node
    check: "node --version"
    parse: "v(\\S+)"
    version: ">=22"
    install: "nvm install 22"
  - tool: java
    check: "bash -c '$JAVA_HOME/bin/java -version 2>&1'"
    parse: 'version "(\S+)"'
    version: "21"
    install: "apt install openjdk-21-jdk"
    commands: [build, test, gate]   # optional: limit to specific commands
  - tool: docker
    check: "docker --version"
    parse: "Docker version (\\S+),"
    version: ">=24"
    commands: [build, test, gate]

# ── Env declarations (replaces both .zbb.yaml env: and stack zbb.yaml env:) ─
env:
  LOG_LEVEL:
    type: string
    default: info
  PG_PORT:
    type: port
  API_KEY:
    type: secret
    generate: hex32
  NEON_API_KEY:
    source: vault                                   # dev: fetch from vault
    vault: "operations-kv/neon/content.api-key"     # CI: pre-populated by vault-action,
    mask: true                                       #     slot inherits as override

# ── Vars to strip from parent shell on slot load ────────────────────────
cleanse:
  - AWS_PROFILE
  - KUBECONFIG
  - DATABASE_URL

# ── Port allocation range ───────────────────────────────────────────────
ports:
  range: [15000, 16000]

# ── Lifecycle delegation ────────────────────────────────────────────────
# Maps zbb commands to shell strings. zbb spawns these (with TTY display for
# build/test/gate) instead of having any hardcoded build logic. If a command
# isn't in this block, zbb falls through to ./gradlew <command>.
lifecycle:
  clean:     ./gradlew monorepoClean
  build:     ./gradlew monorepoBuild
  test:      ./gradlew monorepoTest
  gate:      ./gradlew monorepoGate
  gateCheck: ./gradlew monorepoGateCheck   # cheap stamp validation, no slot needed
  publish:   ./gradlew monorepoPublish
  # Repos that need test-DB provisioning own the script:
  # gate: ./scripts/gate-with-neon.sh

# ── Monorepo orchestration (consumed by Gradle plugins, optional) ───────
monorepo:
  registry: https://npm.pkg.github.com/
  sourceDirs: [src]
  sourceFiles: [tsconfig.json, api.yml, package.json]
  buildPhases: [lint, generate, transpile]
  testPhases: [test]
  skipPublish: [test]
  images:
    app:
      context: image/app
      name: dana-app
      workflow: dana-app-image-publish.yml
    scim-api:
      context: image/scim-api
      name: dana-scim-api
      workflow: scim-api-image-publish.yml

# ── Stack composition (only for repos that import other stacks) ─────────
depends:
  postgres: "^16.0"
imports:
  postgres: [PG_PORT, PG_USER, PG_PASSWORD]
exports:
  - DANA_PORT
  - API_KEY
substacks: { ... }
state: { ... }
logs: { ... }
secrets: { ... }
```

## What's required vs optional

| Field        | Required | Notes |
|--------------|----------|-------|
| `name`       | ✓        | Full npm package name. Used by `zbb stack add .` to register the stack. |
| `version`    | ✓        | Semver. |
| `lifecycle`  | optional | Without it, every command falls through to `./gradlew <cmd>` (permissive fallback). |
| `require`    | optional | Empty `require: []` is fine. |
| `env`        | optional | If empty, the stack contributes no env to the slot. |
| `cleanse`    | optional | Default: `[]`. |
| `ports`      | optional | Default: no port allocation needed. |
| `monorepo`   | optional | Only set when this is a Gradle-driven monorepo. Single-package repos omit it. |
| `depends` / `imports` / `exports` / `substacks` / `state` / `logs` / `secrets` | optional | Stack-composition fields, unchanged from the existing stack manifest model. |

## What changed from the old model

### Removed

| Field | Where it was | Replacement |
|-------|--------------|-------------|
| `monorepo.enabled: true` | `.zbb.yaml` | Presence of the `monorepo:` block IS the marker. |
| `monorepo.gatePreflight: [ToolRequirement, ...]` | `.zbb.yaml` | Fold each entry into top-level `require:` with `commands: [gate]`. |
| `monorepo.testDatabase: { provider, packages, ... }` | `.zbb.yaml` | **No replacement in zbb core.** See [Neon test DB note](#neon-test-db-the-only-real-loss) below. |
| `RepoConfig.inherit: true` | `.zbb.yaml` (default) | Goes away — there's no repo-vs-stack split to inherit between. |

### Renamed locations (same semantics)

| Old location | New location |
|--------------|--------------|
| `<repo>/.zbb.yaml` `env:` | `<repo>/zbb.yaml` `env:` |
| `<repo>/.zbb.yaml` `require:` | `<repo>/zbb.yaml` `require:` |
| `<repo>/.zbb.yaml` `cleanse:` | `<repo>/zbb.yaml` `cleanse:` |
| `<repo>/.zbb.yaml` `ports:` | `<repo>/zbb.yaml` `ports:` |
| `<repo>/.zbb.yaml` `monorepo:` | `<repo>/zbb.yaml` `monorepo:` |
| `<repo>/.zbb.yaml` `lifecycle:` | `<repo>/zbb.yaml` `lifecycle:` |
| `<stack-dir>/zbb.yaml` (everything) | merged into `<repo>/zbb.yaml`; per-stack file deleted |

### Added

| Field | Purpose |
|-------|---------|
| Top-level `name` and `version` (already in stack manifest) | Required so `zbb stack add .` can identify the stack from cwd. |

## Schema for `env:` declarations

Unchanged from `EnvVarDeclaration` in `lib/config.ts`. Reference:

```yaml
env:
  VAR_NAME:
    type: string | port | secret | enum     # required
    values: [a, b, c]                       # for enum
    default: "value"                        # frozen at slot create
    value: "${OTHER_VAR}-suffix"            # live formula, recomputes
    description: "what this is for"
    mask: true                              # hide in zbb env list
    hidden: true                            # hide entirely from UI
    generate: hex32                         # auto-generate secret
    source: env | vault | file | cwd | expression:jsonata
    vault: "mount/path.field"               # for source: vault
    file: "~/.config/foo"                   # for source: file
    expr: "$ENV_X & $ENV_Y"                 # for source: expression:jsonata
    refresh: true                           # re-fetch on env refresh
    required: true                          # error if missing
    deprecated: true
    replacedBy: NEW_VAR_NAME
```

## Schema for `require:` declarations

Unchanged from `ToolRequirement` in `lib/config.ts`. Reference:

```yaml
require:
  - tool: <name>                # display name
    check: "<shell command>"    # command that prints version info
    parse: "<regex>"            # extracts version from check output
    version: "<semver range>"   # required version (e.g., ">=22", "21")
    install: "<install hint>"   # shown on failure
    commands: [build, gate]     # OPTIONAL: limit to specific zbb commands
```

`commands:` filtering is what subsumes the old `monorepo.gatePreflight` —
gate-only Vault/PG/Neon checks just become:

```yaml
require:
  - tool: vault
    check: "vault status"
    parse: "Sealed\\s+(\\S+)"
    version: "false"
    commands: [gate, publish]
```

## Schema for `lifecycle:` block

Unchanged from `LifecycleConfig` in `lib/config.ts`. Reference:

```yaml
lifecycle:
  clean:     <shell string>
  build:     <shell string>
  test:      <shell string>
  gate:      <shell string>
  gateCheck: <shell string>          # cheap stamp validation; no slot/stack required
  publish:   <shell string>
  start:     <shell string>          # docker compose up etc.
  stop:      <shell string>
  health:    <shell string> | { command, interval, timeout }
  seed:      <shell string>
  cleanup:   <shell string> | [<shell string>, ...]
```

`gate-check` has special routing: it does NOT require a loaded slot, does NOT
require the stack to be added, and does NOT run preflight. It only validates
`gate-stamp.json` against the working tree. Every other lifecycle command
requires slot+stack context.

If a command is invoked but missing from `lifecycle:`, zbb falls through to
`./gradlew <command>`. Gradle errors with "task not found" if the task doesn't
exist. This is the [permissive fallback](#permissive-fallback).

## Schema for `monorepo:` block (Gradle-side consumption)

The `monorepo:` block is read by the Gradle plugins (`zb.monorepo-base/-build/
-gate/-publish`) via `MonorepoGraphService.loadMonorepoConfig`. After Phase 3,
the only consumer is the Gradle side — zbb's TS layer no longer reads it (the
legacy `Builder.ts`/`Publisher.ts` consumers are deleted).

```yaml
monorepo:
  # Source detection — used by ChangeDetector for per-package hashing
  sourceDirs: [src]                                 # default
  sourceFiles: [tsconfig.json]                      # default

  # Phase ordering — used by zb.monorepo-build to register per-package tasks
  buildPhases: [lint, generate, transpile]          # default
  testPhases: [test]                                # default

  # Publish behaviour
  registry: https://npm.pkg.github.com/             # used for publish
  skipPublish: [test, integration-tests]            # workspace dirs to skip
  # `private: true` packages are filtered automatically — no need to list them.

  # Docker images — used by zb.monorepo-publish to dispatch image build workflows
  images:
    <relDir>:
      context: image/<dir>
      name: <ghcr-image-name>
      workflow: <workflow-file>.yml
```

## Permissive fallback

Three states for `zbb <command>`:

| State | Behaviour |
|-------|-----------|
| Cwd has no `zbb.yaml` | Fall through to `./gradlew <command>` (smart wrapper mode). No slot/stack required. |
| Cwd has `zbb.yaml` but no slot loaded (and command isn't `gate --check`) | Error: `Not inside a loaded slot. Run: zbb slot load <name>` |
| Cwd has `zbb.yaml`, slot loaded, stack not added | Error: `Stack '<name>' not added to active slot. Run: zbb stack add .` |
| Cwd has `zbb.yaml`, slot loaded, stack added, no `lifecycle.<command>` entry | Apply env+cleanse+preflight, then fall through to `./gradlew <command>`. Gradle reports "task not found" if it doesn't exist. |
| Cwd has `zbb.yaml`, slot loaded, stack added, `lifecycle.<command>` defined | Apply env+cleanse+preflight, spawn the lifecycle string. For build/test/gate over a TTY, use the project-centric Display. |
| `zbb gate --check` (any state) | Skip slot, stack, env, preflight. Just spawn `lifecycle.gateCheck` (or fall through to `./gradlew monorepoGateCheck`). Pure stamp validation. |

## Neon test DB — the only real loss

The legacy `Builder.ts:1219-1450` did this:

1. Read `monorepo.testDatabase.{provider, parentBranch, packages}`
2. Before each test-package run, create a Neon ephemeral branch via the Neon
   API and export `DATABASE_URL` for that package
3. After the package's tests, delete the branch
4. Track all created branches in a `neonBranches[]` array for guaranteed
   cleanup at the end

The Gradle plugins do NOT do any of this. When we delete `Builder.ts`, the
provisioning logic dies with it. **3 of the 6 repos depend on this:**
`com/hub`, `com/fileservice`, `com/platform`.

### Recommended replacement: repo-owned `lifecycle.gate` script

Each affected repo writes a small shell script that wraps the Gradle gate task:

```bash
# scripts/gate-with-neon.sh
#!/usr/bin/env bash
set -euo pipefail

# Create a single ephemeral branch for this gate run
BRANCH_ID=$(curl -s -X POST \
  -H "Authorization: Bearer $NEON_API_KEY" \
  -H "Content-Type: application/json" \
  "https://console.neon.tech/api/v2/projects/$NEON_PROJECT_ID/branches" \
  -d "{\"branch\":{\"parent_id\":\"$NEON_PARENT_BRANCH_ID\"}}" \
  | jq -r '.branch.id')

cleanup() {
  curl -s -X DELETE \
    -H "Authorization: Bearer $NEON_API_KEY" \
    "https://console.neon.tech/api/v2/projects/$NEON_PROJECT_ID/branches/$BRANCH_ID"
}
trap cleanup EXIT

export DATABASE_URL=$(get_branch_dsn "$BRANCH_ID")
exec ./gradlew monorepoGate "$@"
```

And reference it from `lifecycle.gate`:

```yaml
lifecycle:
  gate: ./scripts/gate-with-neon.sh
```

**Why this is better than porting to a Gradle plugin:**

- Each repo owns its test-DB strategy (some may need per-package branches,
  others one branch for the whole gate run, others may switch providers)
- The shell script is trivial to debug — it's just curl + gradle
- zbb stays stupid: it only spawns the lifecycle command and doesn't know
  about Neon
- No Kotlin code to write or maintain

The trade-off: each repo writes ~30 lines of bash. Acceptable for 3 repos.

If we decide later that we want a shared abstraction, we can write a
`zb.test-database` Gradle plugin that hooks into the gate task lifecycle. But
that's a Phase 4+ decision — Phase 3 takes the simpler path.

### Migration impact

| Repo | Action |
|------|--------|
| `com/util` | No `testDatabase` — no change |
| `com/hydra-service` | No `testDatabase` — no change |
| `com/dana` | No `testDatabase` — no change |
| `com/fileservice` | Has `testDatabase: { provider: neon, packages: [app] }` — write `scripts/gate-with-neon.sh`, set `lifecycle.gate` to it |
| `com/hub` | Has `testDatabase: { provider: neon, packages: [server, test] }` — write `scripts/gate-with-neon.sh` |
| `com/platform` | Has `testDatabase: { provider: neon, packages: [api, batch-processor, dataloader-service, events, portal-api, store-api] }` — write `scripts/gate-with-neon.sh` |

The script is the same across all three repos (only the package list differs),
so it can live in `zerobias-com/devops` as a shared script and each repo
references it via a known path or via `npx`.

## CI flow (locked)

Workflows declare a slot at the top level and bootstrap once per job:

```yaml
env:
  ZB_SLOT: ci-${{ github.run_id }}-${{ github.run_attempt }}

jobs:
  gate-check:
    # gate --check is slot-less — no bootstrap step
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
      - uses: actions/setup-java@v4
      - run: cp .npmrc $HOME/.npmrc && npm ci && npm install -g @zerobias-org/zbb@latest
      - run: npx zbb gate --check
        env:
          GITHUB_TOKEN: ${{ env.GITHUB_TOKEN }}
          READ_TOKEN: ${{ env.READ_TOKEN }}

  gate-run:
    needs: [gate-check]
    if: needs.gate-check.outputs.stamp_valid == 'false'
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
      - uses: actions/setup-java@v4
      - uses: hashicorp/vault-action@v3
        with:
          secrets: |
            operations-kv/data/neon/content api-key | NEON_API_KEY ;
            operations-kv/data/neon/content project-id | NEON_PROJECT_ID ;
      - run: cp .npmrc $HOME/.npmrc && npm ci && npm install -g @zerobias-org/zbb@latest
      # Bootstrap: create slot, snapshot env as overrides, add cwd's stack
      - run: |
          zbb slot create $ZB_SLOT --ephemeral
          zbb stack add .
      # Run gate — slot env (incl. NEON_*) flows from the snapshot
      - run: zbb gate
```

`zbb slot create --ephemeral` in CI mode:

1. Allocates slot dir, ports, paths, name
2. Snapshots `process.env` into `overrides.env` (so vault-injected secrets
   become slot overrides)
3. Skips the interactive subshell spawn
4. Skips preflight (CI installs its own toolchain)
5. Lazy-resolves env declarations on first use

`zbb stack add .` reads `./zbb.yaml`, registers the stack into the slot,
applies env declarations (anything already in `overrides.env` from the
snapshot wins; vault/file/generate sources fill in the rest), and validates
that all required vars are present. Fails fast if any are missing.

## Open items

- **Test DB strategy** — `gate-with-neon.sh` template needs to be written and
  placed somewhere all 3 affected repos can reference it (shared
  `zerobias-com/devops` script vs per-repo copy). Decision deferred to the
  per-repo migration tasks (#54, #55, #56).
- **Slot env priority for CI overrides** — `Slot.resolve` needs a one-line
  change so `overrides.env` snapshot always wins over `source: vault`
  re-fetching. This is part of task #49.
- **Shell hooks** — `zbb hook bash`/`zbb hook zsh` (#50) — design is locked
  but unimplemented; non-blocking for the migration since per-command
  resolution works without it.
