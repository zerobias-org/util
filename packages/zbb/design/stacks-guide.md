# zbb Stacks — User Guide

> **Status:** Design draft. This document describes the target DX before implementation.
> Open questions are marked with **[OPEN]** throughout.

Stacks are composable units of infrastructure that live inside zbb slots. They turn "clone repo, read wiki, set 20 env vars, pray" into `zbb stack add ./my-service && zbb start my-service`.

## What Problem Does This Solve?

### Today

A developer wants to work on a REST service that needs Postgres and Dana:

1. Clone meta-repo, initialize submodules
2. Figure out which branch each submodule should be on
3. `zbb slot create local`
4. `cd com/dana && zbb up` — wait for Gradle, schema apply, seed data
5. `cd ../my-service` — manually wire env vars, hope nothing conflicts
6. Discover you're missing a vault token, debug for 20 minutes
7. CI? Rebuild all of that in a GitHub Action with 50 lines of YAML

Knowledge of "Hub needs Dana needs Postgres" lives in tribal knowledge and Gradle task wiring. A new developer has no way to discover this except by failing.

### With Stacks

```bash
zbb slot create local
zbb stack add ./my-service
# Dana + Postgres pulled as packaged deps, ports allocated,
# secrets generated, schema applied — automatically
zbb start my-service
```

The gap between "I have source code" and "I have a running environment" collapses to one command that resolves the dependency tree.

CI is the same commands with an ephemeral slot. No special scripts.

### Other Perspectives

**Platform team** — publish a stack once, every consumer gets a working Dana without cloning the repo or understanding its internals.

**Module developer** — `zbb stack add ./my-module` pulls Hub + Dana + Postgres as packaged deps. Developer writes module code, not infrastructure scripts.

**Appliance** — a thin base that pulls packaged stacks. Ship the runtime, not the build system.

**QA / staging** — `zbb stack add @zerobias-com/hub@1.2.3` gets an exact versioned environment. Reproducible across machines.

**CI pipeline** — ephemeral slot, packaged stacks, run tests, destroy. No Dockerfile choreography.

## Concepts

### Slot (unchanged)

A slot is an isolated execution context — like Python's venv for infrastructure. It owns shared system resources:

- **Port range** — allocated like DHCP, no conflicts between slots
- **Secrets** — generated per-slot (JWT keys, passwords, encryption keys)
- **State** — logs, config, runtime data, temp files
- **Environment** — all env vars resolved and persisted

Multiple slots can exist. One is active per terminal. Slots persist across sessions.

Everything from the existing `zbb slot` commands works the same way.

### Stack

A stack is a composable unit of functionality within a slot. It has:

- **A manifest** — name, version, dependencies, imports, exports, env declarations
- **On-disk assets** — compose files, scripts, config templates, source code (if dev)
- **Runtime state** — allocated in the slot (ports, secrets, logs, process state)

The key insight: **a stack is a template** (like a Docker image). **A slot instantiates it** (like a Docker container). The same `com/dana/` directory can be in two different slots — each with its own ports, secrets, and database.

### Packaged vs Dev

Stacks have two modes:

**Packaged** — downloaded from a registry. Contains a manifest, compose files, and references to published images. No source code. Used when pulled as a dependency.

```bash
# Automatically pulled when hub declares depends: dana
zbb stack add ./hub    # hub's dana dep resolves to @zerobias-com/dana@^1.2.0
```

**Dev** — pointed at a local directory. Has everything a packaged stack has, plus source code and build lifecycle commands (compile, test, etc.).

```bash
# Explicit local path = dev mode
zbb stack add ./dana
```

Consumers don't know or care which mode a dependency is in. Dana exports the same `DANA_URL` whether it's a packaged Docker image or a from-source build. Hub just imports `dana.DANA_URL` either way.

**[OPEN]** Can you switch a stack from packaged to dev (or vice versa) in place? Or do you remove and re-add?

### Sub-stacks

Stacks can contain sub-stacks. Hub has server, pkg-proxy, and events — each individually startable but sharing Hub's namespace and config.

```bash
zbb start hub              # starts all sub-stacks (and dana if not running)
zbb start hub:server       # starts just server (and dana if not running)
zbb start hub:server hub:pkg-proxy   # starts two sub-stacks
```

Sub-stacks are discovered automatically when a stack is added — like `npm install` resolving the full tree. You don't manually add them.

**[OPEN]** Can sub-stacks have their own exports that differ from the parent? E.g., `hub:server` exports `HUB_SERVER_URL` but `hub:pkg-proxy` exports `HUB_PKG_PROXY_URL`? Or do all exports live at the stack level?

**[OPEN]** Can sub-stacks have intra-stack dependencies? E.g., `hub:events` depends on `hub:server`?

### Dependencies

Stacks declare named dependencies in their manifest:

```yaml
depends:
  dana: "@zerobias-com/dana@^1.2.0"
```

When you add a stack, zbb resolves the dependency tree:

1. Check the slot — is `@zerobias-com/dana` already instantiated?
2. **Yes, compatible version** — bind to it
3. **Yes, incompatible version** — error with clear message
4. **No** — pull the packaged version from registry, instantiate in slot
5. Recurse for transitive dependencies

This is npm install for runtime environments.

### Imports, Exports, and Aliasing

Stacks explicitly declare what they export. Only exported vars are visible to consumers. This is the stack's public API — internal vars are encapsulated.

Dana's manifest:
```yaml
exports: [DANA_URL, DANA_PORT, JWT_PUBLIC_KEY]
```

