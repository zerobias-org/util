package com.zerobias.buildtools.schema

import com.zerobias.buildtools.content.SchemaPrimitives
import com.zerobias.buildtools.tasks.NeonBranchContext
import com.zerobias.buildtools.util.ExecUtils
import org.gradle.api.GradleException
import java.io.File

/**
 * Generate a TypeScript twin for a schema package while the Neon branch
 * is alive (called from `NeonDataloaderTask.postLoadActions` via the
 * `zb.schema` plugin).
 *
 * Sequence — mirrors the legacy `prepublish.sh` + `generate.sh`:
 *
 *   1. Skip if zerobias.deprecated == true
 *   2. Install schema-ts-generator globally (mirrors legacy
 *      prepublish-init.sh — avoids ts/ lockfile drift in CI)
 *   3. Run GraphQL test-start against the loaded branch
 *      (fails the gate if the loaded schema can't build a GraphQL schema)
 *   4. Stage the bundled TS template (resources/ts-schema-package-template/)
 *      into <pkg>/ts/, patching placeholders
 *   5. npm install inside <pkg>/ts/ (drift-tolerant — ts/ is ephemeral)
 *   6. npx schema-ts-generator -p <zerobias.package> -o ./src
 *   7. Rewrite emitted *.ts files: add .js to relative imports (ESM/NodeNext)
 *   8. npx tsc → dist/
 *
 * All subprocesses inherit `ctx.pgEnv` so the generator can read from
 * the live branch.
 */
object SchemaTsGenerator {

    private const val TEMPLATE_RESOURCE_DIR = "ts-schema-package-template"

    @JvmStatic
    fun generate(ctx: NeonBranchContext) {
        val logger = ctx.project.logger
        val tag = "[schema-ts-gen] ${ctx.project.path}"

        val pkgJsonFile = ctx.packageDir.resolve("package.json")
        val pkgDoc = SchemaPrimitives.parseJson(pkgJsonFile)

        if (TsTemplatePatcher.isDeprecated(pkgDoc)) {
            logger.lifecycle("$tag schema is deprecated — skipping TS twin generation")
            return
        }

        val artifactName = (pkgDoc["name"] as? String)
            ?: throw GradleException("$tag package.json missing 'name'")
        val packageName = TsTemplatePatcher.readPackageName(pkgDoc)
        val version = ctx.project.version.toString()
        val repoDir = readRepoDirectory(pkgDoc)
            ?: throw GradleException(
                "$tag package.json missing repository.directory — required for TS twin"
            )
        val repoUrl = resolveRepoUrl(ctx)

        // 1. GraphQL test-start (validation step). Fail the gate on
        //    non-zero exit — same semantics as the legacy script.
        logger.lifecycle("$tag running GraphQL test-start")
        ExecUtils.exec(
            command = listOf("npx", "@zerobias-com/platform-graphql", "--test-start"),
            workingDir = ctx.packageDir,
            environment = ctx.pgEnv,
            throwOnError = true,
        )

        // 2. Stage template
        val tsDir = ctx.packageDir.resolve("ts")
        if (tsDir.exists()) tsDir.deleteRecursively()
        tsDir.mkdirs()
        stageTemplate(tsDir, artifactName, version, repoUrl, repoDir, packageName)

        // 3. npm ci inside ts/
        logger.lifecycle("$tag npm ci in ts/")
        ExecUtils.exec(
            command = listOf("npm", "ci"),
            workingDir = tsDir,
            environment = ctx.pgEnv,
            throwOnError = true,
        )

        // 4. Run the generator
        logger.lifecycle("$tag generating TS for package=$packageName")
        ExecUtils.exec(
            command = listOf("npx", "schema-ts-generator", "-p", packageName, "-o", "./src"),
            workingDir = tsDir,
            environment = ctx.pgEnv,
            throwOnError = true,
        )

        // 5. Fix ESM imports (.js suffix on relative imports)
        EsmImportFixer.fixDir(tsDir.resolve("src"))

        // 6. tsc → dist/
        logger.lifecycle("$tag tsc → dist/")
        ExecUtils.exec(
            command = listOf("npx", "tsc"),
            workingDir = tsDir,
            environment = ctx.pgEnv,
            throwOnError = true,
        )

        logger.lifecycle("$tag TS twin generated at ${tsDir.relativeTo(ctx.project.rootDir)}")
    }

    /**
     * Copy bundled template resources + patch placeholders. Resources
     * live under `src/main/resources/ts-schema-package-template/` and
     * are shipped inside the build-tools jar so consuming repos no
     * longer need to ship their own copy.
     */
    private fun stageTemplate(
        tsDir: File,
        artifactName: String,
        version: String,
        repoUrl: String,
        repoDir: String,
        packageName: String,
    ) {
        val templatePkg = loadResource("package-template.json")
        val templateLock = loadResource("package-lock-template.json")
        val tsconfig = loadResource("tsconfig.json")
        val npmrc = loadResource(".npmrc")

        TsTemplatePatcher.writePatchedTemplate(
            tsDir = tsDir,
            templatePkg = templatePkg,
            templateLock = templateLock,
            artifactName = artifactName,
            version = version,
            repoUrl = repoUrl,
            repoDir = repoDir,
            packageName = packageName,
        )
        tsDir.resolve("tsconfig.json").writeText(tsconfig)
        tsDir.resolve(".npmrc").writeText(npmrc)
    }

    private fun loadResource(name: String): String {
        val path = "/$TEMPLATE_RESOURCE_DIR/$name"
        val stream = SchemaTsGenerator::class.java.getResourceAsStream(path)
            ?: throw GradleException("[schema-ts-gen] template resource missing: $path")
        return stream.bufferedReader().use { it.readText() }
    }

    private fun readRepoDirectory(pkgDoc: Map<String, Any?>): String? {
        val repo = pkgDoc["repository"] as? Map<*, *> ?: return null
        return repo["directory"] as? String
    }

    /**
     * Best-effort: take rootProject's git remote so the bundled
     * package-template can carry a per-repo `repository.url`. If git
     * isn't available, log and fall back to a placeholder — the field
     * is informational, not load-bearing.
     */
    private fun resolveRepoUrl(ctx: NeonBranchContext): String {
        return try {
            val output = ExecUtils.exec(
                command = listOf("git", "config", "--get", "remote.origin.url"),
                workingDir = ctx.project.rootDir,
                throwOnError = false,
                captureOutput = true,
            ).trim()
            output.ifBlank { "git@github.com:unknown/schema.git" }
        } catch (_: Exception) {
            "git@github.com:unknown/schema.git"
        }
    }
}
