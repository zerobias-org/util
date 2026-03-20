# zbb — ZeroBias Build

`zbb` is the developer CLI for the ZeroBias platform. It does two things:

1. **Gradle wrapper** — run Gradle tasks from any subdirectory with automatic project detection
2. **Slot manager** — create isolated development environments (like Python venv for infrastructure)

Works in any repository that has a `zbb.yaml` — the meta-repo, a single repo checkout, or a customer integration.

## Install

```bash
npm install -g @zerobias-org/zbb
```

Requires:
- **Node.js** >= 18
- **nvm** (or fnm/volta — configured via `~/.zbb/config.yaml`)

Verify:
```bash
zbb --version
zbb --help
```

## Quick Start

```bash
# Create a slot (allocates ports, generates secrets, pulls env)
zbb slot create local

# Enter the slot (spawns subshell with env loaded)
zbb slot load local
[zb:local]:~/my-project$

# Work normally — Gradle, npm, docker all see slot env vars
zbb up                 # starts stack defined in zbb.yaml
zbb compile            # runs gradle compile in current project

# When done
exit                   # returns to original shell, nothing polluted
```

## Gradle Wrapper

Run Gradle tasks from any subdirectory. `zbb` finds the nearest `gradlew`, detects which subproject you're in, and prefixes task names automatically.

```bash
# From repo root — runs as-is
zbb projects

# From a subproject directory — auto-prefixes
cd github/github
zbb compile            # ./gradlew :github:github:compile
zbb test gate          # ./gradlew :github:github:test :github:github:gate

# Gradle flags pass through
zbb -Pfoo=bar compile  # ./gradlew -Pfoo=bar :github:github:compile

# Stack aliases (when inside a project with zbb.yaml)
zbb up                 # ./gradlew stackUp
zbb down               # ./gradlew stackDown
zbb destroy            # ./gradlew stackDestroy
zbb info               # ./gradlew stackInfo
```

### Project Cache

`zbb` caches the project-to-directory mapping in `.gradle/zbb-projects.json`. The cache auto-refreshes when `settings.gradle.kts` changes.

```bash
zbb --refresh-cache
```

### Environment

`zbb` automatically sets:
- `JAVA_HOME` to Java 21 (works around Gradle 8.10.2 issues with Java 25)
- `GRADLE_OPTS` to suppress native access warnings

## Slots

A slot is a named, isolated environment for local development. It holds port allocations, generated secrets, log directories, runtime state, and configuration — all persisting across terminal sessions.

### Why Slots?

Without slots:
- Manually set 20+ env vars per terminal
- Port conflicts between projects
- Regenerate JWT keys after every restart
- Logs scattered across the filesystem
- No way to run two environments side-by-side

With slots:
- `zbb slot load local` and everything works
- Ports allocated once, persisted
- Secrets generated once, reused
- Logs and state organized per-slot
- Run `local` and `dev` slots simultaneously

### Slot Directory Structure

Each slot has three subdirectories for runtime data plus root-level files managed by zbb:

```
~/.zbb/slots/local/
  slot.yaml              # metadata (created, ephemeral, ttl, ports)
  .env                   # declared env vars (managed by zbb — do not edit)
  manifest.yaml          # var provenance (source project, type, masking)
  overrides.env          # user overrides (via zbb env set)

  config/                # per-slot app configuration files
    nginx.conf           # (if project generates per-slot config)

  logs/                  # log files — services write here via ZB_SLOT_LOGS
    dana.log
    postgres.log

  state/                 # runtime state, pid files, app-specific data
    dana/                # dana-specific state
    tmp/                 # per-slot temp directory
```

These are exposed as env vars inside the slot:

```bash
ZB_SLOT=local
ZB_SLOT_DIR=~/.zbb/slots/local
ZB_SLOT_CONFIG=~/.zbb/slots/local/config
ZB_SLOT_LOGS=~/.zbb/slots/local/logs
ZB_SLOT_STATE=~/.zbb/slots/local/state
ZB_SLOT_TMP=~/.zbb/slots/local/state/tmp
STACK_NAME=local
```

Projects use these to route output. For example, a `zbb.yaml` can declare:

```yaml
env:
  HUB_LOG_DIR:
    type: string
    default: "${ZB_SLOT_LOGS}/hub"
  NODE_BASE_DIR:
    type: string
    default: "${ZB_SLOT_STATE}/hub"
```

