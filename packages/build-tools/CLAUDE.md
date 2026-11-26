# Build Tools — Convention Plugins for Hub Modules

**NOTE:** For best results, run Claude Code from meta-repo root (`~/zerobias`) to ensure access to all platform context and cross-module documentation.

## Overview

This package provides Gradle convention plugins that orchestrate the full Hub Module build lifecycle — from OpenAPI validation through code generation, compilation, testing, Docker image building, and publishing. It replaces the previous mix of npm scripts, shell scripts, and CI-only logic with locally reproducible Gradle tasks.

**Package:** `com.zerobias:build-tools`
**Location:** `org/util/packages/build-tools/`
**Branch:** `module-sdlc` on `org/util`
**Consumed by:** `auditlogic/module-gradle/` via Gradle composite build

## Plugin Hierarchy

```
zb.base                          ← Lifecycle skeleton, versioning, env bridge
├── zb.typescript                ← npm, tsc, hub-generator, mocha, Docker
│   ├── zb.typescript-connector  ← Requires connectionProfile.yml
│   └── zb.typescript-agent      ← Forbids connectionProfile.yml
└── zb.java-http                 ← Maven, hub-generator java-http, Docker
```

A standard module's `build.gradle.kts` is 3 lines:

```kotlin
plugins {
    id("zb.typescript-connector")
}
```

## File Structure

```
build-tools/
├── build.gradle.kts                    # kotlin-dsl plugin, dependencies
├── settings.gradle.kts                 # rootProject.name = "build-tools"
├── CLAUDE.md                           # This file
└── src/main/kotlin/
    ├── com/zerobias/buildtools/
    │   ├── ZbExtension.kt       # Shared extension interface
    │   ├── PropertyResolver.kt         # {{driver.path}} value resolution
    │   └── VaultSecretsService.kt      # Gradle BuildService for Vault
    ├── zb.base.gradle.kts      # Base lifecycle + env bridge
    ├── zb.typescript.gradle.kts # TypeScript lifecycle
    ├── zb.typescript-connector.gradle.kts
    ├── zb.typescript-agent.gradle.kts
    └── zb.java-http.gradle.kts # Java HTTP lifecycle
```

## Key Components

### PropertyResolver (`com.zerobias.buildtools.PropertyResolver`)

Resolves `{{driver.path}}` references in property values from `gradle*.properties` files.

| Syntax | Driver | Behavior |
|--------|--------|----------|
| `localhost` | literal | Passthrough (no `{{}}`) |
| `{{env.HOME}}` | env | `System.getenv("HOME")` — fatal if missing |
| `{{vault.operations-kv/ci/github.readPackagesToken}}` | vault | VaultSecretsService lookup — last `.` separates path from field |

Unknown drivers throw `GradleException` (fail fast). Resolution is **lazy** — only happens inside `doFirst` blocks when tasks actually execute.

### VaultSecretsService (`com.zerobias.buildtools.VaultSecretsService`)

Gradle `BuildService` for Vault secret resolution.

- **Lazy connection:** Only contacts Vault when a `{{vault.*}}` property is actually needed by a running task
- **Auth precedence:** `VAULT_TOKEN` env var → `~/.vault-token` file → fatal error
- **Caching:** `ConcurrentHashMap` per secret path — each path fetched once per build
- **KV v2:** Engine version 2 configured, handles `/data/` prefix automatically
- **AutoCloseable:** Cache cleared on build completion

### ZbExtension

Extension registered as `zb` on every module project:

| Property | Type | Convention |
|----------|------|-----------|
| `vendor` | `Property<String>` | Auto-detected from parent directory name |
| `product` | `Property<String>` | Auto-detected from directory name |
| `hasConnectionProfile` | `Property<Boolean>` | `connectionProfile.yml` exists |
| `hasOpenApiSdk` | `Property<Boolean>` | `false` |
| `dockerImageName` | `Property<String>` | `{vendor}-{product}` |

### zb.base (Convention Plugin)

Base plugin applied by all module types. Provides:

**Lifecycle tasks** (all in `lifecycle` group):
```
validate → generate → compile → test → buildArtifacts → gate → publish
                                  ├── unitTest
                                  └── testDocker
                                buildArtifacts:
                                  ├── buildHubSdk
                                  ├── buildOpenApiSdk
                                  └── buildImage
                                publish:
                                  ├── publishNpm
                                  └── publishImage
```

**Version resolution:** Reads `package.json` base version, strips pre-release suffix, appends branch-based suffix:
- `main` → `1.2.3`
- `qa` → `1.2.3-rc.N`
- `dev` → `1.2.3-alpha.N`
- feature branches → `1.2.3-dev.N`