Hub's manifest:
```yaml
imports:
  dana:
    - DANA_URL                        # → process.env.DANA_URL
    - DANA_PORT                       # → process.env.DANA_PORT
    - JWT_PUBLIC_KEY                  # → process.env.JWT_PUBLIC_KEY
    - DANA_URL as PROXY_URL           # → process.env.PROXY_URL (no DANA_URL)
```

**Rules:**

- **Bare import:** `DANA_URL` → appears as `process.env.DANA_URL` in the consumer's env
- **Aliased import:** `DANA_URL as PROXY_URL` → appears as `process.env.PROXY_URL` only. The original name is NOT also visible.
- **One var per import:** each import creates exactly one env var in the consumer. No duplicates.
- **Collision detection:** if two dependencies export the same name and both are imported bare, `stack add` fails with an error. Must alias one.
- **Explicit exports only:** internal stack vars (not listed in `exports`) are never visible to consumers. This lets stacks refactor internals without breaking consumers.

### Bounds Checking

When a stack resolves a dependency, it verifies:

1. **Identity** — the instance's manifest `name` matches the declared package name
2. **Version** — the instance's version satisfies the semver range
3. **Exports** — the dependency actually exports everything the consumer imports

Fail fast with clear messages. No silent runtime surprises.

## Quick Start

### Working on a Service (Dev)

```bash
# Create a slot
zbb slot create local

# Add your service — deps resolve automatically
zbb stack add ./my-service
#   Resolving dependencies...
#     dana: @zerobias-com/dana@^1.2.0 — pulling packaged
#       postgres: @zerobias-com/postgres@^17.0.0 — pulling packaged
#   Allocating ports...
#   Generating secrets...
#   Done. 3 stacks in slot 'local'.

# Start everything
zbb start my-service
#   Starting postgres... healthy
#   Starting dana... healthy (schema applied, seeded)
#   Starting my-service... healthy

# Your service is running with all deps wired up
curl http://localhost:$MY_SERVICE_PORT/health
```

### Working on Hub (Dev) with Dana as Dependency

```bash
zbb slot create local
zbb stack add ./dana         # dev mode — I want to modify dana too
zbb stack add ./hub          # finds dana already in slot, binds to it
zbb start hub
```

### CI Pipeline

```bash
zbb slot create --ephemeral --ttl 15m
zbb stack add @zerobias-com/hub@2.1.0    # all deps pulled as packages
zbb start hub
npm test
zbb slot delete $(zbb slot current)
```

### Running Two Environments

```bash
# Terminal 1
zbb slot create dev
zbb stack add ./hub
zbb start hub
# hub + dana running on ports 15000-15010

# Terminal 2
zbb slot create qa
zbb stack add @zerobias-com/hub@2.0.0
zbb start hub
# hub + dana running on ports 15100-15110, completely isolated
```

## Stack Manifest

The stack manifest is a YAML file at the root of a stack directory. **[OPEN]** Filename: `zbb-stack.yaml`? `stack.yaml`? Extend existing `zbb.yaml`?

### Example: Dana

```yaml
name: "@zerobias-com/dana"
version: "1.3.0"

# What this stack provides to consumers
exports:
  - DANA_URL
  - DANA_PORT
  - JWT_PUBLIC_KEY
  - PGHOST
  - PGPORT

# Dependencies — pulled if not already in slot
depends:
  postgres: "@zerobias-com/postgres@^17.0.0"

# Import from dependencies
imports:
  postgres: [PGHOST, PGPORT, PGUSER, PGPASSWORD]

# Sub-stacks (individually startable services)
substacks:
  postgres:
    compose: test/docker-compose.yml
    services: [postgres]
  dana:
    compose: test/docker-compose.yml
    services: [dana, nginx]
    depends: [postgres]    # intra-stack ordering

# Environment declarations (same as today's zbb.yaml env block)
env:
  DANA_PORT:
    type: port
  NGINX_HTTP_PORT:
    type: port
  NGINX_HTTPS_PORT:
    type: port
  PGPASSWORD:
    type: secret
    generate: base64:12
  JWT_PRIVATE_KEY:
    type: secret
    generate: rsa:2048
  JWT_PUBLIC_KEY:
    type: secret
    generate: rsa_public:JWT_PRIVATE_KEY
  ENCRYPTION_KEY:
    type: secret
    generate: hex:16
  DANA_URL:
    type: string
    default: "http://localhost:${DANA_PORT}"
  # ... remaining vars

# Tool prerequisites
require:
  - tool: psql
    check: "psql --version"
    parse: "psql \\(PostgreSQL\\) (\\S+)"
    version: ">=14"

# Log sources — declares where `zbb logs` reads from
# Single source: unnamed (zbb logs show dana → just works)
# Multiple sources: named (zbb logs show dana:access)
logs:
  source: docker
  container: "${STACK_NAME}-dana"

# Lifecycle hooks
# [OPEN] Are these shell commands? References to scripts? Gradle tasks?
lifecycle:
  start: ...
  stop: ...
  health: ...
  seed: ...       # post-start data seeding
  build: ...      # dev mode only
  test: ...       # dev mode only
```

### Example: Hub