### Slot Lifecycle

#### Create

```bash
zbb slot create local
```

What happens:
1. Scans all `zbb.yaml` files from the repo root downward
2. Collects env var declarations from every project
3. Allocates ports (no conflicts across projects)
4. Generates secrets (JWT keys, encryption keys)
5. Inherits required vars from current shell (NPM_TOKEN, etc.)
6. Resolves derived vars (dependency-ordered `${VAR}` interpolation)
7. Creates slot directories (config, logs, state)
8. Writes `.env`, `manifest.yaml`, `slot.yaml`

#### Load

```bash
zbb slot load local
```

What happens:
1. Garbage-collects expired ephemeral slots (near-zero overhead)
2. Runs preflight checks (extensible tool validation)
3. Loads slot `.env` and user overrides
4. Applies env cleansing (removes vars listed in `.zbb.yaml` cleanse)
5. Activates nvm (or configured node manager) for correct Node.js version
6. Spawns a bash subshell with everything loaded
7. Sets prompt to `[zb:{{slotName}}]:path$`

Inside the subshell, all tools read from the environment:
- `./gradlew stackUp` reads `PGPORT`, `STACK_NAME`, etc.
- `hub-node node start` reads `SERVER_URL`, `API_KEY`, etc.
- `docker compose up` reads `${STACK_NAME}` for container names

#### Exit

```bash
exit
```

Returns to the original shell. No env leakage. Containers keep running. Next `zbb slot load local` reconnects instantly.

#### List

```bash
zbb slot list

  NAME        STATUS    PORTS   TTL          CREATED
  local       loaded    7       persistent   2026-03-20
  dev         idle      7       persistent   2026-03-18
  e2e-a1b2c3  idle      4       37m left     2026-03-20
```

#### Info

```bash
zbb slot info [name]

Slot: local
Status: loaded (PID: 48291)
Created: 2026-03-20
Type: persistent

Ports:
  PGPORT=15432       (com/dana)
  DANA_PORT=15080    (com/dana)
  NGINX_PORT=15443   (com/dana)
  HUB_PORT=15090     (com/hub)

Secrets: 3 generated
Env vars: 24 total (18 declared, 3 inherited, 3 overrides)

Directories:
  config  ~/.zbb/slots/local/config/
  logs    ~/.zbb/slots/local/logs/    (4 files)
  state   ~/.zbb/slots/local/state/   (2 services)
```

#### Delete

```bash
zbb slot delete local

Stopping containers... done
Removing volumes... done
Removing ~/.zbb/slots/local/... done
```

### Ephemeral Slots

For test runs, CI pipelines, and throwaway environments. Ephemeral slots have a TTL and are garbage-collected by future `zbb` invocations.

```bash
# Auto-named with 2-hour TTL (default)
zbb slot create --ephemeral
# e2e-a1b2c3 (ttl: 2h, expires: 2026-03-20T16:30:00)

# Named with custom TTL
zbb slot create --ephemeral --ttl 30m ci-run-42

# Explicit garbage collection
zbb slot gc
# Expired:
#   e2e-a1b2c3  expired 45m ago  (removing...)
#   ci-run-42   18m remaining    (skipped)
```

Ephemeral slots are **not** auto-deleted on exit. They persist until their TTL expires and a future `zbb` command triggers GC. GC runs automatically at the start of `slot create`, `slot load`, and `slot list`.

Gradle creates ephemeral slots for integration tests via CLI:

```kotlin
// In Gradle test setup
exec { commandLine("zbb", "slot", "create", "--ephemeral", "--ttl", "30m", slotName) }
// stackUp uses this slot's env
// stackDestroy + slot delete in cleanup
```

`slot.yaml` tracks ephemerality:

```yaml
name: e2e-a1b2c3
created: 2026-03-20T14:00:00Z
ephemeral: true
ttl: 7200
expires: 2026-03-20T16:00:00Z
```

### Preflight Checks

`zbb slot load` validates prerequisites before entering the subshell. Each check runs a command, parses the version, and validates against a semver constraint.

```
Preflight check...
  docker     24.0.7    ok   (>=24)
  java       21.0.4    ok   (21)
  node       22.21.1   ok   (>=22)
  nvm        0.40.1    ok   (*)
  psql       17.2      ok   (>=14)
  sem        2.1.0     ok   (*)
  NPM_TOKEN            ok

Fix issues above before loading slot.
```

