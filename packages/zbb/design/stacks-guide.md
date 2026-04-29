# zbb Stacks — User Guide

> **Status:** Implemented. See `CLAUDE.md` for development guide.

Stacks are composable units of infrastructure that live inside zbb slots. They turn "clone repo, read wiki, set 20 env vars, pray" into `zbb stack add ./my-service && zbb stack start my-service`.

## Why

Today, "Hub needs Dana needs Postgres" lives in tribal knowledge and Gradle task wiring. Standing up a REST service + SQL locally or in CI is hard. With stacks:

```bash
zbb slot create local
zbb stack add ./my-service     # deps resolve automatically
zbb stack start my-service     # postgres → dana → my-service, health-checked
```

CI is the same commands with an ephemeral slot. The gap between "I have source code" and "I have a running environment" collapses to dependency resolution.

**Who benefits:**

- **Developer** — `zbb stack add ./hub` pulls Dana + Postgres. Write code, not infra scripts.
- **Platform team** — publish a stack once. Every consumer gets a working Dana without cloning the repo.
- **CI pipeline** — ephemeral slot, packaged stacks, run tests, destroy. Same commands as local.
- **QA** — `zbb stack add @zerobias-com/hub@1.2.3` gets an exact versioned environment.
- **Appliance** — thin base that pulls packaged stacks. Ship the runtime, not the build system.

## Concepts

### Slots and Stacks

**Slot** = execution context (like venv). Owns shared system resources: port ranges (allocated like DHCP), secrets, state. Central storage (`~/.zbb/slots/`). Multiple slots exist; one active per terminal. Unchanged from today.

**Stack** = composable unit of functionality within a slot. Has a manifest (name, version, deps, imports, exports, env, lifecycle, state, logs, secrets). The key insight: **stack = template** (like a Docker image), **slot = instance** (like a Docker container). Same `com/dana/` directory in two slots → different ports, secrets, DBs.

### Packaged vs Dev

**Dev** — local directory with source code: `zbb stack add ./dana`
**Packaged** — downloaded from registry (npm): auto-resolved as dependency

Consumers don't care which mode. Dana exports the same `DANA_URL` either way.

### Sub-stacks

Stacks contain sub-stacks. Hub has server, pkg-proxy, events — individually startable:

```bash
zbb stack start hub              # all sub-stacks + deps
zbb stack start hub:server       # just server + deps
```

Sub-stacks discovered automatically on `stack add`. They declare their own exports, logs, and intra-stack dependencies.

### Dependencies and Resolution

```yaml
depends:
  dana: "@zerobias-com/dana@^1.2.0"
```

`zbb stack add ./hub` checks the slot for dana. Found + compatible → bind. Not found → pull packaged version. Recurse for transitive deps. Like `npm install` for runtime environments.

