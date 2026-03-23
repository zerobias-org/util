@file:OptIn(ExperimentalStdlibApi::class)

import com.github.gradle.node.npm.task.NpmTask
import com.github.gradle.node.npm.task.NpxTask
import com.zerobias.buildtools.module.ZbExtension
import com.zerobias.buildtools.module.OpenApiSpecAssembler
import com.zerobias.buildtools.module.ProductInfoDereferencer
import com.zerobias.buildtools.module.ServerEntryPointGenerator
import com.zerobias.buildtools.module.DockerRunner

plugins {
    id("zb.base")
    id("com.github.node-gradle.node")
}

val zb = extensions.getByType<ZbExtension>()
val npmDistTag: String = extra["npmDistTag"] as String

// ── Node.js configuration (uses system Node from nvm) ──
// Resolve nvm-managed Node from .nvmrc so the Gradle daemon uses the correct version
// even when its inherited PATH points to a different system Node.

val nvmDir = System.getenv("NVM_DIR")?.let { java.io.File(it) }
    ?: java.io.File(System.getProperty("user.home"), ".nvm")
val nvmrcFile = project.rootDir.resolve(".nvmrc")
val nvmNodeVersion = if (nvmrcFile.exists()) nvmrcFile.readText().trim().removePrefix("v") else null
val nvmNodeBinDir: String? = if (nvmNodeVersion != null) {
    val binDir = nvmDir.resolve("versions/node/v${nvmNodeVersion}/bin")
    if (binDir.exists()) binDir.absolutePath else null
} else null

node {
    download.set(false)  // Use nvm-managed Node, don't download
}

// Inject nvm Node bin dir at the front of PATH for all NpxTask/NpmTask instances
// so they find the correct node/npx/npm binaries.
if (nvmNodeBinDir != null) {
    tasks.withType<NpxTask>().configureEach {
        val currentPath = System.getenv("PATH") ?: ""
        environment.put("PATH", "${nvmNodeBinDir}:${currentPath}")
    }
    tasks.withType<NpmTask>().configureEach {
        val currentPath = System.getenv("PATH") ?: ""
        environment.put("PATH", "${nvmNodeBinDir}:${currentPath}")
    }
}

// ── Intermediate file paths for incremental builds ──
// Files stay in project root (not build/) so $ref resolution works with node_modules

val assembledSpec = project.file("full-assembled.yml")
val bundledSpec = project.file("full-bundled.yml")

// ════════════════════════════════════════════════════════════
// VALIDATE phase
// ════════════════════════════════════════════════════════════

val validateSpec by tasks.registering(NpxTask::class) {
    group = "lifecycle"
    description = "Lint OpenAPI specification with Redocly"
    workingDir.set(project.projectDir)
    command.set("@redocly/cli")
    // Auto-detect redocly config: redocly.yaml or .redocly.yaml
    val configFile = if (project.file(".redocly.yaml").exists()) ".redocly.yaml" else "redocly.yaml"
    args.set(listOf("lint", "api.yml", "--config", configFile))
    inputs.file("api.yml")
    inputs.file(configFile).optional()
    outputs.file(layout.buildDirectory.file("validated-spec.marker"))
    doLast {
        layout.buildDirectory.file("validated-spec.marker").get().asFile.apply {
            parentFile.mkdirs()
            writeText("validated")
        }
    }
}

tasks.named("validate") {
    dependsOn(validateSpec)
}

// ════════════════════════════════════════════════════════════
// LINT — eslint on src/
// ════════════════════════════════════════════════════════════

val lintExec by tasks.registering(Exec::class) {
    group = "lifecycle"
    description = "Run eslint on source code using shared config from @zerobias-org/eslint-config"
    dependsOn(tasks.named("compile"))
    workingDir(project.projectDir)
    doFirst {
        // Generate ephemeral eslint.config.mjs in the module directory
        // Must be local (not in node_modules) so eslint's base path is correct
        val configFile = project.file("eslint.config.js")
        val sharedConfigPath = "node_modules/@zerobias-org/eslint-config/eslint.config.js"
        if (!configFile.exists() && project.file(sharedConfigPath).exists()) {
            // Read shared config and write as local file
            configFile.writeText(project.file(sharedConfigPath).readText())
        }

        val npxPath = if (nvmNodeBinDir != null) "$nvmNodeBinDir/npx" else "npx"
        commandLine(npxPath, "eslint", "src/")
    }
    doLast {
        // Clean up ephemeral config
        project.file("eslint.config.js").delete()
    }
    onlyIf { project.file("src").exists() }
}

tasks.named("lint") {
    dependsOn(lintExec)
}

// ════════════════════════════════════════════════════════════
// GENERATE phase — stages G2 through G8
//
// Pipeline: assembleSpec → npmInstall → bundleSpec →
//           dereferenceProductInfos → [generateApi, copyDistributionSpec] →
//           postGenerate
//
// Uses intermediate files in build/spec/ for proper incremental builds.
// ════════════════════════════════════════════════════════════