Tool checks are declared in `zbb.yaml` and `.zbb.yaml`:

```yaml
require:
  - tool: psql
    check: "psql --version"
    parse: "psql \\(PostgreSQL\\) (\\S+)"
    version: ">=14"
    install: "apt install postgresql-client-17"

  - tool: docker
    check: "docker --version"
    parse: "Docker version (\\S+),"
    version: ">=24"
    install: "https://docs.docker.com/engine/install/"

  - tool: sem
    check: "sem-apply --version"
    parse: "(\\S+)"
    version: "*"
    install: "gem install schema-evolution-manager"

  - tool: jq
    check: "jq --version"
    parse: "jq-(\\S+)"
    version: ">=1.6"
    install: "apt install jq"
```

Monorepo `.zbb.yaml` declares global tool requirements. Project `zbb.yaml` adds project-specific ones. User `~/.zbb/config.yaml` can skip checks for specific tools. Preflight runs the union.

## Environment Variables

### Three Tiers

Inside a loaded slot, env vars come from three sources:

| Tier | Source | Example |
|------|--------|---------|
| **Declared** | Project `zbb.yaml` files, resolved by `zbb slot create` | `PGPORT`, `JWT_PRIVATE_KEY`, `HUB_LOG_DIR` |
| **Inherited** | Parent shell, carried into subshell | `HOME`, `USER`, `PATH` |
| **Ad hoc** | User sets manually inside subshell | `export DEBUG=true` |

`zbb env` commands operate on **declared** vars only. Inherited and ad hoc vars are visible via normal shell commands (`env`, `echo $VAR`).

### Derived Variables

Vars can reference other vars using `${VAR}` in their default. References are resolved in dependency order during `slot create`.

```yaml
env:
  HUB_PORT:
    type: port
    default: 8888

  SERVER_URL:
    type: string
    default: "http://localhost:${HUB_PORT}"    # resolves after HUB_PORT

  HUB_LOG_DIR:
    type: string
    default: "${ZB_SLOT_LOGS}/hub"             # slot-relative path

  NODE_BASE_DIR:
    type: string
    default: "${ZB_SLOT_STATE}/hub"            # state in slot dir

  FILE_SECRET_ROOT:
    type: string
    default: "${ZB_SLOT_STATE}/hub/secrets"
```

Resolution rules:
1. All non-derived vars resolve first (ports, secrets, literals, inherited)
2. Derived vars resolve in dependency order (topo-sorted, cycles are errors)
3. User overrides (`zbb env set`) replace the final value — derivation is skipped
4. `zbb env list` shows whether a value is derived or overridden

```
[zb:local]$ zbb env list
  HUB_PORT=15090                                    (com/hub — port)
  SERVER_URL=http://localhost:15090                  (com/hub — derived from HUB_PORT)
  HUB_LOG_DIR=/home/kevin/.zbb/slots/local/logs/hub (com/hub — derived from ZB_SLOT_LOGS)

[zb:local]$ zbb env set SERVER_URL https://ci.zerobias.com
  SERVER_URL: http://localhost:15090 -> https://ci.zerobias.com (override, was derived)
```

For complex derivations that go beyond string interpolation (protocol transforms, conditional logic), projects can register custom resolvers via the library API:

```javascript
import { zbb } from '@zerobias-org/zbb';

zbb.registerResolver('WEBSOCKET_URL', (env) => {
  const hubUrl = env.get('HUB_SERVER_URL');
  if (!hubUrl) return undefined;
  return hubUrl.replace(/^https:/, 'wss:').replace(/^http:/, 'ws:');
});
```

### Deprecation

Vars can be marked deprecated in `zbb.yaml`. Accessing a deprecated var at runtime throws an error with migration guidance:

```yaml
env:
  HUB_SERVER_URL:
    deprecated: true
    replacedBy: SERVER_URL
    message: "Use SERVER_URL instead. It is automatically derived."
```

### Masking

Sensitive vars are masked in output. Masking is determined by:
1. Explicit `mask: true` in `zbb.yaml`
2. `type: secret` (always masked)
3. Auto-detection by name pattern (`/key$/i`, `/secret$/i`, `/token$/i`, `/password$/i`)

```bash
zbb env list
  API_KEY=***            (com/hub — masked)

zbb env get API_KEY
  sk_test_12345          # full value shown on explicit get
```

### Commands