```yaml
name: "@zerobias-com/hub"
version: "2.1.0"

exports:
  - HUB_SERVER_URL
  - WEBSOCKET_URL
  - HUB_PKG_PROXY_URL

depends:
  dana: "@zerobias-com/dana@^1.2.0"

imports:
  dana: [DANA_URL, DANA_PORT, JWT_PUBLIC_KEY]

substacks:
  server:
    compose: test/docker-compose.hub.yml
    services: [hub-server]
    exports: [HUB_SERVER_URL, WEBSOCKET_URL]
  pkg-proxy:
    compose: test/docker-compose.hub.yml
    services: [hub-pkg-proxy]
    exports: [HUB_PKG_PROXY_URL]
  events:
    compose: test/docker-compose.hub.yml
    services: [hub-events]
    depends: [server]    # intra-stack: events needs server running

env:
  HUB_SERVER_PORT:
    type: port
  HUB_EVENTS_PORT:
    type: port
  HUB_PKG_PROXY_PORT:
    type: port
  HUB_SERVER_URL:
    type: string
    default: "${dana.DANA_URL}/api/hub"
  WEBSOCKET_URL:
    type: string
    default: "ws://localhost:${HUB_SERVER_PORT}"
  # ...

```

### Example: Postgres (Packaged, Leaf Dependency)

```yaml
name: "@zerobias-com/postgres"
version: "17.2.0"

exports:
  - PGHOST
  - PGPORT
  - PGUSER
  - PGPASSWORD
  - PGDATABASE

# No depends — leaf node

env:
  PGHOST:
    type: string
    default: "localhost"
  PGPORT:
    type: port
  PGUSER:
    type: string
    default: "postgres"
  PGPASSWORD:
    type: secret
    generate: base64:12
  PGDATABASE:
    type: string
    default: "zerobias"

substacks:
  postgres:
    image: "postgres:17"
    # [OPEN] Packaged stacks may reference images directly
    # rather than compose files?
```

**[OPEN]** Does postgres even need to be a separate stack, or is it always owned by the stack that needs it (dana owns its postgres)? Making it shared enables the case where dana and another service share the same DB instance. Making it owned is simpler.

## Command Reference

### Stack Management

```bash
# Add a stack from local path (dev mode)
zbb stack add ./dana
zbb stack add ./hub

# Add a stack from registry (packaged mode)
zbb stack add @zerobias-com/dana@^1.2.0

# Add with alias (multi-instance)
zbb stack add ./dana --as dana-2

# List stacks in current slot
zbb stack list
#   NAME              VERSION    MODE       DEPS         STATUS
#   dana              1.3.0-dev  dev        postgres     running
#   hub               2.1.0-dev  dev        dana         stopped
#   postgres          17.2.0     packaged   —            running

# Show stack details
zbb stack info hub
#   Name: @zerobias-com/hub
#   Version: 2.1.0-dev
#   Mode: dev (./hub)
#   Depends: dana (@zerobias-com/dana, satisfied by dana@1.3.0-dev)
#   Exports: HUB_SERVER_URL, WEBSOCKET_URL, HUB_PKG_PROXY_URL
#   Sub-stacks: server, pkg-proxy, events
#   Ports: HUB_SERVER_PORT=15004, HUB_EVENTS_PORT=15005, HUB_PKG_PROXY_PORT=15006

# Remove a stack (reclaims ports, cleans state)
zbb stack remove hub
# [OPEN] What happens to stacks that depend on this one?

# Update a packaged stack to newer version
zbb stack update dana
zbb stack update dana@1.3.0
```

### Lifecycle

```bash
# Start a stack (and its dependencies if not running)
zbb start hub
zbb start hub:server              # just one sub-stack
zbb start hub:server hub:pkg-proxy  # multiple sub-stacks

# Stop a stack (does NOT stop dependencies — others may need them)
zbb stop hub
zbb stop hub:events               # just one sub-stack

# Restart
zbb restart hub
zbb restart hub:server

# Status
zbb status
#   STACK             SUB-STACK    STATUS     PORTS
#   postgres          postgres     running    15000
#   dana              postgres     running    (shared)
#   dana              dana         running    15001
#   dana              nginx        running    15002,15003
#   hub               server       running    15004
#   hub               pkg-proxy    running    15006
#   hub               events       stopped    15005

# Logs (integrates with existing zbb logs)
zbb logs show hub:server --follow
zbb logs show dana --tail 100
```

**[OPEN]** `zbb stop dana` when hub is running — warn? error? force flag? SystemD would refuse unless you also stop hub.

### Lifecycle as Contract

This is a key concept: **the lifecycle is the abstraction boundary between stacks and build systems.**

The stack manifest declares *what* — `build`, `test`, `gate`, `start`, `stop`, `health`. The implementation declares *how* — and that could be Gradle, npm scripts, a Makefile, a shell script, whatever. Consumers never see it.

```yaml
# Dana — Gradle-based TypeScript service
lifecycle:
  build: ./gradlew build
  test: ./gradlew test
  gate: ./gradlew gate
  start: docker compose up -d
  stop: docker compose down
  health: curl -sf http://localhost:${DANA_PORT}/health
  seed: psql -f schema/seed.sql
```

```yaml
# A Python service — completely different tooling, same interface
lifecycle:
  build: pip install -e .
  test: pytest
  start: uvicorn main:app --port ${PORT}
  stop: kill $(cat .pid)
  health: curl -sf http://localhost:${PORT}/health
```

```yaml
# A Go appliance binary — yet another toolchain
lifecycle:
  build: go build -o dist/hub-manager ./cmd/manager
  test: go test ./...
  start: ./dist/hub-manager --port ${PORT}
  health: curl -sf http://localhost:${PORT}/health
```

zbb doesn't care what's behind the lifecycle commands. It runs them, checks the health contract, reports pass/fail. This makes stacks composable across build systems, not just runtime systems.

**Why this matters:**

