# zbb — Claude Development Guide

## Architecture

zbb has two models that coexist:

### Legacy Slot Model (still active)
- Flat `.env` + `overrides.env` + `manifest.yaml` at slot root
- `SlotManager.create()` scans all `zbb.yaml` files, allocates ports, generates secrets
- `SlotEnvironment` reads/writes these flat files
- Used by Gradle tasks, old `zbb up/down`

### Stacks Model (new)
- Composable service units within slots: `zbb stack add ./dana && zbb stack start dana`
- Per-stack `.env` + `manifest.yaml` + `state.yaml` under `stacks/<name>/`
- Merged slot `.env` at root (projection of all stacks) for backward compat
- `StackEnvironment` — three-layer model: schema (zbb.yaml) → manifest → .env
- `StackManager` orchestrates add/remove/start/stop with topo-sorted deps

### Dependency Chain
```
hub → dana → hydra-schema → postgres (built-in)
file-service → dana + minio (built-in)
platform → dana
```

## Key Files

### Stack Core
- `lib/stack/StackManager.ts` — Orchestration: add, remove, start, stop, dep resolution, port allocation, secret caching, merged env sync
- `lib/stack/StackEnvironment.ts` — Three-layer env: initialize, recalculate, set/unset overrides, explain, import resolution
- `lib/stack/Stack.ts` — Single instance: identity, env, state, lifecycle execution, health checks
- `lib/stack/commands.ts` — CLI handlers + heartbeat monitor (background PID, shell alerts)
- `lib/stack/types.ts` — StackManifestEntry, ImportSpec, ExplainResult, StackStatus

### Infrastructure
- `lib/graph/toposort.ts` — Generic Kahn's algorithm for dependency ordering
- `lib/shell/hook.sh` — cd hook (env scoping), heartbeat alerts (PROMPT_COMMAND), zbb wrapper
- `stacks/postgres/` — Built-in postgres stack (compose + manifest)
- `stacks/minio/` — Built-in MinIO stack (S3-compatible local storage)

### Slot System (legacy + shared)
- `lib/slot/Slot.ts` — Slot instance with stacks getter, watcher events (slot + stack level)
- `lib/slot/SlotManager.ts` — Creates stacks/ dir on slot create
- `lib/slot/SlotWatcher.ts` — Dispatches stack:env:change, stack:state:change, stack:manifest:change. Excludes logs/ paths.
- `lib/slot/SlotEnvironment.ts` — Legacy flat env (unchanged, used by node-lib consumers)

### Config
- `lib/config.ts` — StackManifest, DependencySpec, LifecycleConfig, HealthCheckConfig, etc. EnvVarDeclaration supports `source: file`, `source: cwd`. `loadStackManifest()`, `isStackManifest()`.
- `lib/cli.ts` — Main router. Stack commands, --stack flag, env explain, heartbeat resume on slot load, clean error handling with --verbose.

## Stack Manifest Format (zbb.yaml)

```yaml
name: "@zerobias-com/dana"
version: "1.0.0"
depends:
  hydra-schema:
    package: "@zerobias-com/hydra-schema@^1.0.0"
    ready_when: { status: healthy }
exports: [DANA_URL, DANA_PORT, JWT_PUBLIC_KEY]
imports:
  hydra-schema: [PGHOST, PGPORT, PGUSER, PGPASSWORD, PGDATABASE]
substacks:
  dana:
    compose: test/docker-compose.dana.yml
    services: [dana]
  nginx:
    compose: test/docker-compose.dana.yml
    services: [nginx]
    depends: [dana]
env:
  DANA_PORT: { type: port }
  DANA_URL: { type: string, value: "http://localhost:${DANA_PORT}" }
  VAULT_TOKEN: { type: secret, source: file, file: "~/.vault-token", mask: true }
state:
  status: { type: enum, values: [starting, healthy, degraded, stopped, error] }
lifecycle:
  build: ./gradlew build
  start: bash test/seed.sh && docker compose -f test/docker-compose.dana.yml -p ${STACK_NAME} up -d
  stop: "docker stop ${STACK_NAME}-dana ${STACK_NAME}-nginx 2>/dev/null; true"
  health: { command: "curl -sf http://localhost:${DANA_PORT}/dana/health >/dev/null", interval: 3, timeout: 30 }
  seed: bash test/seed.sh
  cleanup: ["docker stop ... ; docker rm ... ; true"]
logs:
  dana: { source: docker, container: "${STACK_NAME}-dana" }
require:
  - { tool: docker, check: "docker --version", parse: "Docker version (\\S+),", version: ">=24" }
ports: { range: [15000, 16000] }
cleanse: [AWS_PROFILE, KUBECONFIG]
```

