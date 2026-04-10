# Monorepo Build/Gate/Publish — Behavior Spec

This document is the **behavior contract** for the new Gradle-based monorepo plugins
(`zb.monorepo-*`) that replace the TypeScript implementation in
`org/util/packages/zbb/lib/monorepo/`.

The Kotlin implementation may take a different code path than the TS, but the
**observable behavior** must match (commands, outputs, on-disk artifacts, exit
codes). Where this doc and the TS source disagree, **TS source is authoritative**
until the migration is validated.

**Status:** Phase 1 (discovery). Not yet implemented.

---

## 1. Architectural goal

- `zbb` stays a thin wrapper. It owns slot/stack/env (loading slots, applying
  cleanse, preflight checks, vault secrets, env injection, registry guard).
- Gradle is the under-the-hood driver. All build/test/gate/publish logic for
  monorepos lives in Gradle plugins under `build-tools`.
- Users always run `zbb build`, `zbb gate`, `zbb publish`. They do **not** run
  `./gradlew` directly. Plugin code may assume it is invoked through zbb with
  a clean env and a loaded slot.

---

## 2. Plugin layout

```
build-tools/src/main/kotlin/
  zb.monorepo-settings.gradle.kts    # settings plugin — reads workspaces, includes subprojects
  zb.monorepo-base.gradle.kts        # per-subproject conventions, exposes graph metadata
  zb.monorepo-build.gradle.kts       # clean / build / test / docker phases
  zb.monorepo-gate.gradle.kts        # gate stamp computation, validation, write
  zb.monorepo-publish.gradle.kts     # publish flow + Kotlin prepublish-standalone
  com/zerobias/buildtools/monorepo/
    Workspace.kt                     # workspace discovery, dep graph
    ChangeDetector.kt                # git diff → affected packages
    Prepublish.kt                    # Kotlin port of prepublish-standalone.js
    DockerSemaphore.kt               # BuildService capping docker concurrency
    EventListener.kt                 # BuildEventListener emitting JSON-line events for zbb display
```

**Note:** Gate stamp logic does NOT live in `monorepo/`. It already exists in
`zb.base.gradle.kts` (`hashFiles`, `checkGateStamp`, `writeGateStamp`,
`countExpectedTests`). Phase 2.1 updates that existing code in place — see §6.

`-build`, `-gate`, `-publish` each transitively apply `-base`. Repos opt in by
applying whichever subset they need; today every repo uses all four.

### How a repo wires it up

`settings.gradle.kts`:
```kotlin
plugins {
    id("zb.monorepo-settings")
}
```

The settings plugin reads `package.json` `workspaces`, expands globs, and calls
`include(":<package-rel-path>")` for each one. Each npm package becomes a real
Gradle subproject.

Root `build.gradle.kts`:
```kotlin
plugins {
    id("zb.monorepo-base")
    id("zb.monorepo-build")
    id("zb.monorepo-gate")
    id("zb.monorepo-publish")
}
```

The base plugin auto-applies its conventions to every subproject via
`subprojects { ... }`. No per-package `build.gradle.kts` is required.

---

## 3. Workspace discovery & dependency graph

**Source:** `lib/monorepo/Workspace.ts`

### Discovery
1. Read root `package.json`. Fail if `workspaces` field is missing or empty.
2. For each entry in `workspaces`:
   - If it contains `*`, expand the glob (`glob.sync(pattern, { cwd: repoRoot })`).
   - Otherwise treat as a literal directory.
   - Each candidate must contain a `package.json`.
3. For each workspace package, capture: `name`, absolute `dir`, relative `relDir`,
   `version`, `private`, `scripts`, raw `packageJson`.

### Internal deps
A package's "internal deps" are the union of `dependencies` and `devDependencies`
keys whose names are also workspace package names.

### Dependency graph
- Forward graph: `name → internal deps` (built from internalDeps).
- Reverse graph (`dependents`): `name → packages depending on it`.
- Build order: Kahn's BFS topo sort (leaves first). Cycles must throw with the
  cycle members listed.

### Helpers
- `getTransitiveDependents(name)` — BFS through reverse graph, excluding self.
- `sortByBuildOrder(set)` — filter `buildOrder` to a subset, preserving order.

### Gradle mapping
Each workspace package becomes a Gradle subproject. Internal deps map to
`dependsOn` between phase tasks across subprojects, e.g. `:foo:transpile`
depends on `:bar:transpile` if `foo` depends on `bar`. Gradle's task scheduler
handles concurrency and ordering — no hand-rolled scheduler is needed.

---

## 4. Change detection

**Source:** `lib/monorepo/ChangeDetector.ts`

### Base ref resolution
- If `--base <ref>` is passed: use that ref.
- Else if branch is `main` or `master`: diff against the **last commit that
  touched `gate-stamp.json`** (`git log -1 --format=%H -- gate-stamp.json`),
  fallback to `HEAD~1` if no such commit exists.
- Else (feature branch): diff against `origin/main`.

### File set
Union of:
- `git diff --name-only baseRef...HEAD` (committed changes)
  - Fallback: `git diff --name-only baseRef HEAD` (when `...` syntax fails)
- `git diff --name-only HEAD` (unstaged working tree)
- `git diff --name-only --cached` (staged)

The uncommitted files are critical — devs running `zbb gate` must see their
in-progress changes, not just committed ones.

### File-to-package mapping
- Skip `gate-stamp.json` itself.
- Root-level files (no `/`):
  - `tsconfig.json`, `.zbb.yaml` → invalidate **all** packages.
  - `package.json`, `package-lock.json` → trigger root-pkg targeted analysis.
- Other files: match against the longest package `relDir` prefix (sort by length
  descending so nested packages match first). The matched package goes into the
  `changed` set.

### Root package.json targeted analysis
When root `package.json` changes:
1. Read root `package.json` at `baseRef` (`git show baseRef:package.json`) and at HEAD.
2. Compute the symmetric difference of `dependencies + devDependencies + overrides`
   keys → `changedDeps` set (packages with added/removed/version-changed entries).