// G2: assembleSpec — build full-assembled.yml from api.yml + optional $ref injections
val assembleSpec by tasks.registering {
    group = "lifecycle"
    description = "Assemble spec from api.yml with ConnectionProfile/State refs"
    inputs.file("api.yml")
    if (project.file("connectionProfile.yml").exists()) {
        inputs.file("connectionProfile.yml")
    }
    if (project.file("connectionState.yml").exists()) {
        inputs.file("connectionState.yml")
    }
    outputs.file(assembledSpec)
    doLast {
        OpenApiSpecAssembler.assemble(project.projectDir, assembledSpec)
    }
}

// G3: npmInstall — install npm dependencies (needed for bundleSpec $ref resolution)
val npmInstallModule by tasks.registering(NpmTask::class) {
    group = "lifecycle"
    description = "Install npm dependencies"
    npmCommand.set(listOf("install"))
    workingDir.set(project.projectDir)
    inputs.file("package.json")
    inputs.file("package-lock.json").optional()
    outputs.dir("node_modules")
}

// G4: bundleSpec — inline all $ref entries via Redocly CLI
val bundleSpec by tasks.registering(NpxTask::class) {
    group = "lifecycle"
    description = "Bundle all \$ref entries into self-contained spec"
    dependsOn(assembleSpec, npmInstallModule)
    workingDir.set(project.projectDir)
    command.set("@redocly/cli")
    args.set(listOf("bundle", assembledSpec.name, "--output", bundledSpec.name))
    inputs.file(assembledSpec)
    inputs.dir("node_modules")
    outputs.file(bundledSpec)
}

// G5: dereferenceProductInfos — resolve $refs in x-product-infos → final full.yml
val dereferenceProductInfos by tasks.registering {
    group = "lifecycle"
    description = "Dereference product info refs, produce final full.yml"
    dependsOn(bundleSpec)
    inputs.file(bundledSpec)
    inputs.dir("node_modules")
    outputs.file("full.yml")
    doLast {
        ProductInfoDereferencer.dereference(
            bundledSpec,
            project.file("full.yml"),
            project.projectDir
        )
    }
}

// G6: copyDistributionSpec — create module-{name}.yml distribution artifact
val copyDistributionSpec by tasks.registering {
    group = "lifecycle"
    description = "Copy bundled spec to distribution artifact (module-{name}.yml)"
    dependsOn(dereferenceProductInfos)
    inputs.file("full.yml")
    inputs.property("includeConnectionProfile", zb.includeConnectionProfileInDist)
    outputs.file(project.provider {
        val moduleName = OpenApiSpecAssembler.resolveModuleName(project.projectDir)
        project.file("${moduleName}.yml")
    })
    doLast {
        val moduleName = OpenApiSpecAssembler.resolveModuleName(project.projectDir)
        val fullYml = project.file("full.yml")
        val distYml = project.file("${moduleName}.yml")

        if (zb.includeConnectionProfileInDist.get()) {
            fullYml.copyTo(distYml, overwrite = true)
        } else {
            OpenApiSpecAssembler.copyWithoutConnectionSchemas(fullYml, distYml)
        }
    }
}

// G7: generateApi — run hub-generator codegen on full.yml
val generateApi by tasks.registering(NpxTask::class) {
    group = "lifecycle"
    description = "Generate TypeScript interfaces from OpenAPI spec"
    dependsOn(dereferenceProductInfos, npmInstallModule)
    workingDir.set(project.projectDir)
    command.set("hub-generator")
    args.set(project.provider {
        buildList {
            add("generate")
            add("-g"); add("hub-module")
            add("-i"); add("full.yml")
            add("-o"); add("generated/")
            if (zb.hasConnectionProfile.get()) {
                add("-p"); add("isConnector=true")
            }
            if (project.file("connectionState.yml").exists()) {
                add("-p"); add("hasState=true")
            }
            addAll(zb.generatorArgs.get())
        }
    })
    inputs.file("full.yml")
    inputs.property("hasConnectionProfile", zb.hasConnectionProfile)
    inputs.property("generatorArgs", zb.generatorArgs)
    outputs.dir("generated")
}

// G8: postGenerate — optional escape hatch for module-specific fixes
val postGenerate by tasks.registering {
    group = "lifecycle"
    description = "Run post-generation fixes (edge case escape hatch)"
    dependsOn(generateApi)
    onlyIf { zb.postGenerateScript.isPresent }
    doLast {
        val process = ProcessBuilder("bash", "-c", zb.postGenerateScript.get())
            .directory(project.projectDir)
            .redirectErrorStream(true)
            .start()
        val output = process.inputStream.bufferedReader().readText()
        val exitCode = process.waitFor()
        if (exitCode != 0) {
            throw org.gradle.api.GradleException(
                "Post-generate script failed (exit $exitCode):\n$output"
            )
        }
        println(output)
    }
}

// Wire all generate stages into the lifecycle
tasks.named("generate") {
    dependsOn(copyDistributionSpec, generateApi, postGenerate)
}

// ════════════════════════════════════════════════════════════
// COMPILE phase
// ════════════════════════════════════════════════════════════