```bash
# List declared slot vars (shows source project, type, derivation)
zbb env list
zbb env list --unmask

# Get a single var (secrets shown in full)
zbb env get PGPORT
zbb env get JWT_PRIVATE_KEY

# Set a persistent override (survives slot reload)
zbb env set LOG_LEVEL debug

# Cleanse an inherited var (prevent leakage into slot)
zbb env unset AWS_PROFILE

# Show what changed vs parent shell
zbb env diff

# Clear all overrides back to declared defaults
zbb env reset
```

### Overrides

`zbb env set` writes to `~/.zbb/slots/<name>/overrides.env`. These persist across `exit` / `zbb slot load` cycles. Use `zbb env reset` to clear them.

## Logs

Logs are a slot-level concern. Any service that writes to `$ZB_SLOT_LOGS/<name>.log` is discoverable by `zbb logs`.

```bash
# List log sources (scans ZB_SLOT_LOGS directory)
zbb logs list
  dana         142K   modified 2m ago
  hub-server   89K    modified 5m ago
  postgres     12K    modified 1h ago

# View last N lines
zbb logs show dana --tail 100

# Follow in real time
zbb logs show hub-server --follow
```

Services route their logs via env vars declared in `zbb.yaml`:

```yaml
# com/dana/zbb.yaml
env:
  DANA_LOG_FILE:
    type: string
    default: "${ZB_SLOT_LOGS}/dana.log"

# com/hub/zbb.yaml
env:
  HUB_LOG_FILE:
    type: string
    default: "${ZB_SLOT_LOGS}/hub-server.log"
```

## Project Configuration

Each project declares its needs in `zbb.yaml` at the project root. `zbb` finds these by walking from the repo root (the directory containing `.zbb.yaml` or `gradlew`) downward, ignoring `node_modules/`.

### `zbb.yaml` Reference

```yaml
# com/dana/zbb.yaml

# Environment variables this project needs
env:
  PGPORT:
    type: port
    default: 5432
    description: PostgreSQL port

  POSTGRES_DB:
    type: string
    default: dana

  POSTGRES_PASSWORD:
    type: string
    default: dana_dev
    mask: true

  JWT_PRIVATE_KEY:
    type: secret
    generate: rsa:2048

  JWT_PUBLIC_KEY:
    type: secret
    generate: rsa_public:JWT_PRIVATE_KEY

  NPM_TOKEN:
    type: string
    mask: true
    source: env
    required: true

  DANA_LOG_FILE:
    type: string
    default: "${ZB_SLOT_LOGS}/dana.log"

  LOCAL_MODE:
    type: string
    default: "true"

  # Deprecated var — accessing throws error with migration hint
  OLD_DANA_URL:
    deprecated: true
    replacedBy: SERVER_URL
    message: "SERVER_URL is now the single entry point"

# Tool prerequisites (merged with .zbb.yaml requirements)
require:
  - tool: sem
    check: "sem-apply --version"
    parse: "(\\S+)"
    version: "*"
    install: "gem install schema-evolution-manager"

# Docker compose stack (used by zb.stack-testing plugin)
stack:
  compose: test/docker-compose.yml
  services: [postgres, nginx, dana]
  healthcheck:
    postgres:
      container: "{slot}-postgres"
      timeout: 30
    dana:
      container: "{slot}-dana"
      timeout: 120
```

### Env Var Types

| Type | Behavior |
|------|----------|
| `port` | Allocated from port range during `slot create`. No conflicts across projects. |
| `string` | Plain value. Uses `default` if provided. Supports `${VAR}` references. |
| `secret` | Generated during `slot create` based on `generate` spec. Always masked. |

### Env Var Properties

| Property | Required | Description |
|----------|----------|-------------|
| `type` | yes | `port`, `string`, or `secret` |
| `default` | no | Default value. Supports `${VAR}` references for derived vars. |
| `description` | no | Human-readable description for `zbb env list` |
| `mask` | no | Show as `***` in list output (auto-true for secrets) |
| `generate` | no | Generation spec for secrets: `rsa:2048`, `hex:32`, etc. |
| `source` | no | `env` = must come from parent shell (not generated/defaulted) |
| `required` | no | Fail `slot create` if not available |
| `deprecated` | no | Mark var as deprecated — access throws error |
| `replacedBy` | no | Var name that replaces this one (shown in deprecation error) |
| `message` | no | Custom deprecation message |

