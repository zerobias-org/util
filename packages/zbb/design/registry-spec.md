# zbb Registry — Local npm Cache & Publish Proxy

## Problem

Developing services and libraries in tandem requires publishing libraries to test changes in consumers. Today this means either:
1. `npm link` — brittle, breaks with hoisted deps, doesn't test real resolution
2. Commit → CI publish → wait → `npm i` — slow, pollutes the registry with WIP versions
3. `file:` references — breaks CI, requires manual path management

We need a way to **locally publish a library and immediately consume it** in a running service stack, with real npm resolution semantics.

## Solution

A **Verdaccio-based local npm registry** that ships as a built-in zbb stack. It acts as:
1. **Local publish target** — `zbb registry publish` publishes a package to the local registry
2. **Upstream proxy/cache** — transparently caches packages from GitHub Packages and pkg.zerobias.org, speeding up `npm install`
3. **Slot-scoped .npmrc injection** — stacks automatically resolve from the local registry first

## Architecture

```
┌──────────────────────────────────────────────────────────┐
│  zbb slot (local)                                        │
│                                                          │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌─────────┐ │
│  │ postgres │  │ registry │  │  dana     │  │  hub    │ │
│  │(built-in)│  │(built-in)│  │ (stack)  │  │ (stack) │ │
│  └──────────┘  └──────────┘  └──────────┘  └─────────┘ │
│                    │                                     │
│              ┌─────┴─────┐                               │
│              │ Verdaccio │  ◄── shared Docker network    │
│              │ :4873     │      ${ZB_SLOT}_default    │
│              └─────┬─────┘                               │
│        ┌───────────┼───────────┐                         │
│        ▼           ▼           ▼                         │
│  npm.pkg.github  pkg.zerobias  npmjs.org                 │
│  (@zerobias-com) (@zerobias-org) (public)                │
│                                                          │
└──────────────────────────────────────────────────────────┘

Host access:      http://localhost:${REGISTRY_PORT}
Container access: http://${ZB_SLOT}-registry:4873
```

### Dependency Chain

The registry is a dependency of service stacks. It auto-starts when dana is added/started:

```
hub → dana → registry (built-in)
             dana → hydra-schema → postgres (built-in)
fileservice → dana + minio (built-in)
platform → dana
```

### Docker Network

All stacks in a slot share the `${ZB_SLOT}_default` Docker network via compose project naming (`-p ${ZB_SLOT}`). The registry container is `${ZB_SLOT}-registry` and is reachable by container name from any other stack's containers. No extra network configuration needed — this is the same pattern postgres and minio already use.

Two env vars expose the registry URL:
- `REGISTRY_URL` = `http://localhost:${REGISTRY_PORT}` — for host-side operations (`zbb registry publish`, `npm install` from terminal)
- `REGISTRY_INTERNAL_URL` = `http://${ZB_SLOT}-registry:4873` — for container-side operations (`npm install` inside Docker build stages)

---

## Built-in Stack: `@zerobias-com/registry`

Ships alongside postgres and minio in `packages/zbb/stacks/registry/`.

### Manifest (`zbb.yaml`)

```yaml
name: "@zerobias-com/registry"
version: "1.0.0"

exports: [REGISTRY_URL, REGISTRY_PORT, REGISTRY_INTERNAL_URL]

env:
  REGISTRY_PORT:
    type: port
    description: Verdaccio HTTP port

  REGISTRY_URL:
    type: string
    value: "http://localhost:${REGISTRY_PORT}"
    description: Local npm registry URL (host-side)

  REGISTRY_INTERNAL_URL:
    type: string
    value: "http://${ZB_SLOT}-registry:4873"
    description: Local npm registry URL (container-side, via Docker network)

  GITHUB_TOKEN:
    type: secret
    source: env
    description: GitHub token for proxying npm.pkg.github.com

  NPM_TOKEN:
    type: secret
    source: env
    description: Fallback GitHub token (aliases GITHUB_TOKEN)

  ZB_TOKEN:
    type: secret
    source: env
    description: ZeroBias token for proxying pkg.zerobias.org

state:
  status:
    type: enum
    values: [starting, healthy, stopped, error]

lifecycle:
  start: >-
    bash setup.sh &&
    docker compose -f compose.yml -p ${ZB_SLOT} up -d
  stop: docker stop ${ZB_SLOT}-registry 2>/dev/null; docker rm ${ZB_SLOT}-registry 2>/dev/null; true
  health:
    command: "curl -sf http://localhost:${REGISTRY_PORT}/-/ping >/dev/null"
    interval: 2
    timeout: 30
  cleanup:
    - "docker stop ${ZB_SLOT}-registry 2>/dev/null; docker rm ${ZB_SLOT}-registry 2>/dev/null; true"
    - "docker volume rm ${ZB_SLOT}_verdaccio-storage 2>/dev/null; true"

logs:
  source: docker
  container: "${ZB_SLOT}-registry"
```