- **CI becomes stack-agnostic.** `zbb build hub && zbb test hub && zbb gate hub` — the pipeline doesn't know or care that it's Gradle underneath. Swap to a different build system, CI scripts don't change.
- **SDLC pipelines compose.** `zbb gate hub` can run the gate for hub AND validate its deps are healthy. The dependency graph IS the pipeline graph.
- **Health checks are contracts.** A packaged stack promises "I'm healthy when this endpoint returns 200." A dev stack promises the same. Consumers wait for the contract, not the implementation.
- **Module SDLC gets this for free.** A module stack declares `build`, `test`, `gate`, `publish`. The build-tools Gradle plugins become lifecycle implementations behind the stack interface. `zbb build` in a module directory does the right thing without knowing it's Gradle underneath.
- **Gradle is the most common lifecycle provider today, but it's an implementation detail.** The stack interface means any build system can participate.

**[OPEN]** Lifecycle command format: plain shell commands (shown above)? Or structured with working directory, env overrides, timeout?

```yaml
lifecycle:
  build:
    command: ./gradlew build
    cwd: .                    # relative to stack root
    timeout: 300              # seconds
  health:
    command: curl -sf http://localhost:${PORT}/health
    interval: 2               # seconds between retries
    timeout: 120              # total wait time
    retries: 60
```

**[OPEN]** Are lifecycle commands the same for packaged and dev? Packaged stacks probably don't have `build` or `test`. Maybe the manifest has `lifecycle` (always) and `dev_lifecycle` (dev mode only)?

### Dev Lifecycle

Dev stacks (added from a local path) have additional commands:

```bash
# Build the stack's project (delegates to lifecycle.build)
zbb build hub

# Run tests (delegates to lifecycle.test)
zbb test hub

# Full gate (delegates to lifecycle.gate)
zbb gate hub

# Rebuild and restart (common workflow)
zbb build hub && zbb restart hub:server
```

**cwd shorthand:** `cd hub && zbb build` detects the stack from cwd — same as `zbb build hub` from anywhere.

## Logs

Logs are a stack-level concern. Each stack (or sub-stack) declares its log sources in the manifest. `zbb logs` reads the declaration and routes to the right backend.

### Declaration

A stack with one log source doesn't need to name it:

```yaml
# Single source — `zbb logs show dana` just works
logs:
  source: docker
  container: "${STACK_NAME}-dana"
```

A stack with multiple sources names them:

```yaml
# Multiple sources — `zbb logs show myservice:app` or `zbb logs show myservice:access`
logs:
  app:
    source: docker
    container: "${STACK_NAME}-myservice"
  access:
    source: file
    path: "${ZB_SLOT_LOGS}/myservice-access.log"
  cloudwatch:
    source: aws
    log_group: "${AWS_LOG_GROUP}"
```

Sub-stacks declare their own logs. The parent doesn't know or care where its children's logs come from.

### Supported sources

| Source | Backend | Example |
|--------|---------|---------|
| `docker` | `docker logs <container>` | Container stdout/stderr |
| `file` | `tail` / file read | Log file on disk |
| `aws` | `aws logs tail` | CloudWatch log group |

**[OPEN]** Other sources to consider: journald, k8s pod logs, custom command.

### Commands

```bash
# List all log sources across all stacks in slot
zbb logs list
#   STACK       SOURCE     NAME        TYPE      STATUS
#   postgres    postgres   (default)   docker    running
#   dana        dana       (default)   docker    running
#   hub:server  server     (default)   docker    running
#   hub:node    node       app         file      12K, 3m ago
#   hub:node    node       cloudwatch  aws       —

# Show logs — routes to declared backend
zbb logs show dana                     # single source, no name needed
zbb logs show hub:server               # sub-stack, single source
zbb logs show hub:node:app             # sub-stack, named source
zbb logs show hub:node:cloudwatch      # different backend, same interface

# Tail and follow work across all backends
zbb logs show dana --tail 100
zbb logs show dana --follow
```

The stack manifest is the routing table. `zbb logs` is just a CLI that reads it and dispatches.

## Environment: Three-Layer Model

Today's env system tangles schema, values, and provenance. With stacks, these are cleanly separated into three layers per stack:

### Layer 1: Schema (in `zbb.yaml` — the stack manifest)

What vars exist, their types, formulas, descriptions. This is the declaration — checked into source control, part of the stack's public contract.

```yaml
# zbb.yaml (stack manifest)
env:
  DANA_PORT:
    type: port
    description: Dana API host port
  DANA_URL:
    type: string
    description: Dana API gateway URL
    value: "http://localhost:${DANA_PORT}"    # formula — always derived
  PGPASSWORD:
    type: secret
    generate: base64:12
  NPM_TOKEN:
    type: string
    source: env
    required: true
    mask: true
```

### Layer 2: Manifest (per-stack, in slot — the provenance)

How each var got its value. This is the **source of truth** — every var has a resolution record. Changing the manifest recalculates the `.env`.

```yaml
# ~/.zbb/slots/local/stacks/dana/manifest.yaml
DANA_PORT:
  resolution: allocated
  value: 15001
  source: com/dana/zbb.yaml

DANA_URL:
  resolution: derived
  formula: "http://localhost:${DANA_PORT}"
  inputs: { DANA_PORT: 15001 }
  # value computed from formula — not stored here

SERVER_URL:
  resolution: override
  value: "https://custom.example.com"
  set_by: user
  set_at: 2026-04-01T10:00:00Z
  default_formula: "http://localhost:${DANA_PORT}"

NPM_TOKEN:
  resolution: inherited
  source: env

JWT_PRIVATE_KEY:
  resolution: generated
  generator: rsa:2048

HUB_SERVER_URL:
  resolution: imported
  from: dana
  original_name: DANA_URL
  alias: null              # or "PROXY_URL" if aliased
```