### Secret Generation Specs

| Spec | Result |
|------|--------|
| `rsa:2048` | RSA private key, 2048 bits |
| `rsa_public:JWT_PRIVATE_KEY` | RSA public key derived from named private key |
| `hex:32` | 32 random bytes as hex string |
| `uuid` | Random UUID v4 |
| `base64:32` | 32 random bytes as base64 |

### Cross-Project Var Sharing

Projects share vars by declaring the same name. First declaration wins for defaults and generation. Subsequent declarations are references.

```yaml
# com/dana/zbb.yaml — declares and owns PGPORT
env:
  PGPORT:
    type: port
    default: 5432

# com/hub/zbb.yaml — references PGPORT (same postgres)
env:
  PGPORT:
    type: port
    # no default — uses dana's allocation
```

If two projects declare conflicting defaults for the same var, `zbb slot create` warns and uses the first one found.

## Repo Configuration

### `.zbb.yaml` (repo root)

Shared settings for the repo. `zbb` walks up from the current directory to find this file (same as it finds `gradlew`).

```yaml
# Common env vars for every slot
env:
  LOCAL_MODE:
    type: string
    default: "true"
  LOG_LEVEL:
    type: string
    default: info

# Global tool requirements (all projects inherit these)
require:
  - tool: java
    check: "java -version"
    parse: "version \"(\\S+)\""
    version: "21"
    install: "apt install openjdk-21-jdk"

  - tool: node
    check: "node --version"
    parse: "v(\\S+)"
    version: ">=22"
    install: "nvm install 22"

  - tool: docker
    check: "docker --version"
    parse: "Docker version (\\S+),"
    version: ">=24"
    install: "https://docs.docker.com/engine/install/"

  - tool: nvm
    check: "nvm --version"
    parse: "(\\S+)"
    version: "*"
    install: "https://github.com/nvm-sh/nvm#installing-and-updating"

# Port allocation range
ports:
  range: [15000, 16000]

# Vars to unset when entering slot (prevent leakage from parent shell)
cleanse:
  - AWS_PROFILE
  - KUBECONFIG
  - DATABASE_URL
```

### `~/.zbb/config.yaml` (user-level)

Personal overrides — not checked into any repo. Created automatically on first `zbb slot create` with detected defaults.

```yaml
# Tool paths (auto-detected, overridable)
java:
  home: /usr/lib/jvm/java-21-openjdk-amd64

node:
  version: 22.21.1
  manager: nvm              # nvm | fnm | volta | system

# Slot storage location
slots:
  dir: ~/.zbb/slots

# Shell customization
prompt: "[zb:{{slot}}]:{cwd}$ "

# Skip specific tool checks (e.g., if you know your version is fine)
skip_checks:
  - psql
```

## Library API

`zbb` is also an npm package. Other tools can import it to manage slots programmatically without shelling out.

```javascript
import { SlotManager, SlotEnvironment } from '@zerobias-org/zbb';

// List slots
const slots = await SlotManager.list();

// Create a slot
const slot = await SlotManager.create('e2e-test', {
  ephemeral: true,
  ttl: 1800,
});

// Read env
const pgPort = slot.env.get('PGPORT');
const allVars = slot.env.getAll();

// Set override
await slot.env.set('LOG_LEVEL', 'debug');

// Read manifest (var provenance)
const manifest = slot.env.getManifest();
// { PGPORT: { source: 'com/dana', type: 'port', allocated: 15432 }, ... }

// Garbage collect expired ephemeral slots
await SlotManager.gc();

// Register custom resolver
SlotEnvironment.registerResolver('WEBSOCKET_URL', (vars) => {
  const hubUrl = vars.get('HUB_SERVER_URL');
  return hubUrl?.replace(/^https:/, 'wss:').replace(/^http:/, 'ws:');
});
```

### Package Exports

```json
{
  "exports": {
    ".": "./lib/index.mjs",
    "./slot": "./lib/slot.mjs",
    "./env": "./lib/env.mjs"
  },
  "bin": {
    "zbb": "bin/zbb.mjs"
  }
}
```

Consumers:
- **hub-node-lib** — reads slot env, writes to `state/hub/` subdirectory
- **Gradle plugins** — calls `zbb slot create --ephemeral` for test slots
- **CI scripts** — creates slots, runs tests, cleans up

## Gradle Integration