val transpile by tasks.registering(NpxTask::class) {
    group = "lifecycle"
    description = "Compile TypeScript (ESM)"
    dependsOn(npmInstallModule, tasks.named("generate"))
    workingDir.set(project.projectDir)
    command.set("tsc")
    inputs.dir("src")
    inputs.dir("generated")
    inputs.file("tsconfig.json").optional()
    outputs.dir("dist")
    // Clean stale server files that would cause compilation errors.
    // Server files are re-generated by generateServerEntry/generateServerApi
    // and compiled by compileServer in the Docker build pipeline.
    doFirst {
        val serverEntry = project.file("generated/server-entry.ts")
        if (serverEntry.exists()) serverEntry.delete()
        val serverDir = project.file("generated/server")
        if (serverDir.exists()) serverDir.deleteRecursively()
    }
}

tasks.named("compile") {
    dependsOn(transpile)
}

// ════════════════════════════════════════════════════════════
// TEST phase
// ════════════════════════════════════════════════════════════

val testUnitExec by tasks.registering(NpxTask::class) {
    group = "lifecycle"
    description = "Run mocha unit tests"
    dependsOn(tasks.named("compile"))
    workingDir.set(project.projectDir)
    command.set("mocha")
    args.set(listOf("--recursive", "test/unit/"))
    onlyIf { project.file("test/unit").exists() }
}

tasks.named("testUnit") {
    dependsOn(testUnitExec)
}

val testIntegrationExec by tasks.registering(NpxTask::class) {
    group = "lifecycle"
    description = "Run mocha integration tests"
    dependsOn(tasks.named("compile"))
    workingDir.set(project.projectDir)
    command.set("mocha")
    args.set(listOf("--recursive", "test/integration/"))
    onlyIf { project.file("test/integration").exists() }
}

tasks.named("testIntegration") {
    dependsOn(testIntegrationExec)
}

// ── E2E Direct Mode ─────────────────────────────────────────────
// Runs e2e tests with TEST_MODE=direct (in-process, no Docker)
// For TypeScript modules: calls GithubImpl/SqlImpl directly

val testDirectExec by tasks.registering(Exec::class) {
    group = "lifecycle"
    description = "Run e2e tests in Direct mode (in-process, no container)"
    dependsOn(tasks.named("compile"))
    workingDir(project.projectDir)
    doFirst {
        environment("TEST_MODE", "direct")
        environment("MODULE_DIR", project.projectDir.absolutePath)
        // Pass SECRET_NAME only if explicitly set
        val secretName = System.getenv("SECRET_NAME")
            ?: project.findProperty("secretName")?.toString()
        if (secretName != null) {
            environment("SECRET_NAME", secretName)
        }
        // For direct mode: dynamic import of module impl
        val pascal = ServerEntryPointGenerator.resolveModulePascalName(project.projectDir)
        environment("DIRECT_PASCAL", pascal)
        environment("DIRECT_IMPL", "src/${pascal}Impl.js")

        val npxPath = if (nvmNodeBinDir != null) "$nvmNodeBinDir/npx" else "npx"
        commandLine(npxPath, "mocha",
            "--config", ".mocharc.json",
            "--inline-diffs",
            "--reporter=list",
            "--timeout", "120000",
            "test/e2e/**/*.test.ts"
        )
    }
    onlyIf { project.file("test/e2e").exists() }
}

tasks.named("testDirect") {
    dependsOn(testDirectExec)
}

// ── E2E Docker Mode ─────────────────────────────────────────────

val testDockerExec by tasks.registering(Exec::class) {
    group = "lifecycle"
    description = "Run e2e tests in Docker mode (Gradle manages container lifecycle)"
    dependsOn(tasks.named("compile"), startModuleExec)
    workingDir(project.projectDir)
    doFirst {
        // Read container URL from startModuleExec output
        val jsonFile = layout.buildDirectory.file("module-container.json").get().asFile
        val containerUrl = if (jsonFile.exists()) {
            DockerRunner.ContainerInfo.fromJson(jsonFile.readText()).baseUrl
        } else {
            throw GradleException("module-container.json not found — startModuleExec did not run")
        }

        environment("TEST_MODE", "docker")
        environment("CONTAINER_URL", containerUrl)
        environment("MODULE_DIR", project.projectDir.absolutePath)
        // Pass SECRET_NAME only if explicitly set (Gradle property or env var)
        // If not set, module-test-client discovers secrets via zbb secret list --module
        val secretName = System.getenv("SECRET_NAME")
            ?: project.findProperty("secretName")?.toString()
        if (secretName != null) {
            environment("SECRET_NAME", secretName)
        }
        // Self-signed certs: tell Node.js to accept them
        environment("NODE_TLS_REJECT_UNAUTHORIZED", "0")

        val npxPath = if (nvmNodeBinDir != null) "$nvmNodeBinDir/npx" else "npx"
        commandLine(npxPath, "mocha",
            "--config", ".mocharc.json",
            "--inline-diffs",
            "--reporter=list",
            "--timeout", "180000",
            "test/e2e/**/*.test.ts"
        )
    }
    // Stop container after tests (pass or fail)
    finalizedBy(stopModuleExec)
    onlyIf { project.file("test/e2e").exists() }
}

tasks.named("testDocker") {
    dependsOn(testDockerExec)
}

// ════════════════════════════════════════════════════════════
// DOCKER SERVER — generate REST server + Dockerfile for Docker builds
//
// Pipeline: installServerDeps → generateServerApi → generateServerEntry
//           → compileServer → generateDockerfile → buildImageExec
//
// These tasks only run when buildImage or testDocker is in the task graph.
// ════════════════════════════════════════════════════════════