**Environment bridge:** `tasks.withType<Exec>().configureEach { doFirst { ... } }` exports resolved gradle properties as environment variables to all child processes (npm, tsc, docker, mvn). Property-to-env mappings:

| Gradle Property | Env Var |
|-----------------|---------|
| `pgHost` | `PGHOST` |
| `pgPort` | `PGPORT` |
| `npmToken` | `NPM_TOKEN` |
| `dockerRegistry` | `DOCKER_REGISTRY` |
| ... (14 total) | ... |

### Release notes (`util/ChangelogWriter.kt`)

A standard-mode release writes the package's `CHANGELOG.md` from conventional commits, into the same `chore(release)` commit as the version bump. Single-module repos do this in `commitVersion`, multi-module repos in the pre-matrix `versionStandardPackages`. It runs on main only: branch pre-releases make no commit, so they write nothing. The dataloader loads this file into the catalog, where the artifact page shows it.

- **Range:** from the previous release tag to HEAD, along main's first-parent line.
  - The previous tag is `<vendor>-<product>-v<previous version>`, fetched from origin when a local clone lacks it. Without it, the highest earlier tag of exactly that form is used.
  - A package zbb hasn't released yet starts at its lerna-era tag, `<npm name>@<version>`, so its notes continue where lerna's changelog stops.
  - A package with no release tag of either kind is on its first release, and its whole history is listed.
  - Each commit on that line that touched the package is one entry: a squash-merged PR, a GitHub merge commit (the PR title comes from its body), or a direct commit. A PR's own commits never show.
  - A merge that isn't a PR merge is opened up, and its commits are judged one by one.
  - Git narrows the history to the package's path, so the cost follows the package's own changes: all 660 org/product packages take about 30 seconds.
- **What counts:** only changes to the package's own files, relative to the Gradle root (which may be a subdirectory of the repository). These are ignored:
  - `gate-stamp.json` and lockfiles;
  - Markdown at the package root. Nested Markdown counts, because content packages keep content in it;
  - `test/`;
  - package.json edits that only change versions. A change that only moves dependency versions is a dependency update whatever its type says, listed only with `zb.changelog.dependencies=true`.
- **What is listed:**
  - `feat`, `fix`, `perf` and `revert`, plus breaking changes (`!` or `BREAKING CHANGE:`).
  - Left out: other types and non-conventional messages. The publish log names each one and why. Publish's own release commits are dropped silently.
  - A revert and its target in the same release cancel out, and reverting that revert (`Reapply "…"`) puts the change back.
  - When nothing is left there is no section, so versions without real changes have no entry.