Gradle tasks assert `ZB_SLOT` is set and use env vars from the shell. Gradle never creates or manages persistent slots.

```kotlin
// In zb.stack-testing.gradle.kts
val slotName = System.getenv("ZB_SLOT")
    ?: throw GradleException(
        "No active slot. Run:\n" +
        "  zbb slot create <name>\n" +
        "  zbb slot load <name>"
    )
```

For ephemeral test slots, Gradle calls `zbb` via CLI:

```kotlin
// Create ephemeral slot for integration tests
val slotName = "e2e-${UUID.randomUUID().toString().take(8)}"
exec { commandLine("zbb", "slot", "create", "--ephemeral", "--ttl", "30m", slotName) }
// Read the generated .env for test configuration
// Clean up: exec { commandLine("zbb", "slot", "delete", slotName) }
```

Stack tasks (`stackUp`, `stackDown`, `stackInfo`, `stackDestroy`) use the environment directly. Port values, secrets, and config are already in the shell from the slot.

## File Layout

```
~/.zbb/
  config.yaml                       # user-level config (auto-created)
  slots/
    local/
      slot.yaml                     # metadata (created, ephemeral, ttl)
      .env                          # declared vars (managed by zbb)
      manifest.yaml                 # var provenance (source, type, masking)
      overrides.env                 # user overrides (via zbb env set)
      config/                       # per-slot app config files
      logs/                         # service log files
      state/                        # runtime state per service
        hub/                        #   hub-node state
        dana/                       #   dana state
        tmp/                        #   slot-scoped temp dir
    e2e-a1b2c3/                     # ephemeral slot (auto-cleaned)
      slot.yaml                     # includes ttl + expires
      .env
      ...

<repo-root>/
  .zbb.yaml                        # repo-level config (checked in)
  project-a/
    zbb.yaml                       # project-a's env declarations
  project-b/
    zbb.yaml                       # project-b's env declarations
```

## Examples

### First-time setup

```bash
zbb slot create local

Creating slot 'local'...
  Scanning for zbb.yaml files...
    com/dana/zbb.yaml: 11 vars (3 ports, 3 secrets)
    com/hub/zbb.yaml: 8 vars (3 ports, 2 derived)
    auditlogic/module-gradle/zbb.yaml: 2 vars (inherited)
  Allocating ports from range 15000-16000...
    PGPORT=15432  DANA_PORT=15080  NGINX_PORT=15443
    HUB_PORT=15090  HUB_NODE_PORT=15091  PKG_PROXY_PORT=15873
  Generating secrets...
    JWT_PRIVATE_KEY  ok (RSA 2048)
    JWT_PUBLIC_KEY   ok (derived)
    ENCRYPTION_KEY   ok (256-bit hex)
  Inheriting from shell...
    NPM_TOKEN        ok
    ZB_TOKEN         ok
  Resolving derived vars...
    SERVER_URL       ok (http://localhost:15090)
    HUB_LOG_DIR      ok (~/.zbb/slots/local/logs/hub)
  Writing ~/.zbb/slots/local/.env (28 vars)

Slot 'local' created. Load with: zbb slot load local
```

### Daily workflow

```bash
zbb slot load local
[zb:local]:~/zerobias$

# Start services
cd com/dana && zbb up
cd ../hub && zbb up

# Build
cd ../../auditlogic/module-gradle
zbb :github:github:build

# Check logs
zbb logs show dana --tail 50

# End of day
exit
```

### Parallel environments

```bash
# Terminal 1
zbb slot load local
[zb:local]$ cd com/dana && zbb up

# Terminal 2
zbb slot create staging
zbb slot load staging
[zb:staging]$ cd com/dana && zbb up
# Different ports, different containers, no conflicts
```

### Ephemeral slot for CI

```bash
SLOT=$(zbb slot create --ephemeral --ttl 15m)
zbb slot load $SLOT
[zb:e2e-f7d1a3]$ cd com/dana && zbb up && npm test
[zb:e2e-f7d1a3]$ exit

# Slot auto-cleaned on next zbb invocation after TTL expires
```

### Debugging with env overrides

```bash
[zb:local]$ zbb env set LOG_LEVEL debug
  LOG_LEVEL: info -> debug (saved to overrides.env)

# Persists across exit/reload. Revert:
[zb:local]$ zbb env reset

# Or ad hoc (lost on exit):
[zb:local]$ export LOG_LEVEL=debug
```