// Helper: check if Docker-related tasks are in the graph
fun isDockerBuild(): Boolean {
    return try {
        gradle.taskGraph.hasTask(tasks.named("buildImage").get()) ||
        gradle.taskGraph.hasTask(tasks.named("testDocker").get())
    } catch (_: Exception) {
        false
    }
}

// True when Docker build needed AND module doesn't provide its own custom server stack.
// Java HTTP modules have startup.sh (custom nginx + Java) — skip TS server generation.
// Gradle-generated TS containers use docker-startup.sh (generated by generateDockerfile).
fun needsGeneratedServer(): Boolean {
    return isDockerBuild() && !project.file("startup.sh").exists()
}

// Install server runtime dependencies (Express, OpenAPI validator, etc.)
// Install all server dependencies in a single npm install --no-save call.
// Multiple sequential --no-save installs cause npm to prune previous --no-save
// packages (they're not in package.json/lockfile), so all server deps must be
// installed together in one invocation.
// Must run after compile (which depends on npmInstallModule) to avoid race
// condition where the module npm install removes server deps from node_modules.
val installServerDeps by tasks.registering(NpmTask::class) {
    group = "lifecycle"
    description = "Install server runtime and dev dependencies for Docker image (--no-save)"
    dependsOn(tasks.named("compile"))
    workingDir.set(project.projectDir)
    npmCommand.set(listOf("install"))
    // All server deps installed together: runtime, dev types, and platform packages.
    // Sequential --no-save installs cause npm to prune "extraneous" packages from
    // the previous call (they're not in package.json), so all must go in one call.
    args.set(project.provider {
        buildList {
            add("--no-save")
            // Server runtime (Docker container)
            add("express@4.18.1")
            add("express-async-errors@3.1.1")
            add("express-openapi-validator@4.13.6")
            add("esprima@4.0.1")
            add("pem@1.14.6")
            // Dev types for tsc
            add("@types/express@4.17.13")
            // Platform packages (latest from registry)
            add("@zerobias-org/types-core-js@latest")
            add("@zerobias-org/logger@latest")
            add("@zerobias-org/util-hub-module-utils@latest")
            add("@zerobias-com/hub-core@latest")
        }
    })
    onlyIf { needsGeneratedServer() }
}

// Stub tasks that previously did separate npm install calls.
// Now collapsed into installServerDeps to prevent npm pruning between calls.
val installServerDevDeps by tasks.registering {
    group = "lifecycle"
    description = "Stub: merged into installServerDeps"
    dependsOn(installServerDeps)
    onlyIf { needsGeneratedServer() }
}

// Stub: platform deps merged into installServerDeps to prevent npm pruning.
val installServerPlatformDeps by tasks.registering {
    group = "lifecycle"
    description = "Stub: platform deps merged into installServerDeps"
    dependsOn(installServerDevDeps)
    onlyIf { needsGeneratedServer() }
}

// Generate REST server controllers from OpenAPI spec
val generateServerApi by tasks.registering(NpxTask::class) {
    group = "lifecycle"
    description = "Generate REST server controllers from OpenAPI spec"
    dependsOn(dereferenceProductInfos, npmInstallModule)
    mustRunAfter(transpile)  // Avoid output overlap with generated/ directory
    workingDir.set(project.projectDir)
    command.set("hub-generator")
    args.set(listOf(
        "generate",
        "-g", "hub-module-server",
        "-i", "full.yml",
        "-o", "generated/",
        "-p", "modulePackage=../api"
    ))
    inputs.file("full.yml")
    outputs.file(layout.buildDirectory.file("server-api-generated.marker"))
    onlyIf { needsGeneratedServer() }
    doLast {
        val serverDir = project.file("generated/server")
        if (serverDir.exists()) {
            serverDir.listFiles()?.filter { it.extension == "ts" && it.name != "index.ts" }?.forEach { file ->
                var content = file.readText()
                // Fix 1: header params like "If-Match" generate invalid variable names
                content = content.replace("let If-Match:", "let ifMatch:")
                // Fix 2: controllers import from ../api/index.js which doesn't re-export
                // model types (ObjectSerializer, model classes). Redirect to ../../src/index.js
                // which re-exports from both generated/api and generated/model.
                content = content.replace("from '../api/index.js'", "from '../../src/index.js'")
                file.writeText(content)
            }
        }
        layout.buildDirectory.file("server-api-generated.marker").get().asFile.apply {
            parentFile.mkdirs()
            writeText("generated")
        }
    }
}

// Generate server-entry.ts — the Express app entry point
val generateServerEntry by tasks.registering {
    group = "lifecycle"
    description = "Generate server-entry.ts entry point"
    dependsOn(generateServerApi)
    mustRunAfter(transpile)  // Avoid output overlap with generated/ directory
    inputs.file("full.yml")
    outputs.file(layout.buildDirectory.file("server-entry-generated.marker"))
    onlyIf { needsGeneratedServer() }
    doLast {
        val pascal = ServerEntryPointGenerator.resolveModulePascalName(project.projectDir)
        val content = ServerEntryPointGenerator.generate(pascal)
        project.file("generated/server-entry.ts").writeText(content)
        layout.buildDirectory.file("server-entry-generated.marker").get().asFile.apply {
            parentFile.mkdirs()
            writeText("generated")
        }
    }
}