## Env Resolution Precedence

1. Override (user set via `zbb env set`)
2. Imported (from dependency stack)
3. Inherited (from parent shell, `source: env`)
4. File-sourced (`source: file`, e.g. ~/.vault-token)
5. CWD-resolved (`source: cwd`, resolved to stack source dir)
6. Generated (secrets)
7. Allocated (ports — with host bind-test for availability)
8. Derived (`value:` formula — recomputes when inputs change)
9. Default (`default:` — frozen at add time)

## Heartbeat Monitor

- Background bash loop spawned on `stack start`, PID tracked at `state/heartbeat.pid`
- Runs `zbb stack heartbeat --quiet` every 30s
- Checks all non-stopped stacks, detects crash (healthy→error) and recovery (error→healthy)
- Alerts written to `state/heartbeat-alerts.log`, displayed by shell PROMPT_COMMAND
- Manual `zbb stack heartbeat` shows full health status for all stacks
- `slot load` verifies health on entry, shows status
- Stops on slot exit, resumes on slot re-enter

## Slot Directory Structure (with stacks)

```
~/.zbb/slots/local/
  slot.yaml                          # metadata
  .env                               # merged projection of all stacks (for legacy consumers)
  manifest.yaml                      # slot-level manifest
  overrides.env                      # legacy user overrides
  .zbb-bashrc                        # rcfile sourcing hook.sh

  stacks/
    postgres/
      stack.yaml                     # identity (name, version, mode, source)
      manifest.yaml                  # Layer 2: per-var provenance
      .env                           # Layer 3: computed output
      state.yaml                     # runtime state (status, seeded, etc.)
      logs/
      state/secrets/
    hydra-schema/
      ...
    dana/
      ...
    hub/
      ...

  config/
  logs/
  state/
    secrets/                         # cached secrets/ports across stack re-adds
      dana.yaml
      hub.yaml
    heartbeat.pid                    # background monitor PID
    heartbeat-alerts.log             # pending alerts for shell display
    hub/                             # hub-node state (legacy)
```

## Testing

```bash
# Run all tests (98 tests)
npm test

# Run stack tests only
node --import tsx/esm --test lib/graph/*.test.ts lib/stack/*.test.ts

# TypeScript check
npx tsc --noEmit
```

## Key Design Decisions

- **Stack = template, slot = instance** — same dana stack in two slots gets different ports/secrets
- **Lifecycle is a contract** — shell commands, build system agnostic. zbb doesn't care if it's Gradle, npm, or Go.
- **Health check is zbb's job** — lifecycle.start does one thing, zbb verifies health after
- **Merged slot .env for backward compat** — node-lib SlotEnvironment reads slot root .env unchanged
- **Secrets cached per-slot** — removing and re-adding a stack reuses same UUIDs (idempotent seeds)
- **Ports checked with bind-test** — avoids conflicts with external services (Docker Swarm, etc.)
- **Watcher excludes logs** — no noise from log file writes. Logs are on-demand via `zbb logs show`.
- **Each stack owns its own containers** — stop/cleanup only touches that stack's containers, never the shared network or other stacks
- **Cascade on stop/remove** — stopping dana also stops hub, platform, etc. (reverse dep order)