### Layer 3: `.env` (per-stack, in slot — the computed output)

Plain key=value. The final resolved state. **Never edited directly** — always derived from the manifest. This is what lifecycle commands and the shell see.

```
# ~/.zbb/slots/local/stacks/dana/.env
DANA_PORT=15001
DANA_URL=http://localhost:15001
SERVER_URL=https://custom.example.com
NPM_TOKEN=ghp_abc123
JWT_PRIVATE_KEY=LS0tLS1CRUdJTi...
```

### Flow

```
Schema (zbb.yaml)  →  declares what vars exist + formulas
                          ↓
                    zbb stack add / zbb env set
                          ↓
Manifest            →  records how each var was resolved
                          ↓
                    recalculate (topo-sorted formula evaluation)
                          ↓
.env                →  computed output (cache, never edited)
```

**`zbb env set FOO bar`** writes to the manifest as `resolution: override`. Then `.env` is recalculated. No separate `overrides.env` — the manifest is the single source of truth.

**If an input changes** (e.g., `DANA_PORT` gets reallocated), all vars with formulas referencing it are recomputed in `.env`. The manifest records the formula, not the frozen value.

**Resolution precedence:**
1. Override (user set via `zbb env set`)
2. Imported (from dependency stack)
3. Inherited (from parent shell, `source: env`)
4. Generated (secrets, `generate: rsa:2048`)
5. Allocated (ports)
6. Derived (formula from `value:` field)
7. Default (literal from `default:` field — computed once, frozen)

### DX: `zbb env explain`

The manifest powers full introspection:

```bash
zbb env explain DANA_URL
#   Name:        DANA_URL
#   Type:        string (from @zerobias-com/dana)
#   Description: Dana API gateway URL
#   Resolution:  derived
#   Formula:     http://localhost:${DANA_PORT}
#   Inputs:      DANA_PORT = 15001 (allocated)
#   Current:     http://localhost:15001
#   Overridable: yes

zbb env explain SERVER_URL
#   Name:        SERVER_URL
#   Resolution:  override (user)
#   Current:     https://custom.example.com
#   Formula:     http://localhost:${DANA_PORT}
#   Set by:      zbb env set (2026-04-01)

zbb env explain NPM_TOKEN
#   Name:        NPM_TOKEN
#   Resolution:  inherited (parent shell)
#   Current:     ***
#   Required:    yes
```

No more "where did this value come from?" The manifest answers every question. A TUI, web UI, AI agent, or `yq` one-liner can access the same data.

### Distinction: `value` vs `default`

```yaml
env:
  DANA_URL:
    value: "http://localhost:${DANA_PORT}"     # formula — recomputes when DANA_PORT changes

  CUSTOM_SETTING:
    default: "http://localhost:${DANA_PORT}"   # default — computed once at stack add, then frozen
```

`value` = live derivation (always tracks inputs). `default` = initial value (snapshot). Override wins over both.

## Slot Directory Structure (with Stacks)

```
~/.zbb/slots/local/
  slot.yaml                    # slot metadata (portRange, created, ephemeral)

  stacks/                      # per-stack runtime state
    dana/
      stack.yaml               # resolved identity (name, version, mode, source path)
      manifest.yaml            # Layer 2: provenance — source of truth for all vars
      .env                     # Layer 3: computed output — never edited directly
      state.yaml               # runtime state (status, schema_applied, etc.)
      logs/                    # dana's log files
      state/                   # dana's runtime state
        secrets/               # connection profiles
    hub/
      stack.yaml
      manifest.yaml
      .env
      state.yaml
      logs/
      state/
    postgres/
      stack.yaml
      manifest.yaml
      .env
      state.yaml

  config/                      # slot-level shared config
  logs/                        # slot-level logs (cross-cutting)
  state/                       # slot-level state (cross-cutting)
```

## Distribution

Packaged stacks are published to npm registries (GitHub Packages, verdaccio).

**[OPEN]** What's in the package?

Likely:
- Stack manifest (`zbb-stack.yaml` or equivalent)
- Docker compose files
- Config templates
- Image references (e.g., `ghcr.io/zerobias-com/dana-app:1.3.0`)

NOT:
- Source code
- Build artifacts
- Node modules

**[OPEN]** Is it literally an npm package (`npm publish`)? Or a new artifact type distributed via npm registry? An npm package is convenient — `package.json` already has name, version, dependencies. But a stack isn't a JS library. It's closer to a Helm chart.

**[OPEN]** Could the `package.json` and stack manifest be the same file? Stack metadata as fields in package.json (like `bin`, `exports`, etc.)?

**[OPEN]** Versioning: does a stack's version come from `package.json` (like today's zbb.yaml reads version from package.json)? Or from the stack manifest?

## Migration from Current zbb.yaml

Today's `zbb.yaml` files declare env vars and stack config in a flat namespace. The migration path:

**[OPEN]** Several options:

1. **Stack manifest replaces zbb.yaml** — new format, clean break
2. **Stack manifest extends zbb.yaml** — add `exports`, `imports`, `depends` fields to existing format
3. **Stack manifest is separate** — `zbb-stack.yaml` alongside `zbb.yaml`, zbb.yaml continues to work for projects that don't use stacks