// Re-compile TypeScript to include generated server code
val compileServer by tasks.registering(NpxTask::class) {
    group = "lifecycle"
    description = "Compile TypeScript including server code"
    dependsOn(transpile, generateServerEntry, installServerPlatformDeps)
    workingDir.set(project.projectDir)
    command.set("tsc")
    inputs.file(layout.buildDirectory.file("server-api-generated.marker"))
    inputs.file(layout.buildDirectory.file("server-entry-generated.marker"))
    outputs.file(layout.buildDirectory.file("server-compiled.marker"))
    onlyIf { needsGeneratedServer() }
    doLast {
        layout.buildDirectory.file("server-compiled.marker").get().asFile.apply {
            parentFile.mkdirs()
            writeText("compiled")
        }
    }
}

// Generate Dockerfile, nginx.conf, and startup.sh for module container
// nginx handles SSL termination + auth, proxies to Node on internal port
val generateDockerfile by tasks.registering {
    group = "lifecycle"
    description = "Generate Dockerfile with nginx SSL termination"
    dependsOn(compileServer)
    outputs.files("Dockerfile", "docker-nginx.conf", "docker-startup.sh")
    // Skip if module provides its own Dockerfile (e.g., Java HTTP modules)
    onlyIf { isDockerBuild() && !project.file("Dockerfile").exists() }
    doLast {
        // nginx.conf — SSL termination, auth header check, proxy to Node
        val nginxConf = """
            |worker_processes 1;
            |daemon off;
            |error_log /var/log/nginx/error.log warn;
            |pid /var/run/nginx.pid;
            |
            |events {
            |    worker_connections 1024;
            |}
            |
            |http {
            |    default_type application/json;
            |    access_log off;
            |
            |    upstream node_app {
            |        server 127.0.0.1:8889;
            |        keepalive 32;
            |    }
            |
            |    server {
            |        listen 8888 ssl http2 default_server;
            |        server_name localhost;
            |
            |        ssl_certificate /opt/module/ssl/cert.pem;
            |        ssl_certificate_key /opt/module/ssl/key.pem;
            |        ssl_protocols TLSv1.2 TLSv1.3;
            |        ssl_ciphers HIGH:!aNULL:!MD5;
            |
            |        proxy_http_version 1.1;
            |        proxy_set_header Connection "";
            |        proxy_set_header Host ${'$'}host;
            |        proxy_set_header X-Real-IP ${'$'}remote_addr;
            |        proxy_set_header X-Forwarded-For ${'$'}proxy_add_x_forwarded_for;
            |        proxy_set_header X-Forwarded-Proto ${'$'}scheme;
            |        proxy_buffering off;
            |        proxy_connect_timeout 60s;
            |        proxy_send_timeout 300s;
            |        proxy_read_timeout 300s;
            |
            |        location / {
            |            proxy_pass http://node_app;
            |        }
            |    }
            |}
        """.trimMargin() + "\n"
        project.file("docker-nginx.conf").writeText(nginxConf)

        // startup.sh — generate cert, start nginx, start node
        val startupSh = """
            |#!/bin/sh
            |set -e
            |
            |# Generate self-signed SSL certificate
            |mkdir -p /opt/module/ssl
            |openssl req -x509 -nodes -days 3650 -newkey rsa:2048 \
            |  -keyout /opt/module/ssl/key.pem \
            |  -out /opt/module/ssl/cert.pem \
            |  -subj "/CN=localhost/O=ZeroBias/OU=Module" 2>/dev/null
            |
            |# Start nginx (SSL termination)
            |mkdir -p /var/log/nginx /var/run
            |nginx -c /opt/module/docker-nginx.conf &
            |NGINX_PID=${'$'}!
            |sleep 1
            |if ! kill -0 ${'$'}NGINX_PID 2>/dev/null; then
            |  echo "ERROR: nginx failed to start"
            |  cat /var/log/nginx/error.log 2>/dev/null
            |  exit 1
            |fi
            |
            |# Start Node app on internal port
            |PORT=8889 node dist/generated/server-entry.js &
            |NODE_PID=${'$'}!
            |
            |# Shutdown handler
            |trap "kill ${'$'}NODE_PID ${'$'}NGINX_PID 2>/dev/null; exit 0" TERM INT
            |
            |echo "Module ready on https://localhost:8888"
            |wait ${'$'}NODE_PID
        """.trimMargin() + "\n"
        project.file("docker-startup.sh").writeText(startupSh)

        // Dockerfile
        val dockerfile = """
            |FROM node:22-alpine
            |LABEL org.opencontainers.image.source https://github.com/auditlogic/module
            |RUN apk update && apk add ca-certificates openssl nginx && rm -rf /var/cache/apk/*
            |WORKDIR /opt/module
            |COPY dist ./dist
            |COPY generated ./generated
            |COPY node_modules ./node_modules
            |COPY package.json .
            |COPY *.yml .
            |COPY docker-nginx.conf /opt/module/docker-nginx.conf
            |COPY docker-startup.sh /opt/module/docker-startup.sh
            |RUN chmod +x /opt/module/docker-startup.sh
            |RUN mkdir -p /var/log/nginx /var/run
            |EXPOSE 8888
            |CMD ["/opt/module/docker-startup.sh"]
        """.trimMargin() + "\n"
        project.file("Dockerfile").writeText(dockerfile)
    }
}