3. For each workspace package, run `prepublish-standalone --dry-run` to get its
   resolved root deps. If any of `changedDeps` appear in the resolved set, the
   package is added to `changed`.

This avoids full-repo invalidation when only one root dep changes (e.g., bumping
a build tool used by only one package).

### Affected expansion
- Start with `changed`.
- For each, BFS through reverse graph and add all transitive dependents.
- **Also** add any workspace package that lacks a `dist/` directory (handles the
  "I cleaned but didn't rebuild" case so the next gate run rebuilds it).
- Sort by `buildOrder`.

### `--all` flag
Skip detection entirely; affected = all packages, baseRef = `"N/A (--all)"`.

### Gradle mapping
A `MonorepoGraphService` (BuildService) computes the affected set once per build
invocation (parameterized with `--base` / `--all`) and exposes it to all phase
tasks. Tasks check `affectedSet.contains(project.path)` in `onlyIf {}`.

---

## 5. Phases

**Source:** `lib/monorepo/Builder.ts` and `lib/monorepo/index.ts`

### Phase definitions
- `clean` — always runs on all packages (ignores affected set). Removes
  `dist/`, `generated/`, `build/`, `tsconfig.tsbuildinfo`, plus npm `clean`
  script if defined. Also cleans Docker build contexts and root-level artifacts.
- `build` — runs `lint`, `generate`, `transpile` (override via `monorepo.buildPhases`
  in `.zbb.yaml`), then `docker` if `monorepo.images` is configured and
  `--skipDocker` is not set.
- `test` — runs `monorepo.testPhases` (default `['test']`).
- `gate` — runs all build phases + test phases sequentially per package, then
  writes `gate-stamp.json`. Always runs on all packages (forces `--all`).
- `publish` — has its own version-based change detection, see §7.

### Phase rules
- Within a phase, packages run **concurrently** respecting dependency order. A
  package starts when all its internal deps (within the affected set) have
  completed. Lint is special: it ignores deps so all packages can lint in
  parallel.
- Across phases, phases run **sequentially** (clean → build → test → docker).
- A package is included in a phase only if it has a non-empty npm script for
  that phase (skipping `echo ...` placeholder scripts).
- A failed phase aborts the run immediately. Captured stdout/stderr is printed
  for the failing package.

### Build cache (`.zbb-build-cache.json`)
- Stored at repo root, gitignored.
- Schema: `{ packages: { [name]: { sourceHash, phases: { [phase]: status } } } }`.
- Per-phase caching: a phase is cached if (a) the package's source hash matches,
  (b) the phase's recorded status is passed/skipped/not-found, and (c) all
  internal deps' source hashes also match (skipped for `lint`).
- Source hash change resets all phases for that package.
- Cache is written immediately after each phase so partial successes survive
  later failures.

### Docker phase
- Identified by `monorepo.images` map in `.zbb.yaml` keyed by `relDir`.
- Built concurrently but capped: max 2 concurrent docker builds by default,
  override via `DOCKER_BUILD_CONCURRENCY` env var.
- After build, run `docker image prune -f` to clean dangling layers.
- Has its own cache phase (`'docker'`) in the build cache.

### Gradle mapping
- Each phase becomes a Gradle task type (`LintTask`, `GenerateTask`,
  `TranspileTask`, `TestTask`, `DockerBuildTask`).
- One instance per subproject; `dependsOn` wires the npm dep graph.
- Cross-phase ordering uses `mustRunAfter` so all `lint` tasks finish before
  `transpile` starts within a project, but parallelism across projects is
  preserved.
- Gradle's incremental build + build cache replaces `.zbb-build-cache.json`.
  - Inputs: declared source files, deps' outputs.
  - Outputs: `dist/`, `generated/`, `build/`, marker files.
  - The legacy `.zbb-build-cache.json` is NOT written by the new path. (Open
    question: should we keep it for parity testing? See §13.)
- Docker phase uses `DockerSemaphore` BuildService to cap concurrent execution
  (per-build scope, honors `DOCKER_BUILD_CONCURRENCY`).

### "Waiting on deps" display
The TS impl shows in-place TTY updates: each package gets one line that cycles
spinner → check/cross. Pending packages display `← waiting on dep1, dep2`.

**Decision (OQ7):** This display **stays in zbb's TS code** and is fed via a
JSON-line event bridge from the Gradle plugin's `BuildEventListener`. The
`zb.monorepo-base` plugin emits structured events; zbb tails them and feeds
into the existing `Builder.runPhaseConcurrently` rendering loop. See §14 OQ7
for the architecture.

---

## 6. Gate stamp

**Source (TS):** `lib/monorepo/GateStamp.ts`
**Source (existing Kotlin):** `zb.base.gradle.kts` lines ~736-1000

**Critical context:** `zb.base.gradle.kts` already contains a complete gate
stamp implementation in Kotlin (`hashFiles`, `checkGateStamp`, `writeGateStamp`,
`countExpectedTests`, `GateStampResult` enum). The TS code in
`lib/monorepo/GateStamp.ts` is a **port of this existing Kotlin** (the source
comment confirms "ported from zb.base.gradle.kts hashFiles"). Phase 2.1
**updates the existing Kotlin** to match the TS-era improvements rather than
writing new Kotlin code.

**Diffs the TS code added that need backporting:**
1. Use `git ls-files` instead of `walkTopDown` for source hashing (determinism
   between local/CI — the critical fix made during TS development).
2. Add `rootDeps` field to stamp entries (see §8 + §11), captured at write time
   via in-process `Prepublish.kt`.
3. Switch state model from `FULL/SOURCE/TESTS_CHANGED/INVALID` to
   `VALID/TESTS_CHANGED/TESTS_FAILED/INVALID/MISSING` (richer failure modes).