Option 3 feels right for incremental adoption. Existing projects keep working. New projects can opt into stacks.

**[OPEN]** Can a project be both a "legacy" zbb.yaml project (flat env, no stacks) and participate in a stack-based slot? The slot would need to bridge the two models.

## Shell Environment Model

### Three Layers

The shell env is scoped by context:

| Context | What's visible |
|---------|----------------|
| **In slot, no stack** | Slot vars only (`ZB_SLOT`, `ZB_SLOT_DIR`, etc.) |
| **In slot + stack** | Slot vars + stack's own vars + stack's resolved imports |
| **Different stack** | Slot vars + that stack's vars + that stack's imports |

Stacks never see each other's internal vars. Dana's `LOG_LEVEL` and Hub's `LOG_LEVEL` don't collide — they're only visible when you're in that stack's context. Lifecycle commands (`zbb start hub`) build their env from the resolved stack state on disk, not from the current shell env.

### cd Hook (direnv-like)

Inside a slot subshell, a `cd` hook automatically scopes the env to the current stack:

1. `cd` fires the hook
2. Hook walks up the directory tree looking for a stack manifest (like `findRepoRoot` today)
3. Found → knows which stack. Combines `ZB_SLOT` to locate resolved state: `~/.zbb/slots/$ZB_SLOT/stacks/$STACK/.env`
4. Sources the `.env` (diffs current env, exports new vars, unsets vars from the previous stack)

No pre-computed directory map needed. The manifest file IS the marker. `ZB_SLOT` IS the pointer to resolved state. Walking a few directories is fast.

```bash
# Automatic — env changes as you move between stacks
[zb:local]:~$ cd com/dana
# hook fires → loads dana's env
[zb:local]:~/com/dana$ echo $DANA_PORT
15001

[zb:local]:~/com/dana$ cd ../hub
# hook fires → unsets dana's internal vars, loads hub's env
[zb:local]:~/com/hub$ echo $HUB_SERVER_PORT
15004
```

### Shell Function

`zbb` in the interactive shell is a **shell function** wrapping the binary (same pattern as nvm). This enables `zbb env set` to modify the current shell env:

```bash
# Installed into the subshell during `zbb slot load`
zbb() {
  command zbb "$@"
  local rc=$?
  # Re-source env after commands that change it
  case "$1" in
    env) _zbb_reload_env ;;
  esac
  return $rc
}
```

Without this, `zbb env set FOO bar` writes to disk but the shell env is stale until the next `cd` triggers the hook.

**Who sees what:**

| Consumer | Calls | Env sync |
|----------|-------|----------|
| **Interactive shell** | Shell function | Yes — `cd` hook + function re-source |
| **Scripts, CI** | Binary directly (`command zbb`, `/usr/bin/zbb`) | No — builds env from disk via `--slot`/`--stack` flags |
| **Gradle, node child_process** | Binary directly | No — reads slot state from disk |
| **AI agents** | Binary with `--slot`/`--stack` | No — self-contained |

The shell function is only the interactive DX wrapper. Everything non-interactive uses the binary directly and is unaffected.

### Risks