// ════════════════════════════════════════════════════════════
// BUILD ARTIFACTS
// ════════════════════════════════════════════════════════════

// A1: Hub SDK — generate api-client SDK for hub-server callers
val buildHubSdkExec by tasks.registering(NpxTask::class) {
    group = "lifecycle"
    description = "Generate hub-server caller SDK"
    dependsOn(dereferenceProductInfos, npmInstallModule)
    workingDir.set(project.projectDir)
    command.set("hub-generator")
    args.set(listOf("generate", "-g", "api-client", "-i", "full.yml", "-o", "hub-sdk/generated/"))
    inputs.file("full.yml")
    outputs.dir("hub-sdk/generated")
    doLast {
        // Fix: ConnectionProfile is a type-only export from util-api-client-base.
        // The generator emits a value re-export which fails at runtime in ESM.
        val sdkIndex = project.file("hub-sdk/generated/api/index.ts")
        if (sdkIndex.exists()) {
            var content = sdkIndex.readText()
            content = content.replace(
                "export { ConnectionProfile } from '@zerobias-org/util-api-client-base'",
                "export type { ConnectionProfile } from '@zerobias-org/util-api-client-base'"
            )
            sdkIndex.writeText(content)
        }
    }
}

tasks.named("buildHubSdk") {
    dependsOn(buildHubSdkExec)
}

val buildImageExec by tasks.registering(Exec::class) {
    group = "lifecycle"
    description = "Build Docker image"
    dependsOn(compileServer, generateDockerfile)
    workingDir(project.projectDir)
    val registry = project.findProperty("dockerRegistry")?.toString() ?: "localhost"
    val imageName = zb.dockerImageName.get()
    // Strip build metadata (+...) from reckon version — not valid in Docker tags
    val ver = project.version.toString().substringBefore("+")
    commandLine("docker", "build",
        "-t", "${imageName}:local",
        "-t", "${registry}/${imageName}:${ver}",
        ".")
    inputs.file("Dockerfile")
    inputs.dir("dist")
    inputs.file("package.json")
}

tasks.named("buildImage") {
    dependsOn(buildImageExec)
}

// ════════════════════════════════════════════════════════════
// DOCKER RUNTIME — start/stop module container for local dev
// ════════════════════════════════════════════════════════════

val startModuleExec by tasks.registering {
    group = "docker"
    description = "Start module container and write connection details"
    dependsOn(buildImageExec)
    outputs.file(layout.buildDirectory.file("module-container.json"))
    outputs.upToDateWhen { false } // Always start fresh container
    doLast {
        val imageName = "${zb.dockerImageName.get()}:local"
        val containerName = "module-${zb.vendor.get()}-${zb.product.get()}"
        val hostPort = if (project.hasProperty("port"))
            project.property("port").toString().toInt()
        else DockerRunner.findFreePort()

        val info = DockerRunner.start(imageName, containerName, hostPort)

        try {
            DockerRunner.waitForHealthy(info.port)
        } catch (e: Exception) {
            // Print container logs for diagnostics before failing
            val logs = DockerRunner.getLogs(info.containerId)
            logger.error("Container logs:\n$logs")
            throw e
        }

        val jsonFile = layout.buildDirectory.file("module-container.json").get().asFile
        jsonFile.parentFile.mkdirs()
        jsonFile.writeText(info.toJson())

        logger.lifecycle("Module running at ${info.baseUrl} (container: ${info.containerId.take(12)})")
    }
}

tasks.named("startModule") { dependsOn(startModuleExec) }

val stopModuleExec by tasks.registering {
    group = "docker"
    description = "Stop and remove module container"
    doLast {
        val jsonFile = layout.buildDirectory.file("module-container.json").get().asFile
        val containerName = "module-${zb.vendor.get()}-${zb.product.get()}"

        if (jsonFile.exists()) {
            val info = DockerRunner.ContainerInfo.fromJson(jsonFile.readText())
            DockerRunner.stop(info.containerId, containerName)
            jsonFile.delete()
            logger.lifecycle("Module stopped (container: ${info.containerId.take(12)})")
        } else {
            // Fallback: stop by name if JSON file missing
            DockerRunner.stopByName(containerName)
            logger.lifecycle("Module stopped (container: $containerName)")
        }
    }
}

tasks.named("stopModule") { dependsOn(stopModuleExec) }

// ════════════════════════════════════════════════════════════
// PUBLISH
// ════════════════════════════════════════════════════════════

// -- Package.json version patching --------------------------------

/**
 * Patch package.json version field with reckon-calculated version.
 * Returns the original content for restoration.
 */