4. Replace regex-based JSON parsing with real JSON parse (use `kotlinx.serialization`
   or similar — must be careful about preserving the exact byte format on write).
5. Make `sourceFiles` and `sourceDirs` configurable from `.zbb.yaml`
   `monorepo` block (today they're hardcoded `["api.yml", "tsconfig.json"]`
   and `["src"]`).
6. Change stamp scope: write a single unified `gate-stamp.json` at the **repo
   root** with all packages (not per-project as today's Kotlin does). The root
   stamp aggregator collects per-subproject contributions via Gradle Providers.

### File format
`gate-stamp.json` at repo root, **committed to git**, written by `zbb gate`:

```json
{
  "version": 1,
  "branch": "feature/foo",
  "timestamp": "2026-04-08T...",
  "packages": {
    "@zerobias-com/foo-core": {
      "version": "1.2.3",
      "sourceHash": "<sha256 hex>",
      "testHash": "<sha256 hex>",
      "rootDeps": { "lodash": "^4.17.21", "tslib": "^2.0.0" },
      "tasks": { "lint": "passed", "transpile": "passed", "test": "passed" },
      "tests": {
        "unit": { "expected": 12, "ran": 12, "status": "passed" }
      }
    }
  }
}
```

### Source hashing (`computeSourceHash`)
- Algorithm: SHA-256.
- Inputs (in order):
  - `sourceFiles` (default `['tsconfig.json']`, configurable in `.zbb.yaml`):
    For each file, only include it if `git ls-files --error-unmatch <name>`
    returns non-empty output (i.e. the file is git-tracked). This is
    critical — it prevents hash drift between local (where untracked
    generated files exist) and CI (where they don't).
    Update format: `digest.update(name); digest.update(fileBytes)`.
  - `sourceDirs` (default `['src']`, configurable):
    Use `git ls-files <dirName>` to get the file list (deterministic, ignores
    `.gitignore`). Sort lexicographically. Skip files listed by git but absent
    on disk (sparse checkout, deletes). For each file:
    `digest.update(relPath); digest.update(fileBytes)`.

### Test hashing (`computeTestHash`)
- Same algorithm, but walks `test/` recursively (not git-restricted).
- `walkDir` skips `node_modules` and any `.<hidden>` directory.
- Sort by relative path lexicographically.
- Update format: `digest.update(relPath); digest.update(fileBytes)`.

### Test counting (`countExpectedTests`)
- Regex: `/(?:^|\s)(?:it|it\.only|test)\s*\(/` per line.
- Counts in `.ts` and `.js` files only.

### Stamp validation (`validatePackageStamp`)
Per-package, returns one of:
- `MISSING` — no stamp file or no entry for this package.
- `INVALID` — sourceHash mismatch, OR rootDep version drift, OR a non-test build
  task failed.
- `TESTS_CHANGED` — source ok but testHash changed.
- `TESTS_FAILED` — source ok, testHash ok, but a test task failed last run, OR
  any test suite has `expected > 0` and status is not passed/skipped.
- `VALID` — everything matches.

Detailed checks:
1. Compare `sourceHash` to current hash. Mismatch → `INVALID` (print diff).
2. If `rootDeps` is present, read root `package.json` and check each entry.
   The stored value can come from `dependencies`, `devDependencies`, or
   `overrides` (overrides stored as `JSON.stringify(value)`). Mismatch → `INVALID`.
3. Walk `tasks`. For each task whose status is not passed/skipped/not-found:
   - If task name is in `testPhases`, mark `testTaskFailed`.
   - Else mark `buildFailed`.
4. If `buildFailed` → `INVALID`.
5. Compare `testHash` to current. Mismatch → `TESTS_CHANGED`.
6. If `testTaskFailed` → `TESTS_FAILED`.
7. Walk `tests`. Any suite with `expected > 0` and status ∉ {passed, skipped}
   → `TESTS_FAILED`.
8. Else → `VALID`.

### `gate --check` (CI pre-flight)
- Cheap, no Vault/Postgres/Docker required.
- Loads stamp, validates each affected package, exits 0 if all `VALID`, else 1.
- Prints per-package result with ✓/✗ and the failure reason.
- This is the primary CI optimization — see §10.

### Stamp write
- Built after a successful gate run.
- For each non-private package: `version`, `sourceHash`, `testHash`, `tasks`,
  `tests`, plus `rootDeps` resolved via in-process Kotlin
  `Prepublish.resolveRootDeps()` (no node subprocess — see §11).
- Written as JSON with 2-space indent and a trailing newline. The trailing
  newline matters for byte-equality with the TS path.

### Registry guard
Before writing the stamp, check if a slot is loaded with locally-published
registry packages (`~/.zbb/slots/<slot>/stacks/registry/publishes.json` exists
and is non-empty). If so, abort with an error pointing the user at
`zbb registry clear`. Reason: stamp would otherwise capture a build that
includes Verdaccio-published artifacts, which would not reproduce on CI.

### Gradle mapping
- Per-subproject gate logic stays in `zb.base.gradle.kts` (updated, not
  duplicated). Each subproject has its existing `gate` task; that task
  contributes its `PackageStampEntry` (sourceHash, testHash, tasks, tests,
  rootDeps) to a Provider.
- `zb.monorepo-gate` adds at the root project level:
  - `monorepoGate` — depends on `:*:gate` for all subprojects, then calls
    a `WriteRootGateStampTask` that aggregates all per-subproject Providers
    into a single `gate-stamp.json` at repo root.
  - `monorepoGateCheck` — pure read task. Loads root `gate-stamp.json`,
    validates each affected package against current source, exits 0/1.
    Declares NO build dependencies — does not invoke gate or any other task.
- Source hashing implemented (or rather, updated) in `zb.base`. Inputs
  declared via `@InputFiles` (git-tracked source files), but the actual
  hashing is custom because we need git-tracked-only semantics, not Gradle's
  default file walker.
- Hybrid approach (per Q3 decision): Gradle inputs/outputs handle in-build skip
  decisions, AND the plugin writes `gate-stamp.json` as a task output for CI's
  pre-flight `gate --check` to read without booting Gradle.

---

## 7. Publish flow

**Source:** `lib/monorepo/Publisher.ts`

### Branch guard
Must be on `main`/`master`, or pass `--force`, or `--dry-run`.

### Registry guard
Same as gate — abort if locally-published registry packages are in use.

### Stamp validation
Read `gate-stamp.json`. For each non-private workspace package:
- Run `validatePackageStamp`.
- If any return non-`VALID`, abort (or proceed with `--force`).

This is why `zbb gate` must be run and the stamp committed before publish.

### Per-package change detection (`detectPublishChanges`)
- Compares each package's `version` in HEAD vs the version at the last published
  state. Implementation detail: uses git history to find the last commit that
  changed each package's `package.json` `version` field.
- Packages whose version is newer than last published are in the publish set.
- Computes a publish order respecting dep graph (build leaves first).

### Per-package publish steps
For each package in publish order:
1. Skip if `private: true` or `monorepo.skipPublish` includes its name.
2. Run `prepublish-standalone <pkgDir> <repoRoot>` (Kotlin port in new path).
   This rewrites the package's `package.json` to include only the deps it
   actually uses, with versions resolved from root `package.json`. Original is
   backed up to `package.json.prepublish-backup`.
3. `copyStackArtifacts(repoRoot)` — see below — only for the root `stack/`
   directory, only when publishing the stack package.
4. Run the package's `publish` npm script (which typically does `npm publish`).
5. On success or failure, restore `package.json` from backup.
6. Capture: `name`, `version`, `published` flag, `location` (registry URL).

### Stack artifact handling (`copyStackArtifacts`)
- Only applies if a `stack/` directory exists at repo root.
- Copies root `zbb.yaml` → `stack/zbb.yaml` (overwrite).
- Copies root `.zbb.yaml` → `stack/.zbb.yaml` (overwrite).
- Copies root `test/` → `stack/test/` recursively (force overwrite).
- Validates `stack/zbb.yaml` contains `name:` field.
- These copies are made at publish time so the stack package tarball includes
  fresh test apparatus and config.

### Image dispatch
After successful publishes, for any package whose `monorepo.images[relDir]` has
a `workflow` field, run `gh workflow run <workflow> --repo <owner/repo> -f
version=<published-version>`. Detects GitHub repo from `git remote get-url
origin` if not configured.

### Publish report
Writes `/tmp/published-packages.json` with `[{ name, version, location }, ...]`
for downstream tooling.

### Gradle mapping
- `zb.monorepo-publish` registers `PrepublishTask`, `PublishPackageTask`,
  `CopyStackArtifactsTask`, `DispatchImageWorkflowTask`.
- The publish task graph wires these per subproject in dep order.
- `--dry-run` → no actual `npm publish`, no GitHub dispatch, no backup write.

---

## 8. Cleanse and env handling

**Source:** `lib/monorepo/index.ts` lines 184-189.

When entering any monorepo command, zbb applies `repoConfig.cleanse` (a list of
env var names from `.zbb.yaml`) by `delete process.env[name]`. This strips
problematic vars from the parent shell before spawning child processes.

**Decision (Q5):** Cleanse stays entirely in zbb. The Gradle plugin assumes a
clean env. The plugin code does NOT need to read `.zbb.yaml` cleanse fields. zbb
applies cleanse to its own `process.env` before spawning Gradle, and Gradle
inherits the cleaned env via `spawn`.

**Implication:** Users must not run `./gradlew` directly. If they need to debug
a Gradle task with the slot env, they use `zbb run -- ./gradlew <task>`.

---

## 9. Preflight

**Source:** `lib/monorepo/index.ts` `runMonorepoPreflight` and `handleMonorepo`.

### Built-in
- `node >=22.0.0`
- `npm >=10.0.0`
- `git >=2.0.0`
- `gh >=2.0.0` (only for `publish`)

### Repo-level (`require:` in `.zbb.yaml`)
- Each entry can have a `commands: [...]` field. If present, only run the check
  when the current command is in the list. If absent, the check applies to all
  commands. This is critical for repos with heavy preflight (postgres, vault,
  docker buildx) — they should not run for `publish` or `gate --check`.

### Skip preflight
- `gate --check` skips ALL preflight (it's just a JSON file read).

### Gradle mapping
Preflight stays in zbb. The plugin does not run preflight checks. zbb runs them
before invoking Gradle and bails on failure.

---

## 10. CI gate flow

**Decision (Q3 + project intent):** Two-tier gate, designed for high-paced devs.

### Workflow
1. Devs run `zbb gate` locally, fix issues, commit `gate-stamp.json` along with
   their code. The PR is "ready to merge" because the gate already passed.
2. CI runs `zbb gate --check` as the first step. This is just a JSON file read
   plus per-package source hash computation — no Vault, Postgres, Neon, Docker
   buildx, or Java needed. Fast.
3. If `--check` passes, CI skips the full gate. The PR merges.
4. If `--check` fails, CI runs the full `zbb gate` (with all the heavy
   environment setup), commits the updated stamp back to the PR branch, and
   the PR is re-evaluated.

CI's full-gate path is a **backup** for devs who couldn't get a local env
working. The local-first path is the happy path. Do not redesign CI to "always
boot Gradle and let it skip" — that wastes CI minutes and slows PR turnaround.

The Kotlin gate plugin must preserve this property: even though Gradle's own
inputs/outputs would skip work when nothing changed, the plugin must still
produce `gate-stamp.json` as a task output so the CI pre-flight step has
something to read without spinning up Gradle.

---

## 11. prepublish-standalone — Kotlin port

**Source:** `org/devops/tools/scripts/prepublish-standalone.js` (1081 lines).

This is the most complex piece of the migration. The Kotlin port must produce
**byte-identical output** to the bash/JS script for any given input. The bash
script stays alive for legacy (non-zbb-monorepo) callers; new monorepo flows
use the Kotlin path.

### Input
- `serviceDir` — package directory being prepublished.
- `rootDir` — monorepo root.
- Flags: `--dry-run`, `--restore`, `--include-build-tools`, `--library` (deprecated),
  `--target-dir=<dir>`.

### Output
- Modified `package.json` (or `--target-dir/package.json` if specified).
- `package.json.prepublish-backup` (unless `--target-dir`).
- Stdout report of what was added/found/missing.

### Source scanners (collect package names)
All scanners feed into one `requiredDeps` set.

#### `scanImports(serviceDir)`
- File extensions: `.ts`, `.js`, `.mts`, `.mjs`.
- Skip dirs: `node_modules`, `dist`, `.git`, `coverage`, `test`, `tests`, `__tests__`.
- Regexes (run all three on each file):
  - `\bfrom\s+['"]([^'"]+)['"]` — ES6 import with `from` clause.
  - `\bimport\s+['"]([^'"]+)['"]` — bare/side-effect imports.
  - `\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)` — CommonJS require.
- Extract package name:
  - Skip relative (`.`, `/`) and `node:` protocol.
  - Scoped (`@scope/pkg`): take first 2 path segments.
  - Unscoped (`pkg`): take first segment.
- Also scan `package.json.files` array for direct `.ts/.js/.mts/.mjs` files at
  the package root, and `package.json.main` if it's a JS/TS file.

#### `scanShellScripts(serviceDir)`
- Only `.sh` files in `src/`, `scripts/`, and at the package root.
- Regexes (case-insensitive):
  - `node_modules/(@scope/pkg|pkg)`
  - `\$\{?VAR\}?/(@scope/pkg)` — variable-based paths
  - `(?:^|[\s"'])@scope/pkg(?:[\s"'\n]|$)` — bare scoped names in lists
  - `npx (?:node )?(?:\$VAR/)?(?:node_modules/)?(@scope/pkg|pkg)` — npx invocations
- Each match validated by `isValidPackageName`.

#### `extractScriptDependencies(packageJson.scripts, binMap)`
- Parses each npm script command, split by `;`, `&`, `|`.
- For each part:
  - `npx (?:--flag )*(<pkg>)` → if pkg is in binMap, use binMap mapping; else
    extract package name (scoped or unscoped); skip if it starts with `-` or `.`.
  - `node_modules/.bin/<tool>` → look up in binMap.
  - Leading `^([a-zA-Z][-a-zA-Z0-9]*)` → look up in binMap.
  - `node --import <pkg>` → extract package name.
- See `binMap` discovery below.

#### `scanConfigFiles(serviceDir)`
- File patterns: `eslint.config.{js,mjs,cjs}`, `.eslintrc.{js,cjs,mjs}`,
  `prettier.config.{js,mjs}`, `.prettierrc.{js,cjs}`.
- Same regex set as `scanImports`.

#### `scanYamlFiles(serviceDir)`
- All `.yml`/`.yaml` files, recursively, skipping `node_modules`, `dist`, `.git`,
  `coverage`.
- Looks for `extends:` directives:
  - Multi-line array form: lines after `extends:` like `  - "@scope/pkg"`.
  - Single-string form: `extends: "@scope/pkg"`.
- Skips entries containing `:` (e.g., `spectral:oas` is a built-in).
- Skips relative paths.

### `binMap` (`discoverBinMappings`)
- Walk `<rootDir>/node_modules`. For each package:
  - Read its `package.json`.
  - If `bin` is a string: command name = package name without scope.
  - If `bin` is an object: each key is a command name → maps to the package.
- Scoped packages: walk `node_modules/@scope/*` subdirectories.
- Plus a hardcoded `BIN_PACKAGE_OVERRIDES` Map (currently empty).

### `isValidPackageName(name)`
- Must not start with `.`, `-`, `$`.
- Must not contain shell special chars: `"`, `'`, `;`, `|`, `&`, `=`, `[]`, `()`, `{}`.
- Scoped: `@scope/pkg` where scope matches `^[a-z0-9][-a-z0-9]*$` and pkg matches
  `^[a-z0-9][-a-z0-9._]*$`.
- Unscoped: `^[a-z0-9][-a-z0-9._]*$`.

### Implicit deps
- If `packageJson.name` contains `eslint-config`: add `eslint`,
  `@typescript-eslint/eslint-plugin`, `@typescript-eslint/parser`,
  `eslint-plugin-unicorn`.
- If `packageJson.name` contains `prettier-config`: add `prettier`.

### Hardcoded `PACKAGE_ADDITIONAL_DEPS`
- `@zerobias-org/util-api-client-base` → `[qs]`.
- (Add new entries here if needed; they exist because codegen templates import
  things that aren't visible in source scanning.)

### `IGNORED_PACKAGES`
Skip: `src`, `dist`, `test`, `scripts`, `node`, `bin`, `sdk`, `api`, `lib`, `generated`.

### Workspace transitive expansion
For each entry in `requiredDeps` that is itself a workspace package, recursively
add its `dependencies` keys (only `dependencies`, not `devDependencies`). Use a
`visited` set to avoid cycles.

### Build tools skip rule
- Default: skip build tools (don't scan scripts, don't scan shell unless
  files-array contains `.sh`).
- Override: `--include-build-tools` flag, OR `packageJson.zerobias['import-artifact']
  === 'service'`.

If skipping, do NOT scan `package.json.scripts` for deps. Only scan shell scripts
if the `files` array indicates shell scripts are runtime artifacts (entries
ending with `.sh` or matching `*.sh`).

### Resolution priority (per required dep)
For each pkg in `requiredDeps`, in order:
1. If in `IGNORED_PACKAGES`: skip.
2. If pkg == `packageJson.name`: skip (no self-dep).
3. If in `workspacePackages` map: use that workspace package's version.
4. If in `rootDeps` (root `package.json` `dependencies`): use that version.
5. If in `rootDevDeps`: use that version (marked "dev" in report).
6. If in Node.js builtins (`fs path http https crypto stream url util os
   child_process events assert buffer net tls dns readline zlib`): skip.
7. If in `existingDeps` (the package's existing `dependencies`): preserve.
8. Else: report as missing (warning, not error).

### Output rendering
- `dependencies`: sorted alphabetically by key.
- `devDependencies`: deleted from output entirely.
- `overrides`: copied verbatim from root `package.json` if present.
- File written as `JSON.stringify(outputPackageJson, null, 2) + '\n'`.

### `--restore`
Copy `<file>.prepublish-backup` → `<file>`, delete the backup. No-op if backup
doesn't exist.

### `--target-dir`
- Output goes to `<targetDir>/package.json` instead of overwriting source.
- If the target file exists, merge into it (preserve `exports`, `typings`, etc.).
- No backup is written (we're not modifying source).

### Gradle mapping
- `Prepublish.kt` in `build-tools` implements all the above as a plain Kotlin
  class (not a Gradle task). It exposes a `resolve(serviceDir, rootDir,
  options)` function returning a `PrepublishResult` data class with
  `dependencies`, `overrides`, `addedDeps`, `missingDeps`.
- Two callers consume `Prepublish.kt`:
  1. **`PrepublishTask`** (per subproject, in `zb.monorepo-publish`) — calls
     `Prepublish.resolve()` and writes the modified `package.json`. Used during
     the publish flow.
  2. **`zb.base writeGateStamp` task** — calls `Prepublish.resolveRootDeps()`
     to capture the `rootDeps` snapshot in the gate stamp. In-process call,
     no node subprocess.
- `PrepublishTask` declared inputs:
  - All TS/JS source files (matching scan patterns)
  - All `.sh` files in `src/`, `scripts/`, root
  - All YAML files
  - Config files at root
  - `package.json` and root `package.json`
  - `node_modules/` (for binMap discovery — directory only, lazy)
- Output: the modified `package.json`.
- Followed by `PublishPackageTask.finalizedBy(RestorePrepublishTask)` per OQ8.
- The `.prepublish-backup` file is a side effect, not declared as a task
  output (transient working file, gitignored).

### Critical: parity testing
The Kotlin port is the highest-risk piece. Required test approach:
- Fixture corpus: collect representative packages from all 6 production repos
  (com/util, com/hub, com/dana, com/hydra-service, com/fileservice, com/platform)
  covering edge cases below.
- For each fixture, run BOTH bash and Kotlin paths and assert byte-identical
  `package.json` output.
- Edge cases to cover:
  - Scoped vs unscoped packages
  - `workspace:*`, `workspace:^`, `workspace:~` (currently unhandled — confirm
    behavior)
  - peerDependencies (not currently included, confirm)
  - optionalDependencies (not currently included, confirm)
  - Missing root deps (the "missing" report)
  - Multiple version range types (`^`, `~`, exact, ranges, `git+...`)
  - Implicit-deps packages (eslint-config-*, prettier-config-*)
  - Hardcoded additional-deps packages (`util-api-client-base`)
  - `--target-dir` mode with existing target file
  - `--include-build-tools` mode
  - Packages with shell scripts in `files` array
  - Workspace transitive expansion (nested workspace deps)
  - Cycles in workspace deps
  - YAML extends (single string and array forms)
  - Multi-line ES6 imports
  - CommonJS require
  - Bin command discovery (single-string bin and object bin)

---

## 12. Routing layer in zbb

**Decision (Q7):** Default to the new Gradle path. `ZBB_USE_LEGACY_MONOREPO=1`
environment variable forces the legacy TS path as an escape hatch.

Implementation in `lib/monorepo/index.ts`:
- At the top of `handleMonorepo`, check `process.env.ZBB_USE_LEGACY_MONOREPO`.
- If set: continue with the existing TS code path.
- Else: invoke Gradle via `execFileSync('./gradlew', [...])` with the same
  command name (e.g. `./gradlew monorepoBuild --no-daemon`). The Gradle plugin
  picks up affected/all/base/dry-run/force/check/skipDocker via `-P` properties.

The TS code path stays alive in the tree until phase 7 (post-cutover cleanup,
~1-2 months after all 6 repos validated).

---

## 13. Parity validation

**Decision (Q8):** New `zbb monorepo verify-parity` command.

For a given repo:
1. Run the legacy path (`ZBB_USE_LEGACY_MONOREPO=1 zbb gate`). Capture
   `gate-stamp.json` content + per-package `prepublish-standalone --dry-run`
   output.
2. Run the new path (default). Capture the same artifacts.
3. Diff:
   - **A**: `gate-stamp.json` byte-for-byte (after sorting top-level keys for
     stability).
   - **B**: `npm pack --dry-run` output for each non-private package — extract
     listed files + sizes, diff.
4. Report drift. Exit non-zero if any drift detected.

Run this per repo before merging the migration PR. Stays around as a safety net
through phase 6, deleted in phase 7.

### Implementation
- Lives in `org/util/packages/zbb/lib/monorepo/VerifyParity.ts`.
- Knows how to invoke both paths and diff outputs.
- Not a Gradle task — it's a zbb-side command that orchestrates both paths.

---

## 14. Resolved implementation decisions

All 10 open questions resolved during Phase 1 design walkthrough.

### OQ1 — Settings plugin replaces manual includes
**Decision:** The settings plugin reads `package.json` workspaces and calls
`include()` for every workspace package. Existing manual `include(...)` lines
in `settings.gradle.kts` are deleted during each repo's migration PR. Curation
moves to `private: true` (in package.json) or `monorepo.skipPublish` (in
`.zbb.yaml`).

**Repo-specific notes:**
- `com/util` has no `settings.gradle.kts` today — create one.
- `com/fileservice` has a `settings.gradle.kts` but no `pluginManagement`
  block — add one during its migration PR.
- All other repos: replace existing `include(...)` block with the settings
  plugin invocation.

### OQ2 — Subproject naming mirrors relDir
**Decision:** Use `relDir` with `/` → `:`.

| relDir | Gradle path |
|---|---|
| `core` | `:core` |
| `packages/dynamodb` | `:packages:dynamodb` |
| `utils/query-builder` | `:utils:query-builder` |
| `content/src/rbac` | `:content:src:rbac` |

Matches what `com/platform` already does. Collision-free by construction.

### OQ3 — Task names: per-subproject from zb.base, root from monorepo plugin
**Decision:**
- Per-subproject task names stay as-is from `zb.base`: `clean`, `lint`,
  `compile`, `test`, `gate`, `writeGateStamp`, `publish`, etc.
- Root-level orchestrator tasks added by `zb.monorepo-base`:
  - `monorepoClean` → wires `:*:clean`
  - `monorepoBuild` → wires `:*:build` (filtered by affected set)
  - `monorepoTest` → wires `:*:test`
  - `monorepoGate` → wires `:*:gate` + root-level stamp aggregator
  - `monorepoGateCheck` → reads root stamp file, validates per-package, exits 0/1
  - `monorepoPublish` → wires `:*:publish` + prepublish + stack copy + image dispatch
- zbb routing layer maps zbb commands → Gradle tasks one-to-one.

**Critical sub-decision:** `zb.base` is **updated**, not duplicated. The new
monorepo plugin does NOT register its own gate logic — it wires the existing
`zb.base` gate task into a unified root stamp aggregator. The TS code in
`lib/monorepo/GateStamp.ts` is essentially a port of the existing
`zb.base.gradle.kts` Kotlin (the source comment confirms this). Phase 2.1
backports the TS-era improvements into `zb.base` directly.

**Stamp scope decision:** Single unified `gate-stamp.json` at repo root only.
Per-package stamps (today's `zb.base` per-project model) are deleted from
existing repos during their migration PR.

### OQ4 — Drop .zbb-build-cache.json
**Decision:** Drop it entirely. Trust Gradle's up-to-date checks and build
cache. Existing files in repos are deleted during migration PRs (already
gitignored).

### OQ5 — Let Gradle interleave (no phase barriers)
**Decision:** No artificial `mustRunAfter` between phases. Each subproject's
task chain runs as soon as its internal deps are satisfied. Maximum parallelism.

Parity validation (§13) compares **outcomes** (gate-stamp.json byte equality,
tarball contents), not task execution order. Order will differ — that's expected
and fine.

### OQ6 — Parse mocha stdout for test counts
**Decision:** Continue parsing mocha output for passing/failing/pending counts.
Each test task captures stdout, runs the regex, attaches counts as a task
output property. The root stamp aggregator reads these properties when writing
gate-stamp.json. No package-level changes required.

### OQ7 — Display stays in zbb via JSON-line event bridge
**Decision:** The rich TTY display (per-package spinners, elapsed time,
"waiting on deps", phase headers) **stays in zbb's TypeScript code** —
specifically in `Builder.ts runPhaseConcurrently`. It does NOT get
reimplemented in Kotlin or sacrificed to Gradle's console renderer.

**The bridge architecture:**
- `zb.monorepo-base` registers a `BuildEventListener` (Kotlin, ~50 lines)
  subscribed to Gradle task lifecycle events.
- For each event, write a JSON line to a side channel (e.g.
  `/tmp/zbb-monorepo-events.jsonl`, or stderr line-prefixed).
- Event format:
  ```json
  {"event":"phase_start","phase":"transpile","packages":["foo","bar"]}
  {"event":"task_start","phase":"transpile","package":"foo","blockers":[]}
  {"event":"task_done","phase":"transpile","package":"foo","status":"passed","durationMs":1234}
  {"event":"phase_done","phase":"transpile","results":{"foo":"passed","bar":"cached"}}
  ```
- zbb spawns `./gradlew monorepo*`, tails the event stream, feeds events into
  the existing `Builder.runPhaseConcurrently` display loop. The display code
  stays mostly unchanged — only the input source changes from "spawn npm
  process" to "consume next event".

**Bonus deliverable:** `zbb monorepo timeline` command that pretty-prints the
saved event stream post-hoc. Same data, different consumer.

**Phase 7 cleanup notes:** Do NOT delete `Builder.ts runPhaseConcurrently`
rendering code. Only the npm-spawning + scheduling parts go away. The display
parts (spinner frames, color codes, in-place updates, "waiting on" text,
pad/sn/elapsed helpers) stay forever.

### OQ8 — Three tasks for prepublish lifecycle
**Decision:** `PrepublishTask` + `PublishPackageTask` + `RestorePrepublishTask`,
with `PublishPackageTask.finalizedBy(RestorePrepublishTask)`.

- `RestorePrepublishTask` is **idempotent** — if no `.prepublish-backup` exists,
  no-op. Crash-safe across runs (next run picks up any leftover backup).
- The backup file is gitignored already (`*.prepublish-backup` in `.gitignore`).
- Don't declare the backup as a `@OutputFile` for build cache purposes —
  treat it as a side effect. Use `outputs.upToDateWhen { false }` if needed.

### OQ9 — rootDeps resolved at write time, in-process Kotlin
**Decision:** Resolve `rootDeps` at stamp WRITE time, validate at READ time.
Match the TS design. **One refinement:** Kotlin port calls `Prepublish.kt`
in-process (no `node` subprocess), making rootDeps resolution ~10x faster than
TS. The TS path shells out to `prepublish-standalone.js --dry-run`; the Kotlin
path calls a Kotlin function directly.

`CheckGateStampTask` (the cheap CI pre-flight) only does string comparisons —
no node_modules, no scanning, no Vault. Stays cheap.

### OQ10 — `zbb run -- ./gradlew <task>` for Gradle debugging
**Decision:** No code changes needed. `zbb run` already does the right thing:
loads slot, calls `prepareSlot()` (resolves Vault + DNS, re-exports slot env to
`process.env`), spawns the command with `stdio: 'inherit'`. Gradle gets a TTY
and uses `--console=rich` automatically.

**Caveat:** `prepareSlot()` does NOT apply cleanse. So `zbb run -- ./gradlew gate`
runs without cleanse, while `zbb gate` (which routes through the monorepo
handler) runs with cleanse. This is acceptable — `zbb run` is a debugging
escape hatch, users explicitly opting out of the full monorepo flow.

Document `zbb run -- ./gradlew <task>` as the recommended way to debug Gradle
tasks directly (e.g. when triaging plugin issues during migration).

---

## 15. Mapping table (TS source → Kotlin destination)

| TS file/function | New Kotlin location | Notes |
|---|---|---|
| `Workspace.discoverWorkspaces` | `Workspace.kt` (in `zb.monorepo-base`) | Settings plugin uses this to call `include()` |
| `Workspace.buildDependencyGraph` | `Workspace.kt` | Exposed via `MonorepoGraphService` BuildService |
| `Workspace.topologicalSort` | not needed | Gradle task graph handles this |
| `Workspace.getTransitiveDependents` | `Workspace.kt` | Used by ChangeDetector |
| `ChangeDetector.detectChanges` | `ChangeDetector.kt` | Computed once per build via BuildService |
| `ChangeDetector.findPackagesAffectedByRootDeps` | `ChangeDetector.kt` | Calls in-process Kotlin Prepublish (no node subprocess) |
| `GateStamp.computeSourceHash` | **update `zb.base.hashFiles`** | Backport `git ls-files` semantics |
| `GateStamp.computeTestHash` | **update `zb.base.hashFiles`** | Same |
| `GateStamp.validatePackageStamp` | **update `zb.base.checkGateStamp`** | Switch to 5-state model (VALID/TESTS_CHANGED/TESTS_FAILED/INVALID/MISSING) |
| `GateStamp.buildPackageStampEntry` | **update `zb.base.writeGateStamp`** | Add rootDeps via in-process Prepublish.resolveRootDeps() |
| `GateStamp.readGateStamp` / `writeGateStamp` | **update `zb.base`** + new root aggregator in `zb.monorepo-gate` | Byte-equal JSON output. Per-subproject Provider feeds root aggregator |
| `Builder.runPhaseConcurrently` (scheduling) | not needed | Gradle task graph handles concurrency |
| `Builder.runPhaseConcurrently` (TTY display) | **stays in zbb TS** | Fed by JSON-line events from Kotlin BuildEventListener (OQ7) |
| `Builder.buildDockerImages` | existing `zb.typescript` + new `DockerSemaphore.kt` BuildService | Cap concurrency, honor `DOCKER_BUILD_CONCURRENCY` |
| `Builder.injectRegistryForBuild` / `restoreRegistrySwap` | stays in zbb | Slot/env concern, runs before Gradle invoke |
| `Builder.clean` | existing `zb.base.clean` task + monorepoClean wiring | No new task needed |
| `Builder.build` | existing `zb.base.build` task + monorepoBuild wiring | No new task needed |
| `Builder.test` | existing `zb.base.test` task + monorepoTest wiring | No new task needed |
| `Builder.gate` | existing `zb.base.gate` task + monorepoGate wiring | No new task needed |
| `Publisher.publish` | new `PublishPackageTask` per subproject (in `zb.monorepo-publish`) + monorepoPublish root | Existing `zb.base.publish` is too coupled to old NX flow — replace |
| `Publisher.copyStackArtifacts` | new `CopyStackArtifactsTask` (root-level) | Force-overwrite |
| `Publisher.dispatchImageWorkflows` | new `DispatchImageWorkflowTask` (root-level) | After publish completes |
| `prepublish-standalone.js scanImports` | `Prepublish.kt scanImports()` | All 3 import regexes |
| `prepublish-standalone.js scanShellScripts` | `Prepublish.kt scanShellScripts()` | 4 shell regexes |
| `prepublish-standalone.js extractScriptDependencies` | `Prepublish.kt extractScriptDeps()` | Uses binMap |
| `prepublish-standalone.js scanConfigFiles` | `Prepublish.kt scanConfigFiles()` | eslint/prettier configs |
| `prepublish-standalone.js scanYamlFiles` | `Prepublish.kt scanYamlFiles()` | extends: directives |
| `prepublish-standalone.js discoverBinMappings` | `Prepublish.kt discoverBinMap()` | Walk node_modules |
| `prepublish-standalone.js getWorkspaceTransitiveDeps` | `Prepublish.kt expandTransitive()` | Visited set, recursion |
| `prepublish-standalone.js main` resolution | `Prepublish.kt resolve()` | Priority order preserved |
| `index.ts handleMonorepo` cleanse | stays in zbb | Q5 decision |
| `index.ts handleMonorepo` preflight | stays in zbb | Q5 decision |
| `index.ts handleMonorepo` registry guard | stays in zbb | Plugin trusts zbb did its job |
| `index.ts handleMonorepo` routing | new routing layer in `index.ts` | Q7 decision; spawns Gradle, tails event stream |

---

## 16. Out of scope for this migration

- Rewriting `prepublish-standalone.sh`/`.js` itself (it stays alive for legacy
  callers).
- Touching `auditlogic/module-gradle/` plugins. Those are separate.
- Changing CI workflows beyond what's required for the routing layer.
- Migrating other zbb commands (slot, env, secret, logs, gradle-wrapper) — only
  the monorepo subset (`clean`/`build`/`test`/`gate`/`publish`).
- Performance optimization beyond what Gradle gives us natively.