**Script portability.** A bash script that calls `zbb env set` won't update its own env — it's calling the binary, not the function. This is the same behavior as nvm (`nvm use 22` in a script doesn't affect the parent shell). It's a well-understood pattern, but could surprise users who don't know the difference. Mitigation: `zbb env set` in non-interactive mode could print a warning: "Note: env updated on disk. Interactive shell will pick this up on next cd."

**Hook performance.** The `cd` hook runs on every directory change. Walking up for a manifest file should be fast (<1ms), but if the `.env` source is slow (large file, slow disk), it could feel laggy. Mitigation: keep stack `.env` files small; the hook is a file read, not a resolution step — resolution happened at `stack add` time.

**Nested subshells.** If someone runs `zbb slot load` inside an existing slot subshell, they get nested subshells. Today this is already possible and confusing. Stacks don't make it worse, but don't fix it either. Mitigation: detect and warn.

**PROMPT_COMMAND conflicts.** The `cd` hook likely uses `PROMPT_COMMAND` or a `chpwd`-style trap. Other tools (starship, direnv itself, etc.) also use these. Mitigation: append to `PROMPT_COMMAND` rather than replacing it; check for conflicts at `slot load` time.

### Non-Interactive Usage

Scripts, CI, and tooling don't need the shell function or hook. They use flags:

```bash
# CI — all env resolved from disk, no shell state needed
zbb --slot ci --stack hub start
zbb --slot ci --stack hub test

# Gradle — reads ZB_SLOT from env, builds its own env from disk
./gradlew stackUp    # slot env already in shell from zbb slot load

# Node.js — programmatic API
import { SlotManager } from '@zerobias-org/zbb';
const slot = await SlotManager.load('local');
const env = slot.stacks.get('hub').env.getAll();
```

## State Model

### Two Layers: Schema (manifest) and Instance (file)

Each stack declares a **state schema** in its manifest — the shape of state it publishes. This is the contract. Other stacks, tools, and scripts can discover what state exists and what values are valid.

```yaml
# In zbb.yaml (stack manifest) — the interface
state:
  status:
    type: enum
    values: [starting, healthy, degraded, stopped, error]
  schema_applied:
    type: boolean
  seeded:
    type: boolean
  endpoints:
    api: { type: url }
    health: { type: url }
```

The **state file** is the instance — plain YAML on disk in the slot, updated at runtime by lifecycle commands.

```yaml
# ~/.zbb/slots/local/stacks/dana/state.yaml — the instance
status: healthy
schema_applied: true
seeded: true
endpoints:
  api: http://localhost:15001
  health: http://localhost:15001/health
```

Like an OpenAPI spec (interface) vs an HTTP response (instance). The manifest says "dana publishes state with this shape." The file holds the current values.

### Why This Matters

**Dependency conditions can reference state, not just "running":**

```yaml
depends:
  dana:
    package: "@zerobias-com/dana@^1.2.0"
    ready_when:
      status: healthy
      schema_applied: true
```

Hub doesn't start until dana's state file satisfies those conditions. zbb watches the file (same filesystem-as-IPC pattern that node-lib uses today) and starts hub when conditions are met.

**`zbb status` reads state files — no docker ps, no health polling:**

```bash
zbb status
#   STACK       STATUS     SCHEMA   SEEDED   ENDPOINTS
#   postgres    healthy    —        —        localhost:15000
#   dana        healthy    true     true     localhost:15001
#   hub         starting   —        —        —
```

### Design Principles

**The file IS the interface.** No SDK, no typed accessors, no library required. Any tool can participate:

```bash
# Bash
yq '.status' ~/.zbb/slots/local/stacks/dana/state.yaml

# Python
import yaml
state = yaml.safe_load(open(state_path))
if state['schema_applied']: ...

# AI agent
# Just read the file. The manifest tells you what keys to expect.

# CI
while [ "$(yq '.status' dana/state.yaml)" != "healthy" ]; do sleep 1; done
```

**The manifest is discoverable metadata.** Tools can introspect what state a stack publishes without running it. CI pipelines can validate that dependency conditions are satisfiable. Linters can check that `ready_when` references valid state keys.

**Lifecycle commands update state.** The `start` lifecycle command is responsible for updating `state.yaml` as it progresses (status: starting → healthy, schema_applied: false → true). zbb can wrap this — run the command, validate the state file matches the schema afterward.

**File watcher for change detection.** Same pattern as node-lib's SlotWatcher — inotify/fs.watch on the state file, debounced, event-driven. No polling. When dana's state changes, zbb evaluates whether hub's `ready_when` conditions are now satisfied.

### Lessons from node-lib

Hub's node-lib has a sophisticated state system (SlotState, DeploymentManager, CommandManager) with typed accessors, exclusive-writer patterns, and Joi validation. It works well for its dedicated consumers (node, cli, manager).

But AI agents and scripts consistently bypass it — the typed accessor API is too heavy. For stacks, the state model must be lighter:

| node-lib pattern | stack equivalent |
|-----------------|------------------|
| Typed accessors (`getStatus()`) | Plain YAML read (`yq '.status'`) |
| SDK import required | No import — file IS the interface |
| Joi validation on write | Schema in manifest, validated by zbb optionally |
| Exclusive writer | **[OPEN]** Any process can write? Or still exclusive? |
| EventEmitter API | File watcher — any tool can watch |

**[OPEN]** Should state writes be exclusive (one owner per state file) or open? Exclusive prevents races but requires coordination. Open is simpler but risks conflicting writes. Could have a `state.owner` field in the manifest that declares which process/lifecycle command owns writes.

**[OPEN]** Should zbb validate state writes against the schema? Always, optionally, or never? Strict validation catches bugs but adds friction. No validation is simpler but allows drift.

**[OPEN]** State history/transitions — does the state file only hold current state, or also a log of transitions? Current-only is simpler. A transition log enables debugging ("when did dana go unhealthy?"). Could be a separate `state-log.yaml` or just rely on filesystem mtime + logs.

## Secrets and Testing

### How It Works Today

Hub modules use `describeModule()` from `module-test-client` to run the same test suite against multiple targets. The test client auto-discovers secrets matching the module's `_module` key via `zbb secret list --module <key>`. Each secret represents a different target system (postgres, mysql, SQL Server for the SQL module; different GitHub orgs for the GitHub module).

```typescript
// One test, adapts to whatever secrets exist in the slot
describeModule<Sql>('SQL Module', (client) => {
  it('should get root object', async () => {
    const root = await client.getObjectsApi().getObject('/');
    expect(root).to.be.ok;
  });
});
```

If the slot has 3 secrets for this module, the test runs 3 times — once per target. CI sets up different secrets than local dev. Tests don't know or care.

### With Stacks

If every module is a stack, the test workflow becomes:

```bash
# Add the module stack — deps (Dana, Hub, Postgres) resolve automatically
zbb stack add ./my-module

# Create secrets for test targets
zbb secret create postgres-local host=localhost port=${PGPORT} ...
zbb secret create mysql-ci host=mysql.ci.internal ...

# Run tests — discovers all matching secrets, runs against each
zbb test my-module
```

**Isolation via stack lifecycle:**

```bash
# Create stack (allocates ports, pulls deps, generates secrets)
zbb stack add ./sql-module

# Test against all configured targets
zbb test sql-module

# Clean up — removes JUST THIS STACK
zbb stack remove sql-module
```

`stack remove` calls cleanup hooks declared in the manifest:

```yaml
lifecycle:
  cleanup:
    - docker compose down -v           # remove containers + volumes
    - rm -rf ${ZB_SLOT_LOGS}/sql-*     # remove log files
    - rm -rf ${ZB_SLOT_STATE}/sql-*    # remove test fixtures
```

Dependencies (Dana, Hub) stay running if other stacks need them. Only the module's own resources are cleaned up.

### CI Pipeline

```bash
# Ephemeral slot — isolated, auto-cleaned
zbb slot create --ephemeral --ttl 15m

# Add module — deps pulled as packaged stacks
zbb stack add @auditlogic/module-sql@6.8.0

# CI creates its own secrets (different targets than dev)
zbb secret create pg-ci host=$CI_PG_HOST user=$CI_PG_USER ...
zbb secret create mssql-ci host=$CI_MSSQL_HOST user=$CI_MSSQL_USER ...

# Same test command — adapts to whatever secrets exist
zbb test module-sql

# Ephemeral slot auto-cleans after TTL
```

The secret inventory IS the test matrix. Add a secret, get a test run. Remove a secret, skip that target. No test code changes.

### Secrets as Stack-Level Resources

Secrets declared in the stack manifest become part of the stack contract:

```yaml
# In zbb.yaml
secrets:
  connection_profile:
    schema: connectionProfile.yml     # validates secret shape
    required_for: [testDirect, testDocker, testHub]
    discovery: auto                    # zbb secret list --module <key>
```

**[OPEN]** Should the stack manifest declare a secret schema so `zbb secret create` can validate? Today `--type @connectionProfile.yml` does this optionally. With stacks, the manifest could make it automatic — every secret for this module must match the connection profile schema.

**[OPEN]** Should `zbb stack add` auto-create template secrets (with empty values) based on the schema? This would make the "what credentials do I need?" question self-documenting.

## SystemD-like Properties

Stacks with dependencies behave like SystemD units:

- **Dependency ordering** — `zbb start hub` starts postgres, then dana, then hub (respecting `depends`)
- **State-based readiness** — dependencies must satisfy `ready_when` conditions, not just "running"
- **Stop ordering** — reverse of start (hub stops before dana stops before postgres)
- **File-based observation** — state changes propagate via filesystem watches, not polling

**[OPEN]** Additional SystemD-like features to consider:
- **Restart policies** — auto-restart on crash? Probably not for dev, maybe for packaged.
- **Timeout** — how long to wait for `ready_when` before failing
- **Conflict declarations** — "this stack cannot coexist with X" (probably not needed)

## Open Questions Summary

### Resolved

These were discussed and decided:

| Question | Decision |
|----------|----------|
| Namespace mechanics | Bare imports (`DANA_URL` → `process.env.DANA_URL`). `as` for aliasing. Each import creates exactly one var. |
| Explicit vs implicit exports | Explicit only. Internal vars are encapsulated. |
| Collision handling | Two deps export same name, both imported bare → error at `stack add`. Must alias one. |
| Shell env scoping | Three layers: slot → stack + imports. Scoped by cwd. No flat merge of all stacks. |
| Shell sync mechanism | cd hook (direnv-like) + shell function wrapping binary. Non-interactive uses binary directly. |
| Activation model | cd hook inside slot subshell. No separate "stack enter" subshell. `--slot`/`--stack` flags for non-interactive. |
| Sub-stack exports | Yes, sub-stacks can have their own exports. Parent stack's exports is the union. |
| Intra-stack deps | Yes, for start ordering within a stack. |
| Lifecycle as contract | Manifest declares what (build, test, start, health). Implementation is shell commands. Build system is impl detail. |
| Lifecycle env | Commands build their own env from resolved stack state on disk, not from current shell. |
| Env three-layer model | Schema (zbb.yaml) → Manifest (provenance, source of truth) → .env (computed output). Manifest change recalculates .env. No separate overrides.env. |
| Flat slot .env | Replaced by per-stack .env. Shell env scoped by cd hook. |
| `value` vs `default` | `value` = live formula (recomputes). `default` = initial value (frozen). Override wins over both. |
| Resolver functions | Should become declared formulas in manifest. Code-only resolvers are invisible and cause problems. |
| Entering a stack | Not a separate subshell. You enter a slot (subshell), then cd hook scopes env to whichever stack you're in. |

### Still Open

#### Naming & Format
- Stack manifest: extend existing `zbb.yaml` with new fields? Or separate file?
- Package format: npm tarball? Infrastructure exists but stacks aren't JS libraries.
- Version source: `package.json` (single source of truth, like today)?
- Could `package.json` and stack manifest merge, or keep separate concerns?

#### Lifecycle Details
- Command format: plain shell strings for most, structured for health checks? Or structured everywhere?
- Packaged stacks omit `build`/`test` — implicit (just don't declare them) or explicit (`mode` field)?
- Stop with dependents running: warn + `--force`? `--cascade` flag for reverse-order shutdown?
- Restart policies for packaged stacks: defer to later?

#### Composition
- Postgres: shared leaf stack or always owned by consumer?
- Packaged → dev switch in place (keep ports/secrets/state) or remove + re-add?

#### State & Env
- State writes: exclusive owner per file, or any process can write?
- State schema validation on write: always, optional, or never?
- State history: current-only, or transition log for debugging?
- Complex transforms (protocol swap `http→ws`): declared formula syntax, or keep as registered functions referenced in manifest?
- Resolution precedence: is the 7-level priority order right, or does it need adjustment?

#### Migration
- Incremental adoption path for existing `zbb.yaml` projects?
- Legacy flat-env projects coexisting with stack-based projects in same slot?

#### Distribution
- What exactly goes in a packaged stack tarball?
- Simple stacks (postgres) reference images directly without compose files?

#### Shell Risks (documented, not blocking)
- Script portability: `zbb env set` in scripts calls binary, not function — env not updated in calling script
- Hook performance at scale
- PROMPT_COMMAND conflicts with starship, direnv, etc.
- Nested subshell detection