fun patchPackageJsonVersion(pkgFile: java.io.File, newVersion: String): String {
    val originalContent = pkgFile.readText()
    val patchedContent = originalContent.replace(
        Regex(""""version"\s*:\s*"[^"]+""""),
        """"version": "$newVersion""""
    )
    pkgFile.writeText(patchedContent)
    return originalContent
}

// Store original package.json content for restoration
var originalPackageJson: String? = null

val patchPackageJson by tasks.registering {
    group = "publish"
    description = "Patch package.json with reckon-calculated version"
    doLast {
        val pkgFile = project.file("package.json")
        val ver = project.version.toString()
        originalPackageJson = patchPackageJsonVersion(pkgFile, ver)
        logger.lifecycle("Patched package.json version to $ver")
    }
}

val restorePackageJson by tasks.registering {
    group = "publish"
    description = "Restore original package.json after publish"
    doLast {
        val pkgFile = project.file("package.json")
        val content = originalPackageJson
        if (content != null) {
            pkgFile.writeText(content)
            logger.lifecycle("Restored original package.json")
        }
    }
}

// -- NPM Publish (staging with --tag next) ------------------------

val isDryRun: Boolean = extra["isDryRun"] as Boolean
@Suppress("UNCHECKED_CAST")
val preflightChecks = extra["preflightChecks"] as TaskProvider<*>

val publishNpmExec by tasks.registering(NpmTask::class) {
    group = "publish"
    description = "Publish npm package to registry with --tag next (staging)"
    dependsOn(tasks.named("gate"), patchPackageJson, preflightChecks)
    finalizedBy(restorePackageJson)

    npmCommand.set(listOf("publish"))
    args.set(listOf("--tag", "next"))
    workingDir.set(project.projectDir)

    doFirst {
        if (isDryRun) {
            val (name, _) = readPackageNameVersion()
            val ver = project.version.toString()
            logger.lifecycle("[DRY RUN] Would publish ${name}@${ver} with --tag next")
            throw org.gradle.api.tasks.StopExecutionException()
        }
    }
}

// ════════════════════════════════════════════════════════════
// HUB E2E — fixture setup + Hub Client test execution
//
// setupFixtures: CLI-only fixture chain (no SQL)
//   1. zbb dataloader -d .                    (load module artifacts)
//   2. hub-node server node list --json        (get registered node ID)
//   3. hub-node deployments create --module    (create deployment)
//   4. hub-node server boundaries list --json  (get boundary ID)
//   5. hub-node connections create             (create connection)
//
// testHub: depends on setupFixtures, runs mocha with TEST_MODE=hub
// ════════════════════════════════════════════════════════════

/**
 * Read module name and version from package.json using regex.
 * Returns (name, version) or throws if not found.
 */
fun readPackageNameVersion(): Pair<String, String> {
    val pkgJson = project.file("package.json")
    require(pkgJson.exists()) { "package.json not found in ${project.projectDir}" }
    val content = pkgJson.readText()
    val name = Regex(""""name"\s*:\s*"([^"]+)"""").find(content)?.groupValues?.get(1)
        ?: throw org.gradle.api.GradleException("Cannot find 'name' in package.json")
    val version = Regex(""""version"\s*:\s*"([^"]+)"""").find(content)?.groupValues?.get(1)
        ?: throw org.gradle.api.GradleException("Cannot find 'version' in package.json")
    return name to version
}

/**
 * Run a CLI command, capture stdout, and parse it as JSON array or object.
 * Returns the raw JSON string for caller to parse.
 * Uses slot env (already in process.env via ZbbSlotProvider).
 */
fun runCliJson(vararg command: String): String {
    return com.zerobias.buildtools.util.ExecUtils.execCapture(
        command = command.toList(),
        workingDir = project.projectDir,
        environment = emptyMap(), // inherits Gradle process env (slot vars already set)
        throwOnError = true
    ).trim()
}

val setupFixtures by tasks.registering {
    group = "lifecycle"
    description = "Set up Hub e2e test fixtures: dataloader, deployment, connection"
    dependsOn(tasks.named("compile"))
    onlyIf { project.file("test/e2e").exists() }
    doLast {
        // Resolve slot env (needed for CLI commands that read SERVER_URL, API_KEY, etc.)
        com.zerobias.buildtools.util.ZbbSlotProvider.requireActiveSlot()

        val (moduleKey, moduleVersion) = readPackageNameVersion()
        logger.lifecycle("setupFixtures: $moduleKey@$moduleVersion")

        // ── Step 1: Load module artifacts via dataloader ───────────────────
        logger.lifecycle("setupFixtures: Step 1 — loading module artifacts via zbb dataloader")
        com.zerobias.buildtools.util.ExecUtils.exec(
            command = listOf("zbb", "dataloader", "-d", "."),
            workingDir = project.projectDir,
            throwOnError = true
        )

        // ── Step 2: Get registered node ID ─────────────────────────────────
        logger.lifecycle("setupFixtures: Step 2 — getting registered node ID")
        val nodeListJson = runCliJson("hub-node", "--json", "server", "node", "list")
        // Parse: [{id: "...", ...}]
        val nodeId = run {
            val idMatch = Regex(""""id"\s*:\s*"([0-9a-f-]{36})"""").find(nodeListJson)
                ?: throw org.gradle.api.GradleException(
                    "setupFixtures: No node ID found in `hub-node server node list` output.\n" +
                    "Ensure a hub-node is registered and paired. Output:\n$nodeListJson"
                )
            idMatch.groupValues[1]
        }
        logger.lifecycle("setupFixtures: Node ID = $nodeId")

        // ── Step 3: Create deployment ───────────────────────────────────────
        logger.lifecycle("setupFixtures: Step 3 — creating deployment for $moduleKey@$moduleVersion on node $nodeId")
        val deployJson = runCliJson(
            "hub-node", "--json", "deployments", "create",
            "--module", "$moduleKey@$moduleVersion",
            "--node-id", nodeId
        )
        // Parse deployment ID from JSON response
        val deploymentId = run {
            val idMatch = Regex(""""id"\s*:\s*"([0-9a-f-]{36})"""").find(deployJson)
                ?: throw org.gradle.api.GradleException(
                    "setupFixtures: No deployment ID in `hub-node deployments create` output.\n$deployJson"
                )
            idMatch.groupValues[1]
        }
        logger.lifecycle("setupFixtures: Deployment ID = $deploymentId")

        // ── Step 4: Get boundary ID ─────────────────────────────────────────
        logger.lifecycle("setupFixtures: Step 4 — getting boundary ID")
        val boundaryListJson = runCliJson("hub-node", "--json", "server", "boundaries", "list")
        val boundaryId = run {
            val idMatch = Regex(""""id"\s*:\s*"([0-9a-f-]{36})"""").find(boundaryListJson)
                ?: throw org.gradle.api.GradleException(
                    "setupFixtures: No boundary ID in `hub-node server boundaries list` output.\n$boundaryListJson"
                )
            idMatch.groupValues[1]
        }
        logger.lifecycle("setupFixtures: Boundary ID = $boundaryId")

        // ── Step 5: Create connection ────────────────────────────────────────
        // Connection name: first capitalized word of module key + " E2E"
        val moduleName = moduleKey.substringAfterLast('/').split('-').last().replaceFirstChar { it.uppercase() }
        val connectionName = "$moduleName E2E"
        logger.lifecycle("setupFixtures: Step 5 — creating connection '$connectionName'")
        val connJson = runCliJson(
            "hub-node", "--json", "connections", "create",
            "--deployment-id", deploymentId,
            "--boundary-id", boundaryId,
            "--name", connectionName,
            "--mode", "auto"
        )
        val targetId = run {
            val idMatch = Regex(""""id"\s*:\s*"([0-9a-f-]{36})"""").find(connJson)
                ?: throw org.gradle.api.GradleException(
                    "setupFixtures: No connection ID in `hub-node connections create` output.\n$connJson"
                )
            idMatch.groupValues[1]
        }
        logger.lifecycle("setupFixtures: Connection (TARGET_ID) = $targetId")

        // Export fixture IDs for testHub task
        project.ext.set("SETUP_FIXTURES_TARGET_ID", targetId)
        project.ext.set("SETUP_FIXTURES_DEPLOYMENT_ID", deploymentId)
        logger.lifecycle("setupFixtures: complete. TARGET_ID=$targetId DEPLOYMENT_ID=$deploymentId")
    }
}

val testHubExec by tasks.registering(NpxTask::class) {
    group = "lifecycle"
    description = "Run Hub Client e2e tests (TEST_MODE=hub) via mocha"
    dependsOn(setupFixtures)
    workingDir.set(project.projectDir)
    command.set("mocha")
    args.set(listOf(
        "--config", ".mocharc.json",
        "--inline-diffs",
        "--reporter=list",
        "--timeout", "120000",
        "test/e2e/github.test.ts"
    ))
    onlyIf { project.file("test/e2e").exists() }
    doFirst {
        val targetId = project.ext.get("SETUP_FIXTURES_TARGET_ID") as? String
            ?: throw org.gradle.api.GradleException(
                "testHub: SETUP_FIXTURES_TARGET_ID not set — did setupFixtures fail?"
            )
        environment.put("TEST_MODE", "hub")
        environment.put("TARGET_ID", targetId)
        logger.lifecycle("testHubExec: TEST_MODE=hub TARGET_ID=$targetId")
    }
}

val testHub by tasks.registering {
    group = "lifecycle"
    description = "Run Hub Client e2e tests (full stack through Hub Server)"
    dependsOn(testHubExec)
}

tasks.named("publishNpm") {
    dependsOn(publishNpmExec)
}

val publishImageExec by tasks.registering(Exec::class) {
    group = "publish"
    description = "Push Docker image to registry"
    dependsOn(tasks.named("buildImage"), preflightChecks)
    onlyIf { zb.hasConnectionProfile.get() }
    workingDir(project.projectDir)
    // commandLine set lazily in doFirst to avoid failing at configuration time
    // when ECR_REGISTRY is not yet available
    commandLine("echo", "publishImageExec: not configured")

    doFirst {
        val registry = System.getenv("ECR_REGISTRY")
            ?: throw GradleException("ECR_REGISTRY not set in slot env — add to zbb.yaml")
        val imageName = zb.dockerImageName.get()
        // Strip build metadata (+...) from reckon version — not valid in Docker tags
        val ver = project.version.toString().substringBefore("+")
        if (isDryRun) {
            logger.lifecycle("[DRY RUN] Would push ${registry}/${imageName}:${ver}")
            throw org.gradle.api.tasks.StopExecutionException()
        }
        commandLine("docker", "push", "${registry}/${imageName}:${ver}")
    }
}

tasks.named("publishImage") {
    dependsOn(publishImageExec)
}