### Compose (`compose.yml`)

```yaml
services:
  registry:
    image: verdaccio/verdaccio:6
    container_name: ${ZB_SLOT}-registry
    ports:
      - "${REGISTRY_PORT}:4873"
    environment:
      VERDACCIO_PORT: 4873
      GITHUB_TOKEN: ${GITHUB_TOKEN:-}
      NPM_TOKEN: ${NPM_TOKEN:-}
      ZB_TOKEN: ${ZB_TOKEN:-}
    volumes:
      - verdaccio-storage:/verdaccio/storage
      - ./config.yaml:/verdaccio/conf/config.yaml:ro
      - ./htpasswd:/verdaccio/conf/htpasswd:ro
    labels:
      zerobias.slot: ${ZB_SLOT}

volumes:
  verdaccio-storage:
```

### Verdaccio Config (`config.yaml`)

```yaml
storage: /verdaccio/storage

auth:
  htpasswd:
    file: /verdaccio/conf/htpasswd
    max_users: -1   # no self-registration, pre-seeded user only

uplinks:
  github-packages:
    url: https://npm.pkg.github.com/
    auth:
      type: bearer
      token_env: GITHUB_TOKEN
    timeout: 30s
    max_fails: 3
    fail_timeout: 5m

  zerobias-org:
    url: https://pkg.zerobias.org/
    auth:
      type: bearer
      token_env: ZB_TOKEN
    timeout: 30s
    max_fails: 3
    fail_timeout: 5m

  npmjs:
    url: https://registry.npmjs.org/
    timeout: 30s
    max_fails: 3
    fail_timeout: 5m

packages:
  # Scoped internal packages — local first, then upstream
  "@zerobias-com/*":
    access: $all
    publish: $all
    proxy: github-packages

  "@zerobias-org/*":
    access: $all
    publish: $all
    proxy: zerobias-org

  "@auditlogic/*":
    access: $all
    publish: $all
    proxy: github-packages

  # Everything else — proxy to npmjs
  "**":
    access: $all
    publish: $all
    proxy: npmjs

# Logging
log:
  type: stdout
  format: pretty
  level: warn

# Web UI (for browsing local packages)
web:
  enable: true
  title: "zbb local registry"

# Middleware
middlewares:
  audit:
    enabled: false
```

### Setup Script (`setup.sh`)

Pre-seeds an htpasswd file for local auth:

```bash
#!/bin/bash
set -e

STACK_DIR="$(cd "$(dirname "$0")" && pwd)"

# Generate htpasswd for local user (one-time)
if [ ! -f "$STACK_DIR/htpasswd" ]; then
  # Pre-seeded: user "zbb" with SHA1 password "zbb"
  echo 'zbb:{SHA}Wvlwft9mUjS7s2jJONOiDhGNtgk=' > "$STACK_DIR/htpasswd"
fi
```

---

## Version Strategy

### Same-Version Override (Default)

Services pin **exact versions** in package.json:
```json
"@zerobias-com/util-events": "2.0.18"
```

When you locally publish, zbb publishes at the **same version** from the package's `package.json`. Verdaccio serves the local copy instead of the upstream one because it checks local storage first.

```bash
# In com/util/packages/events (version 2.0.18 in package.json):
zbb registry publish  # publishes @zerobias-com/util-events@2.0.18 locally

# In com/hub:
npm install  # gets local 2.0.18 from Verdaccio instead of upstream
```