**Bounds checking:** identity (name matches), version (semver range), exports (consumer's imports are satisfied). Fail fast.

### Imports, Exports, Aliasing

Stacks explicitly declare exports (public API). Consumers import by dependency name:

```yaml
# Dana exports
exports: [DANA_URL, DANA_PORT, JWT_PUBLIC_KEY]

# Hub imports
imports:
  dana:
    - DANA_URL                     # → process.env.DANA_URL
    - DANA_URL as PROXY_URL        # → process.env.PROXY_URL (no DANA_URL)
```

Rules:
- Bare import → same name in consumer's env
- Aliased import → only the alias appears. One var per import.
- Two deps export same name, both imported bare → error at `stack add`. Must alias one.
- Internal (non-exported) vars are encapsulated — invisible to consumers.

## Quick Start

### Dev Workflow

```bash
# 1. Create and enter a slot
zbb slot create local
zbb slot load local
[zb:local]:~/zerobias$

# 2. Add stacks (resolves deps, allocates ports, generates secrets)
zbb stack add ./dana              # dev mode — you have source
zbb stack add ./hub               # finds dana already in slot, binds

# 3. Start
zbb start hub                     # starts postgres → dana → hub, health-checked

# 4. Work — cd hook scopes env to current stack
cd com/hub
[zb:local]:~/zerobias/com/hub$ echo $HUB_SERVER_PORT
15004

cd ../dana
[zb:local]:~/zerobias/com/dana$ echo $DANA_PORT
15001
```

If you're already in a loaded slot, `stack add` resolves and writes state to the slot. The cd hook picks up the stack env on your next directory change. `stack add` does NOT start anything — that's `zbb start`.

### CI Workflow

```bash
zbb slot create --ephemeral --ttl 15m
zbb slot load ci-run
zbb stack add @zerobias-com/hub@2.1.0    # packaged deps auto-resolved
zbb start hub && zbb test hub
```

### Without a Subshell

```bash
# Non-interactive — slot and stack as flags, no subshell needed
zbb --slot local --stack hub start
zbb --slot local --stack hub test
```

`cd hub && zbb start` and `zbb start hub` are equivalent — cwd detection or explicit name.

## Stack Manifest

The manifest is in `zbb.yaml` (extends current format with new fields). A `zbb.yaml` without stack fields works exactly like today.

```yaml
name: "@zerobias-com/dana"
version: "1.3.0"

depends:
  postgres: "@zerobias-com/postgres@^17.0.0"

exports: [DANA_URL, DANA_PORT, JWT_PUBLIC_KEY]

imports:
  postgres: [PGHOST, PGPORT, PGUSER, PGPASSWORD]

substacks:
  postgres:
    compose: test/docker-compose.yml
    services: [postgres]
  dana:
    compose: test/docker-compose.yml
    services: [dana, nginx]
    depends: [postgres]

env:
  DANA_PORT:
    type: port
  DANA_URL:
    type: string
    value: "http://localhost:${DANA_PORT}"
  JWT_PRIVATE_KEY:
    type: secret
    generate: rsa:2048
  # ...

state:
  status:
    type: enum
    values: [starting, healthy, degraded, stopped, error]
  schema_applied: { type: boolean }
  seeded: { type: boolean }
  endpoints:
    api: { type: url }

logs:
  source: docker
  container: "${ZB_SLOT}-dana"

secrets:
  connection_profile:
    schema: connectionProfile.yml
    discovery: auto

lifecycle:
  build: ./gradlew build
  test: ./gradlew test
  gate: ./gradlew gate
  start: docker compose up -d
  stop: docker compose down
  health:
    command: curl -sf http://localhost:${DANA_PORT}/health
    interval: 2
    timeout: 120
  seed: psql -f schema/seed.sql
  cleanup:
    - docker compose down -v
    - rm -rf ${ZB_SLOT_LOGS}/dana-*

require:
  - tool: psql
    check: "psql --version"
    parse: "psql \\(PostgreSQL\\) (\\S+)"
    version: ">=14"
```

## Command Reference

```bash
# Stack management
zbb stack add ./dana                      # dev mode (local path)
zbb stack add @zerobias-com/dana@^1.2.0   # packaged (registry)
zbb stack add ./dana --as dana-2          # multi-instance alias
zbb stack list                            # stacks in current slot
zbb stack info hub                        # details, deps, exports, ports
zbb stack remove hub                      # cleanup hooks, reclaim resources
zbb stack update dana@1.3.0              # update packaged version

# Lifecycle
zbb start hub                  # start + deps, respects ready_when
zbb start hub:server           # sub-stack only + deps
zbb stop hub                   # stop (not deps — others may need them)
zbb restart hub:server
zbb status                     # reads state files, no docker ps

# Dev lifecycle (delegates to manifest lifecycle commands)
zbb build hub                  # → ./gradlew build (or whatever the stack declares)
zbb test hub                   # → ./gradlew test
zbb gate hub                   # → ./gradlew gate

# Env
zbb env list                   # vars in current stack context
zbb env explain DANA_URL       # full provenance: type, formula, resolution, source
zbb env set LOG_LEVEL debug    # override → manifest → recalculates .env

# Logs (routed via manifest declaration)
zbb logs list                  # all sources across all stacks
zbb logs show dana             # single source, no name needed
zbb logs show hub:server       # sub-stack
zbb logs show hub:node:app     # named source within sub-stack
zbb logs show dana --follow

# Secrets
zbb secret create pg-local host=localhost port=${PGPORT}
zbb secret list --stack sql-module
zbb test sql-module            # discovers secrets, runs once per target
```

## Key Design Decisions

See [stacks-spec.md](stacks-spec.md) for detailed rationale. Summary:

| Decision | Rationale |
|----------|-----------|
| Extend `zbb.yaml`, not new file | Incremental adoption. Existing files keep working. |
| Bare imports, `as` for aliasing | Existing code reads `process.env.DANA_URL`. Dots aren't valid in env var names. |
| Explicit exports only | Encapsulation. Stacks can refactor internals without breaking consumers. |
| Lifecycle as contract | Build system is implementation detail. CI becomes stack-agnostic. |
| Three-layer env (schema → manifest → .env) | Manifest is source of truth. `.env` is computed output. Full introspection via `env explain`. |
| State: schema in manifest, YAML file on disk | File IS the interface. No SDK required. `yq`, bash, python, AI agents all work. |
| cd hook + shell function | direnv-like env scoping. Shell function for `env set` sync. Non-interactive uses binary. |
| Secrets = test matrix | Add a secret, get a test run. Stack lifecycle owns cleanup. |
| npm for distribution | Infrastructure exists. Versioning, private registries, access control for free. |
