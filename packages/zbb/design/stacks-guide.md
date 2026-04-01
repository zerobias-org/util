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

### Namespaced Imports/Exports

Stacks export named values. Consumers import them by dependency name.

Dana's manifest:
```yaml
exports: [DANA_URL, DANA_PORT, JWT_PUBLIC_KEY]
```

Hub's manifest:
```yaml
imports:
  dana: [DANA_URL, DANA_PORT, JWT_PUBLIC_KEY]
```

Inside Hub's environment, imported values are available. **[OPEN]** As `DANA_URL` (bare, from the import declaration)? As `dana.DANA_URL` (namespaced)? Both? The ergonomics matter here — existing code reads `process.env.DANA_URL`, not `process.env.dana.DANA_URL`.

**[OPEN]** Are all stack env vars implicitly available under the namespace, or only explicitly declared exports? Explicit is cleaner but more work to maintain. Implicit is convenient but leaky.

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

### Dev Lifecycle

Dev stacks (added from a local path) have additional commands:

```bash
# Build the stack's project
zbb build hub
# [OPEN] Delegates to what? Gradle? npm? Detected from project?

# Run tests
zbb test hub

# Rebuild and restart (common workflow)
zbb build hub && zbb restart hub:server
```

**[OPEN]** Does `zbb build` replace `zbb compile` / `zbb gate` / Gradle invocation? Or is it a higher-level command that calls the right build system for the stack?

## Slot Directory Structure (with Stacks)

```
~/.zbb/slots/local/
  slot.yaml                    # slot metadata (unchanged)
  .env                         # [OPEN] flat slot-level env? or removed in favor of per-stack?
  manifest.yaml                # [OPEN] still global? or per-stack?
  overrides.env                # user overrides (unchanged)

  stacks/                      # NEW — per-stack runtime state
    dana/
      stack.yaml               # resolved manifest (exact version, mode, source path)
      .env                     # dana's allocated env vars
      manifest.yaml            # dana's var provenance
      logs/                    # dana's log files
      state/                   # dana's runtime state
        secrets/               # dana's connection profiles
    hub/
      stack.yaml
      .env
      manifest.yaml
      logs/
      state/
    postgres/
      stack.yaml
      .env
      ...

  config/                      # shared config (unchanged)
  logs/                        # [OPEN] keep slot-level logs? or only per-stack?
  state/                       # [OPEN] keep slot-level state? or only per-stack?
```

**[OPEN]** Big question: does the flat `.env` at slot root survive? Today every var from every project is merged into one file. With stacks, each stack could own its own `.env`. But then how do cross-stack references resolve? Options:

- **Merged `.env` still exists** — assembled from all stack `.env` files + imports. This is what the shell sees.
- **No merged file** — each stack's env is isolated, imports are resolved at start time.
- **Both** — stacks own their vars, slot assembles a merged view for the shell.

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

## Auto-activation

**[OPEN]** The `cd`-based auto-activation is mentioned in the design but needs fleshing out.

Options:
- **direnv integration** — `.envrc` files that call `zbb stack enter <name>`
- **Shell hook** — zbb registers a `cd` hook (like nvm's auto-use)
- **Explicit only** — `zbb stack enter hub` / `--stack hub` flag, no magic

Explicit is simplest and most predictable. direnv is battle-tested. Shell hook is fragile.

**[OPEN]** What does "entering" a stack mean exactly? Today `zbb slot load` spawns a subshell. Does `zbb stack enter` also spawn a subshell? Or just update the current shell's env? If it's just env updates, how do you "leave" a stack?

## SystemD-like Properties

Stacks with dependencies behave like SystemD units:

- **Dependency ordering** — `zbb start hub` starts postgres, then dana, then hub (respecting `depends`)
- **Health checks** — each stack/sub-stack declares a health check; dependencies must be healthy before dependents start
- **Stop ordering** — reverse of start (hub stops before dana stops before postgres)

**[OPEN]** Additional SystemD-like features to consider:
- **Restart policies** — auto-restart on crash? Probably not for dev, maybe for packaged.
- **Readiness vs liveness** — "started" vs "ready to accept connections"
- **Timeout** — how long to wait for health before failing
- **Conflict declarations** — "this stack cannot coexist with X" (probably not needed)

## Open Questions Summary

Collected from throughout this document:

### Naming & Format
- Stack manifest filename: `zbb-stack.yaml`? `stack.yaml`? Extend `zbb.yaml`?
- Package format: npm tarball? New artifact type?
- Version source: package.json? Stack manifest?

### Namespace Mechanics
- How do imported vars appear in the consumer's env? Bare (`DANA_URL`)? Qualified (`dana.DANA_URL`)? Both?
- Are exports explicit only, or all env vars under namespace?

### Composition
- Can sub-stacks have their own exports?
- Can sub-stacks have intra-stack dependencies?
- Is postgres a shared stack or owned by its consumer?

### Lifecycle
- What does `zbb build` delegate to?
- What happens when you stop a stack that others depend on?
- Switch from packaged to dev in place, or remove + re-add?
- Restart policies for packaged stacks?

### State & Env
- Does the flat slot-level `.env` survive, or only per-stack `.env`?
- Where do cross-stack references resolve?
- Slot-level vs stack-level logs and state directories?

### Migration
- How do existing zbb.yaml projects coexist with stacks?
- Can a project participate in both models?

### Activation
- direnv? Shell hook? Explicit only?
- What does "entering" a stack mean for the shell?

### Distribution
- What exactly goes in a packaged stack?
- npm publish or custom artifact?
- Can package.json and stack manifest merge?
