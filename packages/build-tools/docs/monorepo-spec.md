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
    Workspace.kt                     # workspace discovery, dep graph, topo sort
    ChangeDetector.kt                # git diff → affected packages
    GateStamp.kt                     # source/test hashing, stamp read/write/validate
    Prepublish.kt                    # Kotlin port of prepublish-standalone.js
    DockerSemaphore.kt               # BuildService capping docker concurrency
```

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
Gradle's `--console=rich` already shows running tasks; the plugin should not
reimplement TTY rendering. If users want the old display, they can run
`./gradlew ... --console=rich` (default). Acceptable parity loss.

---

## 6. Gate stamp

**Source:** `lib/monorepo/GateStamp.ts`

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
  `tests`, plus `rootDeps` resolved via `prepublish-standalone --dry-run`
  (Kotlin port in the new path).
- Written as `JSON.stringify(stamp, null, 2) + '\n'`. The trailing newline matters
  for byte-equality.

### Registry guard
Before writing the stamp, check if a slot is loaded with locally-published
registry packages (`~/.zbb/slots/<slot>/stacks/registry/publishes.json` exists
and is non-empty). If so, abort with an error pointing the user at
`zbb registry clear`. Reason: stamp would otherwise capture a build that
includes Verdaccio-published artifacts, which would not reproduce on CI.

### Gradle mapping
- `zb.monorepo-gate` registers a `WriteGateStampTask` (writes the JSON file) and
  a `CheckGateStampTask` (validates without booting full gate).
- Source hashing implemented in `GateStamp.kt`. Inputs declared via
  `@InputFiles` (git-tracked source files), output is `gate-stamp.json`.
- Hybrid approach (per Q3 decision): Gradle inputs/outputs handle in-build skip
  decisions, AND the plugin writes the stamp file as a task output for CI's
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
- `Prepublish.kt` in `build-tools` implements all the above.
- A `PrepublishTask` per subproject, declared inputs:
  - All TS/JS source files (matching scan patterns)
  - All `.sh` files in `src/`, `scripts/`, root
  - All YAML files
  - Config files at root
  - `package.json` and root `package.json`
  - `node_modules/` (for binMap discovery — directory only, lazy)
- Output: the modified `package.json` (and backup file).
- Build cache friendly via declared inputs/outputs.

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

## 14. Open implementation questions

These are tactical questions to resolve when starting Phase 2:

1. **Settings plugin and existing repos.** The settings plugin will add npm
   packages as Gradle subprojects. Do existing repos have any `include(...)`
   calls in their current `settings.gradle.kts` that would conflict? Audit
   each of the 6 repos before phase 4.

2. **Subproject naming.** Gradle paths like `:packages:foo` vs `:foo` —
   pick a convention. Recommendation: use `relDir` with `/` → `:`. So
   `packages/dynamodb` becomes `:packages:dynamodb`.

3. **Task names.** Gradle convention is camelCase (`monorepoGate`). zbb
   shells out to `./gradlew :monorepoBuild` etc. Map zbb commands → Gradle
   task names exactly once in the routing layer.

4. **Build cache file.** Should we keep writing `.zbb-build-cache.json` for
   parity testing during phase 4, or rely entirely on Gradle's build cache?
   Recommendation: don't write it. Verify parity via gate-stamp + npm pack diff
   instead.

5. **Phase ordering across packages.** Today, ALL packages run lint, then ALL
   run generate, then ALL run transpile. Gradle's default would be: each
   package goes through its full task chain independently. Decide whether to
   force phase-level barriers (`mustRunAfter`) or let Gradle interleave. The
   user-visible output may differ.

6. **Test result capture.** The TS impl parses mocha output for
   passing/failing/pending counts. The Kotlin port needs the same — does Gradle
   have a JUnit-style report we can capture from npm test runs? Probably need
   to keep parsing mocha output.

7. **Display fidelity.** The TS spinner display is nice but Gradle has its own
   console rendering. Acceptable to lose the in-place "waiting on deps" text
   and just rely on Gradle's task progress.

8. **prepublish state file.** Today the `.prepublish-backup` file exists during
   the publish run and is cleaned up after. Gradle tasks should declare it as
   an output but treat it as transient. Use `@OutputFile` with cleanup in a
   `doLast {}` or `Build.finalizedBy`.

9. **Stamp invariant: rootDeps resolution timing.** rootDeps is resolved at
   stamp WRITE time (after build artifacts exist) and validated against
   current root `package.json` at stamp READ time. The Kotlin port must
   preserve this — don't compute rootDeps lazily in validation.

10. **`zbb run` integration.** Users debugging Gradle directly should use
    `zbb run -- ./gradlew <task>` to get slot env applied. Confirm `zbb run`
    propagates the loaded slot env to the gradle subprocess.

---

## 15. Mapping table (TS source → Kotlin destination)

| TS file/function | New Kotlin location | Notes |
|---|---|---|
| `Workspace.discoverWorkspaces` | `Workspace.kt` | Settings plugin uses this to call `include()` |
| `Workspace.buildDependencyGraph` | `Workspace.kt` | Exposed via `MonorepoGraphService` BuildService |
| `Workspace.topologicalSort` | not needed | Gradle task graph handles this |
| `Workspace.getTransitiveDependents` | `Workspace.kt` | Used by ChangeDetector |
| `ChangeDetector.detectChanges` | `ChangeDetector.kt` | Computed once per build via BuildService |
| `ChangeDetector.findPackagesAffectedByRootDeps` | `ChangeDetector.kt` | Calls Kotlin Prepublish in --dry-run mode |
| `GateStamp.computeSourceHash` | `GateStamp.kt` | Must match exactly — used by gate-stamp file |
| `GateStamp.computeTestHash` | `GateStamp.kt` | Same |
| `GateStamp.validatePackageStamp` | `GateStamp.kt` | All 4 result states preserved |
| `GateStamp.buildPackageStampEntry` | `GateStamp.kt` | rootDeps resolution at write time |
| `GateStamp.readGateStamp` / `writeGateStamp` | `GateStamp.kt` | Byte-equal JSON output (trailing newline) |
| `Builder.runPhaseConcurrently` | not needed | Gradle's task graph handles concurrency |
| `Builder.buildDockerImages` | `DockerBuildTask.kt` + `DockerSemaphore.kt` | BuildService caps concurrency |
| `Builder.injectRegistryForBuild` / `restoreRegistrySwap` | stays in zbb | Slot/env concern, runs before Gradle invoke |
| `Builder.clean` | `CleanTask.kt` | Removes dist/, generated/, build/, tsconfig.tsbuildinfo |
| `Builder.build` | `BuildTask.kt` per subproject | dependsOn wired via dep graph |
| `Builder.test` | `TestTask.kt` per subproject | Same |
| `Builder.gate` | `GateTask.kt` orchestrating build+test+stamp | Phase orchestration |
| `Publisher.publish` | `PublishTask.kt` per subproject | + `RootPublishTask` for stack artifacts |
| `Publisher.copyStackArtifacts` | `CopyStackArtifactsTask.kt` | Force-overwrite |
| `Publisher.dispatchImageWorkflows` | `DispatchImageWorkflowTask.kt` | After publish completes |
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
| `index.ts handleMonorepo` registry guard | stays in zbb (also enforced in plugin) | Belt and suspenders for safety |
| `index.ts handleMonorepo` routing | new routing layer in `index.ts` | Q7 decision |

---

## 16. Out of scope for this migration

- Rewriting `prepublish-standalone.sh`/`.js` itself (it stays alive for legacy
  callers).
- Touching `auditlogic/module-gradle/` plugins. Those are separate.
- Changing CI workflows beyond what's required for the routing layer.
- Migrating other zbb commands (slot, env, secret, logs, gradle-wrapper) — only
  the monorepo subset (`clean`/`build`/`test`/`gate`/`publish`).
- Performance optimization beyond what Gradle gives us natively.