This requires **zero changes** to consumer package.json. Caret vs exact pinning doesn't matter — the local version always wins because Verdaccio checks local storage before proxying upstream.

To revert: `zbb registry clear` removes local overrides; next `npm install` fetches from upstream.

### Optional: Explicit Version

```bash
zbb registry publish --as 3.0.0   # publish at a specific version
```

---

## CLI Commands

### `zbb registry publish [path]`

Publishes a package to the local Verdaccio instance.

```bash
# Publish current directory
zbb registry publish

# Publish a specific package
zbb registry publish ~/nfa-repos/org/util/packages/connector
```

**Steps:**
1. Resolve path (default: cwd)
2. Read `package.json` to get name and version
3. Run `zbb build` (uses the existing zbb build cache) to ensure dist is current
4. Run `npm pack` to create tarball (respects `files` and build output)
5. Run `npm publish <tarball> --registry http://localhost:${REGISTRY_PORT}` 
6. Log: `Published @zerobias-com/util-events@2.0.18 to local registry`

### `zbb registry list`

Shows packages published to the local registry (not cached upstream packages).

```bash
zbb registry list
# Local packages:
#   @zerobias-com/util-events    2.0.18   (2 min ago)
#   @zerobias-org/logger         3.0.3    (15 min ago)
```

### `zbb registry install [stack]`

Runs `npm install` for a stack with the local registry.

```bash
# Install deps for dana with local registry
zbb registry install dana

# Equivalent to:
cd <dana-source> && npm install --registry=http://localhost:${REGISTRY_PORT}
```

### `zbb registry clear`

Wipes locally-published packages.

```bash
zbb registry clear
# Cleared 3 locally-published packages

zbb registry clear --all
# Cleared all cached packages (including upstream cache)
```

### `zbb registry status`

```bash
zbb registry status
# Registry: running on http://localhost:15432
# Web UI:   http://localhost:15432
# Cached upstream packages: 847
# Locally published: 3
# Storage: 124 MB
```

### `zbb registry start` / `zbb registry stop`

Convenience aliases:
```bash
zbb registry start   # → zbb stack start registry
zbb registry stop    # → zbb stack stop registry
```

Normally not needed since the registry auto-starts as a dependency of dana.

---

## .npmrc Injection

When the registry stack is running, zbb injects registry configuration so `npm install` within any stack context automatically uses the local registry.

### Mechanism

On registry start, zbb generates a slot-level `.npmrc` at `~/.zbb/slots/<slot>/stacks/registry/.npmrc`:

```ini
# Auto-generated by zbb registry
registry=http://localhost:${REGISTRY_PORT}
@zerobias-com:registry=http://localhost:${REGISTRY_PORT}
@zerobias-org:registry=http://localhost:${REGISTRY_PORT}
@auditlogic:registry=http://localhost:${REGISTRY_PORT}
//localhost:${REGISTRY_PORT}/:_authToken=fake-local-token
```

The `NPM_CONFIG_USERCONFIG` env var is exported into each stack's environment, pointing at this file. Any `npm install` in a loaded slot automatically routes through Verdaccio.

### Fallback

If the registry stack is not running or not in the slot, stacks use their normal `.npmrc` (GitHub Packages / pkg.zerobias.org). No breakage — the registry is additive.

---

## Auto-Start via Dependency

The registry is declared as a dependency in service stack manifests. Dana's `zbb.yaml`:

```yaml
depends:
  registry:
    package: "@zerobias-com/registry"
    ready_when:
      status: healthy
  hydra-schema:
    package: "@zerobias-com/hydra-schema@^1.0.0"
    ready_when:
      status: healthy
```

When you run `zbb stack add dana`, the registry (built-in) and hydra-schema → postgres are auto-resolved and added. On `zbb stack start dana`, the topo-sorted order is:

```
1. postgres (built-in)     → start + health
2. registry (built-in)     → start + health
3. hydra-schema            → start + health
4. dana                    → seed + start + health
```

Postgres and registry start in parallel (no dependency between them).

---

## Auth Token Forwarding

