# zbb Stacks — Design Specification

> **Status:** Implemented. See `CLAUDE.md` for development guide.
> Detailed rationale, mechanics, and open questions.
> Start with the [User Guide](stacks-guide.md) for concepts, commands, and manifest format.

## Environment: Three-Layer Model

Today's env system tangles schema, values, and provenance. With stacks, these are cleanly separated per stack:

### Layer 1: Schema (in `zbb.yaml`)

What vars exist, their types, formulas, descriptions. Checked into source control, part of the stack's contract.

```yaml
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

### Layer 2: Manifest (per-stack, in slot)

How each var got its value. **Source of truth.** Changing the manifest recalculates `.env`.

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
  alias: null
```

### Layer 3: `.env` (per-stack, in slot)

Plain key=value. Computed output. **Never edited directly.**

```
DANA_PORT=15001
DANA_URL=http://localhost:15001
SERVER_URL=https://custom.example.com
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

`zbb env set FOO bar` writes to manifest as `resolution: override`. Then `.env` recalculates. No separate `overrides.env`.

### Resolution Precedence

1. Override (user set via `zbb env set`)
2. Imported (from dependency stack)
3. Inherited (from parent shell, `source: env`)
4. Generated (secrets, `generate: rsa:2048`)
5. Allocated (ports)
6. Derived (formula from `value:` field)
7. Default (literal from `default:` field — computed once, frozen)

### `value` vs `default`

```yaml
DANA_URL:
  value: "http://localhost:${DANA_PORT}"     # formula — recomputes when DANA_PORT changes

CUSTOM_SETTING:
  default: "http://localhost:${DANA_PORT}"   # default — computed once at stack add, frozen
```

Override wins over both.

### `zbb env explain`

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
```

No more "where did this value come from?" The manifest answers every question. TUI, web UI, AI agent, or `yq` can access the same data.

## State Model

### Schema (manifest) and Instance (file)

Each stack declares a **state schema** — what state it publishes. Other stacks, tools, and scripts discover what to expect.

```yaml
# In zbb.yaml — the interface
state:
  status:
    type: enum
    values: [starting, healthy, degraded, stopped, error]
  schema_applied: { type: boolean }
  seeded: { type: boolean }
  endpoints:
    api: { type: url }
```

The **state file** is the instance — plain YAML on disk in the slot:

```yaml
# ~/.zbb/slots/local/stacks/dana/state.yaml
status: healthy
schema_applied: true
seeded: true
endpoints:
  api: http://localhost:15001
```

Like OpenAPI spec (interface) vs HTTP response (instance).

### State-Based Dependencies

```yaml
depends:
  dana:
    package: "@zerobias-com/dana@^1.2.0"
    ready_when:
      status: healthy
      schema_applied: true
```

Hub doesn't start until dana's state file satisfies conditions. File watcher detects changes — no polling.

### File IS the Interface

No SDK, no typed accessors, no library required:

```bash
yq '.status' ~/.zbb/slots/local/stacks/dana/state.yaml
```

Lifecycle commands update `state.yaml` as they progress. zbb watches the file and evaluates `ready_when` conditions.

### Lessons from node-lib

node-lib has typed accessors, exclusive-writer patterns, Joi validation. Works for dedicated consumers but AI agents and scripts consistently bypass it. For stacks, the state model is lighter:

| node-lib | stacks |
|----------|--------|
| Typed accessors (`getStatus()`) | Plain YAML read |
| SDK import required | No import — file IS interface |
| Joi validation on write | Schema in manifest, validated optionally |
| EventEmitter API | File watcher — any tool can watch |

## Shell Environment Model

### Scoped by Context

| Context | What's visible |
|---------|----------------|
| In slot, no stack | Slot vars only (`ZB_SLOT`, `ZB_SLOT_DIR`, etc.) |
| In slot + stack | Slot vars + stack's own vars + stack's resolved imports |
| Different stack | Slot vars + that stack's vars + that stack's imports |

Stacks never see each other's internal vars. Dana's `LOG_LEVEL` and Hub's `LOG_LEVEL` don't collide.

Lifecycle commands build their env from resolved stack state on disk, not from the current shell.

### cd Hook

Inside the slot subshell, a `cd` hook scopes env to the current stack:

