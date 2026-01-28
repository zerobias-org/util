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

## Dependencies

```kotlin
// build.gradle.kts
dependencies {
    implementation("com.github.node-gradle:gradle-node-plugin:7.0.1")
    implementation("io.github.jopenlibs:vault-java-driver:6.2.0")
}
```

## Build Commands

```bash
# From build-tools directory
../../auditlogic/module-gradle/gradlew build     # Compile + validate plugins
../../auditlogic/module-gradle/gradlew compileKotlin  # Compile only
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