Verdaccio needs auth tokens to proxy upstream registries:
- `GITHUB_TOKEN` / `NPM_TOKEN` for `npm.pkg.github.com`
- `ZB_TOKEN` for `pkg.zerobias.org`

These are passed through from the host environment via `source: env` in the registry's `zbb.yaml`. Within a loaded slot, these env vars are already available (devs have them set in their shell profile or `.envrc`).

The compose file forwards them into the container:
```yaml
environment:
  GITHUB_TOKEN: ${GITHUB_TOKEN:-}
  ZB_TOKEN: ${ZB_TOKEN:-}
```

Verdaccio's uplink config references them via `token_env`:
```yaml
uplinks:
  github-packages:
    auth:
      type: bearer
      token_env: GITHUB_TOKEN
```

If tokens are missing, upstream proxy fails gracefully — locally published packages still work, and public npmjs packages still resolve.

---

## Build Before Publish

`zbb registry publish` runs the existing `zbb build` pipeline before packing. This uses the same build cache that `zbb stack start` uses, so:

- If the package was recently built and nothing changed, the build is a no-op (cached)
- If source files changed, it rebuilds (transpile, lint, etc.)
- The published tarball always contains current build output

This matches the lifecycle model: `zbb build` is the canonical build step, `registry publish` extends it with pack + publish.

---

## Workflow Examples

### Typical library dev workflow

```bash
# 1. Load slot (registry auto-starts with dana)
zbb slot load local

# 2. Work on a logging fix
cd ~/nfa-repos/org/util/packages/logger
# ... make changes, run tests ...
npm test

# 3. Publish to local registry
zbb registry publish
# → Published @zerobias-org/logger@3.0.3 to local registry

# 4. Install in consumer
cd ~/nfa-repos/com/hub
zbb registry install hub
# → npm install routes through Verdaccio, picks up local logger@3.0.3

# 5. Test hub with the new logger
zbb stack restart hub:server
```

### Multi-package change

```bash
# Changed both util-core and util-events
zbb registry publish ~/nfa-repos/com/util/packages/core
zbb registry publish ~/nfa-repos/com/util/packages/events

# Rebuild consumer
zbb registry install dana
zbb stack restart dana
```

### Clean up after done

```bash
# Remove local overrides, go back to upstream packages
zbb registry clear
zbb registry install hub   # re-fetches from upstream
zbb registry install dana
```

### Browse local packages

```bash
# Open Verdaccio web UI
open http://localhost:${REGISTRY_PORT}
```

---

## Storage & Lifecycle

### Storage Location

Verdaccio data lives in a Docker volume: `${ZB_SLOT}_verdaccio-storage`.

- Survives `zbb stack stop registry` (just stops the container)
- Destroyed by `zbb stack remove registry` or `zbb registry clear --all`
- Upstream cache is valuable (speeds up npm install), local publishes are ephemeral

### Slot Isolation

Each slot gets its own registry instance (different port, different volume). Publishing a local package in slot `local` doesn't affect slot `staging`.

---

## Decisions Made

| Question | Decision | Rationale |
|----------|----------|-----------|
| Version strategy | Same-version override | Zero changes to consumers; exact pins don't matter since local storage wins |
| Auth tokens | Pass through from host env (`source: env`) | Devs already have GITHUB_TOKEN/ZB_TOKEN set; slot env makes them available |
| Build before publish | Use `zbb build` (cached) | Consistent with lifecycle model; no-op if already built |
| Monorepo `--changed` | Deferred (v2) | Path-driven publish is sufficient for v1 |
| Auto-start | Dependency of dana | Registry auto-starts in the normal topo-sorted start flow |
| Docker networking | Shared network via compose project naming | Same pattern as postgres/minio; container name resolution is automatic |

---

## Non-Goals (v1)

- **Not replacing CI publish** — this is for local dev only
- **Not a permanent artifact store** — packages are ephemeral, slot-scoped
- **Not handling lock file conflicts** — `npm install` via registry may update `package-lock.json`; revert before commit
- **Not `--changed` detection** — publish is explicit by path or cwd
- **Not a replacement for npm link in all cases** — link is still useful for rapid iteration without the build+publish step