1. `cd` fires the hook
2. Walk up directory tree for stack manifest
3. Found → combine `ZB_SLOT` to locate `~/.zbb/slots/$ZB_SLOT/stacks/$STACK/.env`
4. Source the `.env` (diff, export new, unset previous stack's vars)

No pre-computed map. Manifest file IS the marker. `ZB_SLOT` IS the pointer to resolved state.

### Shell Function

`zbb` in interactive shell is a shell function wrapping the binary (like nvm):

```bash
zbb() {
  command zbb "$@"
  local rc=$?
  case "$1" in
    env) _zbb_reload_env ;;
  esac
  return $rc
}
```

Enables `zbb env set` to update current shell. Without it, env is stale until next `cd`.

### Who Sees What

| Consumer | Calls | Env sync |
|----------|-------|----------|
| Interactive shell | Shell function | cd hook + function re-source |
| Scripts, CI | Binary directly | `--slot`/`--stack` flags |
| Gradle, child_process | Binary directly | Reads slot state from disk |
| AI agents | Binary with flags | Self-contained |

### Risks

- **Script portability** — `zbb env set` in scripts calls binary, not function. Same as nvm pattern.
- **Hook performance** — File read per `cd`. Should be <1ms. Resolution happened at `stack add` time.
- **PROMPT_COMMAND conflicts** — Append, don't replace. Check at `slot load` time.
- **Nested subshells** — Detect and warn.

## Lifecycle as Contract

The lifecycle is the abstraction boundary between stacks and build systems. Manifest declares *what*. Implementation declares *how*.

```yaml
# Gradle service          # Python service           # Go binary
lifecycle:                 lifecycle:                  lifecycle:
  build: ./gradlew build     build: pip install -e .    build: go build -o dist/app
  test: ./gradlew test       test: pytest               test: go test ./...
  start: docker compose up   start: uvicorn main:app    start: ./dist/app
  health: curl -sf ...       health: curl -sf ...       health: curl -sf ...
```

zbb doesn't care. It runs the command, checks health, reports pass/fail.

**Why this matters:**
- CI becomes stack-agnostic. `zbb build && zbb test && zbb gate` — pipeline doesn't know it's Gradle.
- SDLC pipelines compose. Dependency graph IS the pipeline graph.
- Health checks are contracts. Packaged or dev — same promise.
- Gradle is the most common lifecycle provider today, but it's an implementation detail.

## Logs

Each stack declares its log sources. `zbb logs` reads the declaration and routes to the right backend.

Single source (no name needed):
```yaml
logs:
  source: docker
  container: "${STACK_NAME}-dana"
```

Multiple sources (named):
```yaml
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

Sub-stacks declare their own logs. Parent doesn't know or care.

Supported sources: `docker`, `file`, `aws`. **[OPEN]** journald, k8s, custom command.

## Secrets and Testing

The secret inventory IS the test matrix. The pattern generalizes beyond Hub modules — any stack that needs credentials follows the same flow.

```bash
zbb stack add ./sql-module          # deps auto-resolved
zbb secret create pg host=localhost port=${PGPORT} ...
zbb secret create mssql host=mssql.ci ...
zbb test sql-module                 # runs once per secret
zbb stack remove sql-module         # cleanup hooks fire
```

Stack manifest declares secret schema:
```yaml
secrets:
  connection_profile:
    schema: connectionProfile.yml
    discovery: auto
```

CI creates different secrets than dev. Tests adapt. No code changes.

`stack remove` calls `lifecycle.cleanup` hooks — removes containers, log files, fixtures. Dependencies stay if shared.

## Slot Directory Structure

```
~/.zbb/slots/local/
  slot.yaml                    # slot metadata (portRange, created, ephemeral)

  stacks/
    dana/
      stack.yaml               # resolved identity (name, version, mode, source path)
      manifest.yaml            # Layer 2: provenance — source of truth
      .env                     # Layer 3: computed output
      state.yaml               # runtime state (status, schema_applied, etc.)
      logs/
      state/
        secrets/
    hub/
      stack.yaml
      manifest.yaml
      .env
      state.yaml
      logs/
      state/

  config/                      # slot-level shared config
  logs/                        # slot-level logs (cross-cutting)
  state/                       # slot-level state (cross-cutting)
```

## SystemD-like Properties

- **Dependency ordering** — `zbb start hub` starts postgres → dana → hub
- **State-based readiness** — `ready_when` conditions, not just "running"
- **Stop ordering** — reverse of start
- **File-based observation** — filesystem watches, not polling

## Open Questions

### Resolved

| Question | Decision |
|----------|----------|
| Namespace mechanics | Bare imports with `as` aliasing. One var per import. |
| Explicit vs implicit exports | Explicit only. Encapsulation. |
| Collision handling | Error at `stack add`. Must alias. |
| Shell env scoping | Three layers: slot → stack + imports. Scoped by cwd. |
| Shell sync | cd hook + shell function. Non-interactive uses binary. |
| Activation model | cd hook in subshell. `--slot`/`--stack` flags for non-interactive. |
| Sub-stack exports | Yes. Parent exports = union. |
| Intra-stack deps | Yes. Start ordering within a stack. |
| Lifecycle as contract | Shell commands. Build system is impl detail. |
| Lifecycle env | Built from disk, not current shell. |
| Env three-layer model | Schema → Manifest → .env. Manifest is source of truth. |
| Flat slot .env | Replaced by per-stack .env. cd hook scopes. |
| `value` vs `default` | `value` = live formula. `default` = frozen. Override wins. |
| Resolver functions | Become declared formulas. Code-only resolvers are invisible. |
| Entering a stack | Not a subshell. cd hook scopes env. |
| Secrets/testing | Secret inventory = test matrix. Stack lifecycle owns cleanup. |

### Still Open

**Naming & Format**
- Package format: npm tarball? Stacks aren't JS libraries but npm infra exists.
- Version source: `package.json` (like today)?

**Lifecycle Details**
- Command format: strings for most, structured for health? Or structured everywhere?
- Packaged stacks omit build/test: implicit or explicit mode field?
- Stop with dependents running: warn + `--force`? `--cascade`?
- Restart policies: defer?

**Composition**
- Postgres: shared leaf stack or owned by consumer?
- Packaged → dev switch in place or remove + re-add?

**State**
- Exclusive writer per state file, or any process can write?
- Schema validation on write: always, optional, never?
- State history: current-only or transition log?
- Complex transforms (`http→ws`): formula syntax or registered functions referenced in manifest?
- Resolution precedence: is the 7-level order right?

**Secrets**
- Auto-validate secret shape against manifest schema?
- Auto-create template secrets on `stack add`?

**Distribution**
- What exactly in the tarball?
- Simple stacks (postgres): image ref directly, no compose?

**Shell**
- Other log sources: journald, k8s?

**Migration**
- Incremental adoption path for existing projects?
- Legacy flat-env projects coexisting with stacks?