- **Existing files:** the section goes above the first release already in the file, at whatever heading level. Lerna wrote minor and major releases as `# [x.y.z]`. A re-run replaces its own section.
- **Shipped in the package:** npm no longer packs a changelog by itself, and the catalog reads it from the published package. So `publishNpmExec` (zb.typescript, zb.typescript-collectorbot, zb.content, zb.npm-only) adds `CHANGELOG.md` to the `files` of the transient package.json right before `npm publish` and takes it out right after. The committed package.json is never changed, so gate stamps are unaffected.
- **Gate stamp:** a few packages cover `CHANGELOG.md` in their committed `files` (org/collectorbot's, through `*.md`), which makes it part of the stamp's source hash.
  - `commitVersion` writes and stages the notes before it refreshes the stamp.
  - `versionStandardPackages` updates a stamp that was current to the new `sourceHash`, using the module's `computeSourceHash` extra. A module whose stamp isn't current gets no notes, so notes can never turn a stamp the matrix would accept into one it refuses.
- **Never blocks a release:** any failure, including a `CHANGELOG.md` that can't be staged, puts the file back, logs a warning, and the release goes on without notes.
- **Switches** (root `gradle.properties` or `-P`): `zb.changelog=false` turns it off; `zb.changelog.dependencies=true` lists dependency updates.
- **Announcement:** `ReleaseAnnouncement.notesFor` sends a release's own section, capped at 20,000 characters, and nothing when the newest section belongs to another version.
- **Known limit:** a commit that lands on main while a single-module release is in flight ends up behind the release tag after `pushVersion` rebases. Neither the next publish's change detection nor its notes see it.

### zb.typescript

Extends base with Node.js/TypeScript lifecycle:

| Phase | Tasks | Tool |
|-------|-------|------|
| Generate | `generateFull`, `generateApi`, `generateTestClient` | NpxTask → hub-generator |
| Install | `npmInstallModule` | NpmTask (input/output tracked) |
| Compile | `transpile` | NpxTask → tsc (input/output tracked) |
| Test | `unitTestExec`, `testDockerExec` | NpxTask → mocha |
| Build | `buildHubSdkExec`, `buildImageExec` | NpxTask / Exec → docker |
| Publish | `publishNpmExec`, `publishImageExec` | NpmTask / Exec |

Node.js version managed by `gradle-node-plugin` (reads `nodeVersion` from `gradle.properties`).

### zb.typescript-connector / zb.typescript-agent

Thin wrappers over `zb.typescript`:
- **Connector:** Sets `hasConnectionProfile=true`, adds `validateConnector` requiring `connectionProfile.yml`
- **Agent:** Sets `hasConnectionProfile=false`, adds `validateAgent` forbidding `connectionProfile.yml`

### zb.java-http

Extends base with Maven/Java lifecycle:

| Phase | Task | Tool |
|-------|------|------|
| Validate | `validatePom` | Requires `java/pom.xml` |
| Generate | `generateJava` | Exec → npx hub-generator java-http |
| Compile | `mavenBuild` | Exec → `mvn package -DskipTests` |
| Test | `mavenTest` | Exec → `mvn test` |
| Build | `buildJavaImage` | Exec → docker build |
| Publish | `publishJavaImage` | Exec → docker push |

### zb.content — element content rules

`validateContent` runs `ElementContentRules` (`content/ElementContentRules.kt`) on every
package with an `elements/` directory (framework, standard, benchmark repos):

- `description` — plain text, no markdown/HTML/newlines, under 200 characters
- `background` — must be a string (long text belongs in `elements/<code>-background.md`)
- `links` — `Record<predicate, alias[]>` shape only; resolving an alias needs the live catalog

`deprecate: true` / `skip: true` elements are exempt. The consumer repo chooses the mode with
`zb.elementRules` in its root `gradle.properties`:

| `zb.elementRules` | Behaviour |
|---|---|
| `enforce` | any description/background violation **fails** (`FAIL_ENFORCED`); `links` shape problems only warn (`WARN_ADVISORY`). No exceptions list — a violating package is fixed, not recorded. |
| `warn` or unset | violations are reported, never fatal (`WARN_UNENFORCED`) — a green build says nothing about the content |

Consumers resolve build-tools at `1.+`, which is why enforcement is opt-in per repo rather
than a default. The content-side rules and the fix procedure are documented in the meta-repo
(`docs/ElementContentRules.md`).

## Dependencies

```kotlin
// build.gradle.kts
dependencies {
    implementation("com.github.node-gradle:gradle-node-plugin:7.0.1")
    implementation("io.github.jopenlibs:vault-java-driver:6.2.0")
}
```

## Build Commands

build-tools is a standalone Gradle build (`settings.gradle.kts` →
`rootProject.name = "build-tools"`) with its own wrapper. The util root
build (`includeBuild` + `pluginManagement`) resolves the plugins from
`mavenLocal` first, so after editing any `.gradle.kts` / Kotlin source you
must republish to Maven local for consumers to pick up the change.

```bash
# From packages/build-tools
./gradlew publishToMavenLocal   # compile + publish plugins to ~/.m2 (run after every edit)
./gradlew compileKotlin         # compile only (fast sanity check, no publish)
```

## Adding a New Convention Plugin

1. Create `zb.{name}.gradle.kts` in `src/main/kotlin/`
2. Apply parent plugin: `id("zb.base")` or `id("zb.typescript")`
3. Register phase-specific tasks and wire into lifecycle tasks via `dependsOn`
4. Access extension: `val zb = extensions.getByType<ZbExtension>()`
5. Access shared values: `val npmDistTag: String = extra["npmDistTag"] as String`
6. Rebuild: `./gradlew build` from module-gradle

## Adding a New Property to Environment Bridge

1. Add the property to `gradle.properties` in module-gradle
2. Add the mapping in `zb.base.gradle.kts` → `envExports` map
3. For vault-resolved values, use `{{vault.mount/path.field}}` syntax in `gradle-ci.properties`

## Related Documentation

- **[auditlogic/module-gradle/CLAUDE.md](../../../auditlogic/module-gradle/CLAUDE.md)** — Consumer of these plugins
- **[Root CLAUDE.md](../../../CLAUDE.md)** — Platform overview
- **[module_sdlc/PLAN.md](../../../projects/module_sdlc/PLAN.md)** — Implementation plan
- **[module_sdlc/GRADLE_SKETCH.md](../../../projects/module_sdlc/GRADLE_SKETCH.md)** — Original design sketch
- **[module_sdlc/JVM_TOOL_ROI_ANALYSIS.md](../../../projects/module_sdlc/JVM_TOOL_ROI_ANALYSIS.md)** — PropertyResolver and Vault design
