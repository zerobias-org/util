package com.zerobias.buildtools.tasks

import com.zerobias.buildtools.monorepo.Prepublish
import com.zerobias.buildtools.util.CurlUtils
import com.zerobias.buildtools.util.ExecUtils
import com.zerobias.buildtools.util.PackageJsonReader
import com.zerobias.buildtools.util.PathConstants.ZBB_GRADLE_DIR
import org.gradle.api.Action
import org.gradle.api.DefaultTask
import org.gradle.api.GradleException
import org.gradle.api.Project
import org.gradle.api.file.DirectoryProperty
import org.gradle.api.file.RegularFileProperty
import org.gradle.api.provider.ListProperty
import org.gradle.api.provider.Property
import org.gradle.api.tasks.Input
import org.gradle.api.tasks.InputDirectory
import org.gradle.api.tasks.Internal
import org.gradle.api.tasks.Optional
import org.gradle.api.tasks.OutputFile
import org.gradle.api.tasks.TaskAction
import org.gradle.api.tasks.TaskProvider
import java.io.File
import java.nio.file.Files

/**
 * Gradle task that runs the platform `dataloader` CLI against an ephemeral
 * Neon Postgres branch provisioned by the platform dataloader-service.
 *
 * Flow: POST `/api/dataloader/branches` with `ZB_TOKEN` to create a
 * short-lived branch, run the dataloader CLI against the returned PG
 * connection info, then DELETE the branch (best-effort — the service
 * also enforces an `expiresAt` backstop).
 *
 * Required env (resolved from the slot via vault refs in each plugin's
 * zbb.yaml):
 *   ZB_TOKEN  — ZeroBias platform API key. Must belong to a superuser, or
 *               to a principal that is org-admin of the org context the
 *               request is made against. The service rejects everything
 *               else with 403.
 *
 * Optional env:
 *   DATALOADER_SERVICE_URL — override the dataloader-service base URL.
 *                            Defaults to `https://app.zerobias.com/api/dataloader`.
 *   DATALOADER_SPEC        — npm spec the loader is run from via `npx` for this
 *                            content-master gate. Defaults to
 *                            `@zerobias-com/platform-dataloader@prod` (the version in
 *                            prod), or to the env's loader under DATALOADER_ENV.
 *                            Override for loader dev (a version, @latest, or a local
 *                            `file:` path).
 *   DATALOADER_ENV         — `dev` or `qa` checks the package against that environment
 *                            instead of prod: the branch is still forked from
 *                            content-master (prod data only), but it is brought to the
 *                            hydra schema that env runs before the load, and the load
 *                            uses that env's loader. The gate stamp records it, so the
 *                            package can publish to that env but not to uat or main.
 *                            See [envChannel].
 *
 * Without ZB_TOKEN (unset or blank) a local run skips the load, so a gate
 * without vault still runs everything else. zb.base's `writeGateStamp` then
 * records `dataloaderExec` as skipped (unless the stamp it replaces passed the
 * load for the same source), and `gate --check` and publish refuse that
 * stamp. Under `CI=true` the task fails instead: see [dataloaderTokenCheck].
 *
 * Usage: leaf plugins call the [registerDataloader] helper at the bottom
 * of this file, NOT `tasks.register<NeonDataloaderTask>(...)` directly,
 * so name + log-path conventions stay consistent across plugin types
 * and the EventEmitter display map only needs one entry.
 */
abstract class NeonDataloaderTask : DefaultTask() {

    @get:InputDirectory
    @get:Optional
    abstract val packageDir: DirectoryProperty

    /**
     * Pass `-f` to the dataloader CLI. Needed when the parent branch's
     * snapshot may already contain the artifact at the same version — without
     * `-f` the loader exits 0 after a no-op skip and the gate stamps green
     * without ever validating the new bits.
     *
     * `-f` forces a reload of the top-level package AND every transitive
     * dependency, regardless of whether the DB already has them at the same
     * `name@version`. Use this when the parent branch may be stale or
     * corrupted (typical for CI's fresh-branch model).
     *
     * For most local iteration prefer [forceDirect] instead — it forces the
     * top-level reload (preserving the no-op-skip safety net) but lets
     * transitive deps short-circuit when their version is already loaded,
     * which avoids the multi-minute walk of every schema/vendor dep.
     *
     * If both [force] and [forceDirect] are set, [force] wins.
     */
    @get:Input
    @get:Optional
    abstract val force: Property<Boolean>

    /**
     * Pass `--force-direct` to the dataloader CLI. Forces a reload of the
     * top-level package only — transitive deps fall through to the normal
     * "is this name@version already loaded?" check and are skipped on hit.
     *
     * Preserves the safety net that motivates [force] (top-level is still
     * always re-loaded, so a no-op skip can't stamp the gate green without
     * validation), while skipping the per-transitive load that dominates
     * runtime when the DB already has the full dep graph.
     *
     * Ignored when [force] is also set.
     */
    @get:Input
    @get:Optional
    abstract val forceDirect: Property<Boolean>

    /**
     * Optional path to write the captured dataloader output to. When set,
     * matches the `.zbb-gradle/logs/<task>.log` convention used by other
     * Exec tasks so zbb's failure reporter finds the log.
     */
    @get:OutputFile
    @get:Optional
    abstract val displayLogPath: RegularFileProperty

    /**
     * Optional callbacks invoked AFTER the dataloader load succeeds and
     * BEFORE the Neon branch is torn down. Each action receives a
     * [NeonBranchContext] with the live PG env, so it can run additional
     * tools (codegen, validators) against the loaded schema while the
     * branch is still alive.
     *
     * Used by `zb.schema` to generate TS interface twins from the loaded
     * dataloader output. If an action throws, the exception propagates —
     * the branch still tears down in `finally`, and the task fails.
     *
     * Empty by default; existing zb.content / zb.typescript-* consumers
     * are unaffected.
     */
    @get:Internal
    abstract val postLoadActions: ListProperty<Action<NeonBranchContext>>

    /**
     * Identifier for this run. The service prepends `test/` and appends a
     * timestamp, so the final branch name is `test/{testName}-{epochMs}`.
     * Defaults to the package.json `name` with `@` stripped and `/` → `-`.
     */
    @get:Input
    @get:Optional
    abstract val testName: Property<String>

    /**
     * Optional parent branch name (default branch the new branch is forked
     * from). When unset, the service uses its configured default
     * (typically `content-master`).
     */
    @get:Input
    @get:Optional
    abstract val parentBranch: Property<String>

    /**
     * Backstop expiry in seconds. If unset, the service uses its default
     * (10800 = 3h).
     */
    @get:Input
    @get:Optional
    abstract val ttlSeconds: Property<Int>

    /**
     * The environment (`dev` or `qa`) the package is checked against instead of prod. When set,
     * the gate runs that environment's loader (`platform-dataloader@<env>`, the dist-tag dev-slots
     * moves on each deploy, as prod-apply does for `prod`) and, before loading, applies to the
     * content-master branch the hydra-schema version that loader was built against (its stamped
     * `schemaVersion`). The data stays prod's; the schema and loader are the ones the environment
     * runs, so content that needs platform or hydra work not yet in prod can be tested there first.
     *
     * [registerDataloader] sets it from `DATALOADER_ENV` ([requestedDataloaderEnv]); unset keeps
     * the prod check. Because it is asked for explicitly, a missing dist-tag, a missing `sem-apply`
     * or a loader without a `schemaVersion` fails the task rather than quietly checking prod.
     */
    @get:Input
    @get:Optional
    abstract val envChannel: Property<String>

    init {
        group = "lifecycle"
        description = "Run dataloader against an ephemeral Neon branch (via dataloader-service)"
        // Fresh Neon branch every invocation; no sensible up-to-date signal.
        outputs.upToDateWhen { false }
        // Only a local run without ZB_TOKEN skips; under CI=true the action runs and fails on the missing token.
        onlyIf {
            val skip = dataloaderTokenCheck(System.getenv("ZB_TOKEN"), System.getenv("CI")) == DataloaderTokenCheck.SKIP
            if (skip) {
                logger.lifecycle(
                    "${name}: ZB_TOKEN not set — skipping the load. Unless the previous gate stamp passed the load " +
                    "for this same source, the new stamp records it as skipped, which gate --check and publish refuse."
                )
            }
            !skip
        }
    }

    @TaskAction
    fun execute() {
        executeViaDataloaderService()
    }

    private fun executeViaDataloaderService() {
        val pkgDir: File = if (packageDir.isPresent) packageDir.get().asFile else project.projectDir
        val workingDir = project.projectDir

        val token = System.getenv("ZB_TOKEN")?.takeIf { it.isNotBlank() }
            ?: throw GradleException(missingTokenMessage(name))

        val resolvedTestName = (testName.orNull?.takeIf { it.isNotBlank() } ?: run {
            val (pkgName, _) = PackageJsonReader.readNameVersion(File(pkgDir, "package.json"))
            pkgName.replace("@", "").replace("/", "-")
        }).replace(Regex("[^a-zA-Z0-9_-]"), "-")

        // ── 1: Ask dataloader-service for an ephemeral branch ──
        val createBody = buildCreateBody(resolvedTestName, parentBranch.orNull, ttlSeconds.orNull)
        logger.lifecycle("${name}: Requesting Neon branch via dataloader-service for '$resolvedTestName'")
        val createOutput = CurlUtils.withRetry(
            listOf(
                "curl", "-s", "--fail-with-body",
                "-H", "Authorization: APIKey $token",
                "-H", "Content-Type: application/json",
                "-X", "POST",
                "-d", createBody,
                "${serviceBaseUrl()}/branches"
            ),
            workingDir,
            "${name}: POST /branches",
        ) { msg -> logger.lifecycle("${name}: $msg") }

        val creds = parseBranchCredentials(createOutput)
        logger.lifecycle("${name}: Neon branch ready")
        logger.lifecycle("  branchId   = ${creds.branchId}")
        logger.lifecycle("  branchName = ${creds.branchName}")
        logger.lifecycle("  PGHOST     = ${creds.host}")
        logger.lifecycle("  PGPORT     = ${creds.port}")
        logger.lifecycle("  PGUSER     = ${creds.user}")
        logger.lifecycle("  PGDATABASE = ${creds.database}")
        logger.lifecycle("  PGSSLMODE  = ${creds.sslMode}")
        logger.lifecycle("  expiresAt  = ${creds.expiresAt}")

        var envSetup: EnvSetup? = null
        try {
            // ── 2: Run dataloader against the branch ──
            val pgEnv = mapOf(
                "PGHOST" to creds.host,
                "PGPORT" to creds.port.toString(),
                "PGUSER" to creds.user,
                "PGPASSWORD" to creds.password,
                "PGDATABASE" to creds.database,
                "PGSSLMODE" to creds.sslMode
            )

            // DATALOADER_ENV brings the branch to that env's hydra schema before seeding or loading.
            envSetup = resolveEnvSetup(workingDir)
            envSetup?.let { applyEnvSchema(it, pgEnv) }

            // ── 2a: If the artifact is org-private (zerobias.orgId set in
            //   package.json), seed the org's hydra.principal / hydra.org
            //   rows into the freshly-forked branch BEFORE the dataloader
            //   runs. content-master only carries the base ops org; without
            //   this seed the dataloader's `resource_owner_id_fkey` FK
            //   bites on the first INSERT. Idempotent + branch-local —
            //   never touches the parent.
            val orgId = PackageJsonReader.extractZerobiasOrgId(File(pkgDir, "package.json"))
            if (orgId != null) {
                logger.lifecycle("${name}: Seeding org $orgId into branch (zerobias.orgId present)")
                seedOrgIntoBranch(orgId, pgEnv, workingDir)
            }

            val loaderSpec = loaderSpec(envSetup)
            // --ignore-scripts: the published loader ships pre-built (no build/prepare
            // needed), and a transitive dep (ip-num) has a `preinstall` (`npx only-allow
            // npm`) that exits 127 and would otherwise fail npx's on-demand install.
            // Mirrors the `--ignore-scripts` on the CI global install of the loader.
            val cmd = mutableListOf("npx", "--yes", "--ignore-scripts", "--package", loaderSpec, "dataloader")
            when {
                force.getOrElse(false) -> cmd.add("-f")
                forceDirect.getOrElse(false) -> cmd.add("--force-direct")
            }
            cmd.addAll(listOf("-d", pkgDir.absolutePath))

            logger.lifecycle("${name}: Running ${cmd.joinToString(" ")}")
            val dl = ProcessBuilder(cmd)
                .directory(pkgDir)
                .redirectErrorStream(true)
                .apply { environment().putAll(pgEnv) }
                .start()

            val output = StringBuilder()
            dl.inputStream.bufferedReader().forEachLine { line ->
                logger.lifecycle("  [dataloader] $line")
                output.appendLine(line)
            }
            val exit = dl.waitFor()

            if (displayLogPath.isPresent) {
                val logFile = displayLogPath.get().asFile
                logFile.parentFile.mkdirs()
                logFile.writeText(output.toString())
            }

            if (exit != 0) {
                throw GradleException("${name}: dataloader exited with code $exit\n$output")
            }
            logger.lifecycle("${name}: dataloader completed successfully")

            // ── 2b: Post-load actions (e.g. zb.schema TS twin gen) ──
            // Fire AFTER dataloader load succeeds. Branch is still alive;
            // PG env still valid. If an action throws the exception
            // propagates and finally still tears the branch down.
            val actions = postLoadActions.getOrElse(emptyList())
            if (actions.isNotEmpty()) {
                logger.lifecycle("${name}: running ${actions.size} post-load action(s)")
                val ctx = NeonBranchContext(
                    project = project,
                    packageDir = pkgDir,
                    pgEnv = pgEnv,
                )
                actions.forEach { action -> action.execute(ctx) }
            }
        } finally {
            // ── 3: Best-effort delete via dataloader-service ──
            //   DELETE is idempotent: a 404 means the branch is already gone —
            //   exactly the desired end state — so treat it as success instead
            //   of dumping the service's raw error body (the old `--fail-with-body`
            //   streamed a scary 404 JSON + stack trace for a harmless cleanup).
            //   Any other failure is non-fatal: the branch self-cleans at
            //   expiresAt. We capture only the HTTP status (-o /dev/null) so no
            //   response body reaches the console.
            try {
                val httpCode = ExecUtils.execCapture(
                    command = listOf(
                        "curl", "-s", "-o", "/dev/null", "-w", "%{http_code}",
                        "-X", "DELETE",
                        "-H", "Authorization: APIKey $token",
                        "${serviceBaseUrl()}/branches/${creds.branchId}"
                    ),
                    workingDir = workingDir,
                    throwOnError = false
                ).trim()
                when {
                    httpCode.startsWith("2") ->
                        logger.lifecycle("${name}: deleted branch ${creds.branchId}")
                    httpCode == "404" ->
                        logger.lifecycle("${name}: branch ${creds.branchId} already gone — nothing to delete")
                    else ->
                        logger.warn(
                            "${name}: branch ${creds.branchId} delete returned HTTP $httpCode " +
                            "— leaving it to self-clean at expiresAt"
                        )
                }
            } catch (e: Exception) {
                logger.warn(
                    "${name}: failed to delete branch ${creds.branchId}: ${e.message} " +
                    "— it self-cleans at expiresAt"
                )
            }
            envSetup?.tempDir?.deleteRecursively()
        }
    }

    /** What a `DATALOADER_ENV` check runs with: that env's loader, and the hydra-schema it was built against, unpacked. */
    private data class EnvSetup(
        val channel: String,
        val loaderVersion: String,
        val schemaVersion: String,
        val schemaDir: File,
        val tempDir: File,
    )

    /**
     * Resolves what a `DATALOADER_ENV` check runs with, or null for the prod check.
     *
     * The loader version comes from the env's dist-tag. The hydra-schema version is the
     * `schemaVersion` build-tools stamps into that loader's published package.json; the
     * registry's metadata leaves custom fields out, so it is read from the tarball. The
     * env was asked for explicitly, so anything missing for it is an error.
     */
    private fun resolveEnvSetup(workingDir: File): EnvSetup? {
        val channel = envChannel.orNull?.takeIf { it.isNotBlank() } ?: return null
        val loaderVersion = ExecUtils.execCapture(
            listOf("npm", "view", "$LOADER_PACKAGE@$channel", "version"), workingDir, throwOnError = false
        ).trim()
        if (!VERSION_REGEX.matches(loaderVersion)) {
            throw GradleException(
                "${name}: DATALOADER_ENV=$channel, but $LOADER_PACKAGE has no '$channel' dist-tag " +
                "(dev-slots' $channel deploy sets it)."
            )
        }
        if (ExecUtils.execCapture(listOf("sh", "-c", "command -v sem-apply"), workingDir, throwOnError = false).isBlank()) {
            throw GradleException(
                "${name}: DATALOADER_ENV=$channel applies the $channel hydra schema with sem-apply, which is not " +
                "installed: gem install schema-evolution-manager -v 0.9.47"
            )
        }

        val tempDir = Files.createTempDirectory("zb-env-schema-").toFile()
        try {
            val loaderDir = unpack("$LOADER_PACKAGE@$loaderVersion", File(tempDir, "loader"), workingDir)
            val schemaVersion = PackageJsonReader.extractString(File(loaderDir, "package.json").readText(), "schemaVersion")
                ?: throw GradleException(
                    "${name}: $LOADER_PACKAGE@$loaderVersion (the '$channel' tag) carries no schemaVersion, so the " +
                    "hydra schema it needs is unknown."
                )
            val schemaDir = unpack("${Prepublish.HYDRA_SCHEMA_PACKAGE}@$schemaVersion", File(tempDir, "schema"), workingDir)
            logger.lifecycle(
                "${name}: DATALOADER_ENV=$channel — checking on content-master with the $channel loader " +
                "($LOADER_PACKAGE@$loaderVersion) and its hydra schema (${Prepublish.HYDRA_SCHEMA_PACKAGE}@$schemaVersion)"
            )
            return EnvSetup(channel, loaderVersion, schemaVersion, schemaDir, tempDir)
        } catch (e: Exception) {
            tempDir.deleteRecursively()
            throw e
        }
    }

    /** Downloads [spec] with `npm pack` into [dir], unpacks it, and returns the package directory. */
    private fun unpack(spec: String, dir: File, workingDir: File): File {
        dir.mkdirs()
        val tarball = ExecUtils.execCapture(
            listOf("npm", "pack", spec, "--pack-destination", dir.absolutePath, "--silent"), workingDir
        ).lines().last { it.isNotBlank() }.trim()
        ExecUtils.execCapture(listOf("tar", "-xzf", File(dir, tarball).absolutePath, "-C", dir.absolutePath), workingDir)
        return File(dir, "package")
    }

    /**
     * Applies the env's hydra schema to the branch the way an environment's deploy does: `apply.sh`
     * (sem-apply, which skips every migration content-master already has) and then `grant.sh`, so
     * the loader's role can reach tables the new migrations created. A failure here is the hydra
     * release not applying on prod data, not a problem with the package being tested, and the
     * error says so.
     */
    private fun applyEnvSchema(setup: EnvSetup, pgEnv: Map<String, String>) {
        for (script in listOf("apply.sh", "grant.sh")) {
            logger.lifecycle("${name}: hydra-schema ${setup.schemaVersion}: running $script on the branch")
            val process = ProcessBuilder("bash", script)
                .directory(setup.schemaDir)
                .redirectErrorStream(true)
                .apply { environment().putAll(pgEnv) }
                .start()
            val output = StringBuilder()
            process.inputStream.bufferedReader().forEachLine { line ->
                if (script == "apply.sh") logger.lifecycle("  [hydra-schema] $line") else logger.info("  [hydra-schema] $line")
                output.appendLine(line)
            }
            val exit = process.waitFor()
            if (exit != 0) {
                throw GradleException(
                    "${name}: ${Prepublish.HYDRA_SCHEMA_PACKAGE}@${setup.schemaVersion} ($script) did not apply to " +
                    "the content-master branch (exit $exit). That is the hydra schema the ${setup.channel} loader " +
                    "needs, not a problem with this package.\n$output"
                )
            }
        }
    }

    /**
     * The npm spec the gate runs the loader from. It goes through `npx` so the gate doesn't depend on
     * whatever `dataloader` is on PATH, which the local `dataloader` task uses and which must not be
     * forced to prod. `DATALOADER_SPEC` wins (loader development: a version, `@latest` or a `file:`
     * path). A `DATALOADER_ENV` check runs that env's loader, pinned to the version its tag pointed
     * at. Everything else runs the loader prod runs: the `prod` dist-tag, which prod-apply moves to
     * the loader bundled in the deployed platform-dataloader-service on each promotion.
     */
    private fun loaderSpec(envSetup: EnvSetup?): String =
        System.getenv("DATALOADER_SPEC")?.takeIf { it.isNotBlank() }
            ?: envSetup?.let { "$LOADER_PACKAGE@${it.loaderVersion}" }
            ?: "$LOADER_PACKAGE@prod"

    // ── Internal ─────────────────────────────────────────────────────

    /**
     * Seed the minimum `hydra.principal` / `hydra.group_profile` / `hydra.org`
     * rows the dataloader needs for FK `resource_owner_id_fkey` to resolve
     * against the supplied orgId, into the branch reachable via [pgEnv].
     *
     * Mirrors the structure of `com/dana/test/seed-data.sql.template` but
     * runs entirely against the ephemeral branch — never the local stack
     * or content-master. All inserts are `ON CONFLICT DO NOTHING` so a
     * future content-master snapshot that already carries the org stays
     * unbroken.
     */
    private fun seedOrgIntoBranch(orgId: String, pgEnv: Map<String, String>, workingDir: File) {
        val sql = buildOrgSeedSql(orgId)
        val pb = ProcessBuilder("psql", "-v", "ON_ERROR_STOP=1", "-f", "-")
            .directory(workingDir)
            .redirectErrorStream(true)
            .apply { environment().putAll(pgEnv) }
        val process = pb.start()
        process.outputStream.bufferedWriter().use { it.write(sql) }

        val output = StringBuilder()
        process.inputStream.bufferedReader().forEachLine { line ->
            output.appendLine(line)
            logger.debug("  [psql:seed] $line")
        }
        val exit = process.waitFor()
        if (exit != 0) {
            throw GradleException(
                "${name}: org seed failed (exit $exit):\n$output"
            )
        }
    }

    private fun buildOrgSeedSql(orgId: String): String {
        // Namespace matches PrincipalDAO's UUID v5 namespace (hydra/dao
        // constants) so derived group ids align with what the platform
        // would compute itself if it owned this org row.
        val ns = "da6e5d7c-27ed-4749-8f5e-e330d89cc44f"
        val shortId = PackageJsonReader.stripUuidHyphens(orgId).take(8)
        val orgName = "Gate Test Org $shortId"
        val slug = "gate-test-$shortId"
        return """
            -- Seed org $orgId for ephemeral-branch dataloader validation.
            -- Idempotent: ON CONFLICT DO NOTHING / DO UPDATE so an already-
            -- present row from a parent-branch snapshot is preserved.

            -- Organization principal (self-owned)
            INSERT INTO hydra.principal (id, owner_id, name, type, status, enabled, origin)
            VALUES ('$orgId'::uuid, '$orgId'::uuid, '$orgName', 'ORG', 'active', true, 'system')
            ON CONFLICT (id) DO NOTHING;

            -- Admin group + profile
            INSERT INTO hydra.principal (id, owner_id, name, type, status, enabled, origin)
            VALUES (uuid_generate_v5('$ns'::uuid, '$orgName Admins.' || '$orgId'),
                    '$orgId'::uuid, '$orgName Admins', 'GROUP', 'active', true, 'system')
            ON CONFLICT (id) DO NOTHING;

            INSERT INTO hydra.group_profile (id)
            VALUES (uuid_generate_v5('$ns'::uuid, '$orgName Admins.' || '$orgId'))
            ON CONFLICT (id) DO NOTHING;

            -- Member group + profile
            INSERT INTO hydra.principal (id, owner_id, name, type, status, enabled, origin)
            VALUES (uuid_generate_v5('$ns'::uuid, '$orgName Members.' || '$orgId'),
                    '$orgId'::uuid, '$orgName Members', 'GROUP', 'active', true, 'system')
            ON CONFLICT (id) DO NOTHING;

            INSERT INTO hydra.group_profile (id)
            VALUES (uuid_generate_v5('$ns'::uuid, '$orgName Members.' || '$orgId'))
            ON CONFLICT (id) DO NOTHING;

            -- hydra.org row linking the admin/member groups
            INSERT INTO hydra.org (
                id, admin_group_id, member_group_id, slug,
                visibility, membership_policy,
                hidden, self_registration, invitations_enabled
            ) VALUES (
                '$orgId'::uuid,
                uuid_generate_v5('$ns'::uuid, '$orgName Admins.' || '$orgId'),
                uuid_generate_v5('$ns'::uuid, '$orgName Members.' || '$orgId'),
                '$slug',
                'private', 'private',
                false, false, true
            ) ON CONFLICT (id) DO NOTHING;

            -- Refresh RLS grants so the seeded rows are reachable.
            SELECT hydra.applyGrantsToAll();
        """.trimIndent()
    }

    private data class BranchCreds(
        val branchId: String,
        val branchName: String,
        val host: String,
        val port: Int,
        val user: String,
        val password: String,
        val database: String,
        val sslMode: String,
        val expiresAt: String
    )

    private fun buildCreateBody(name: String, parent: String?, ttl: Int?): String {
        val fields = mutableListOf("\"name\":${PackageJsonReader.jsonEscape(name)}")
        if (parent != null) fields.add("\"parentBranch\":${PackageJsonReader.jsonEscape(parent)}")
        if (ttl != null) fields.add("\"ttlSeconds\":$ttl")
        return "{${fields.joinToString(",")}}"
    }

    private fun parseBranchCredentials(json: String): BranchCreds {
        fun str(field: String) = PackageJsonReader.extractString(json, field)
            ?: throw GradleException("${name}: dataloader-service response missing '$field':\n$json")
        fun int(field: String) = Regex(""""$field"\s*:\s*(\d+)""").find(json)?.groupValues?.get(1)?.toInt()
            ?: throw GradleException("${name}: dataloader-service response missing '$field':\n$json")
        return BranchCreds(
            branchId = str("branchId"),
            branchName = str("branchName"),
            host = str("host"),
            port = int("port"),
            user = str("user"),
            password = str("password"),
            database = str("database"),
            sslMode = str("sslMode"),
            expiresAt = str("expiresAt")
        )
    }

    companion object {
        private const val DEFAULT_SERVICE_BASE_URL = "https://app.zerobias.com/api/dataloader"
        private const val LOADER_PACKAGE = "@zerobias-com/platform-dataloader"
        private val VERSION_REGEX = Regex("""\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?""")

        /**
         * Resolve the dataloader-service base URL. Reads `DATALOADER_SERVICE_URL`
         * if set (and non-blank); otherwise falls back to the hardcoded prod URL.
         */
        private fun serviceBaseUrl(): String =
            System.getenv("DATALOADER_SERVICE_URL")?.takeIf { it.isNotBlank() }
                ?: DEFAULT_SERVICE_BASE_URL
    }
}

/**
 * Canonical NeonDataloaderTask registration. Every leaf plugin
 * (zb.typescript / zb.typescript-collectorbot / zb.content) registers
 * exactly ONE worker named [DATALOADER_TASK_NAME] with the same conventions
 * (packageDir = projectDir, displayLog under .zbb-gradle/logs/), and then
 * wires it into whichever lifecycle phase its package type advertises:
 *
 *   - typescript modules + collectorbots: `tasks.named("testDataloader") { dependsOn(dataloaderExec) }`
 *   - content packages:                   `tasks.named("testIntegration") { dependsOn(dataloaderExec) }`
 *
 * Plugin-specific extras (force, mustRunAfter, postLoadActions, doFirst
 * spec-symlink, etc.) live in the [configure] block.
 *
 * It also sets [NeonDataloaderTask.envChannel] from `DATALOADER_ENV`
 * ([requestedDataloaderEnv]), so a gate can check the package against an
 * environment's loader and hydra schema instead of prod's.
 *
 * One name across the codebase keeps the EventEmitter display map and
 * zbb's failure reporter trivial — no per-plugin aliasing, no drift.
 */
fun Project.registerDataloader(
    force: Boolean = false,
    forceDirect: Boolean = false,
    configure: NeonDataloaderTask.() -> Unit = {},
): TaskProvider<NeonDataloaderTask> {
    val channel = requestedDataloaderEnv()
    return tasks.register(DATALOADER_TASK_NAME, NeonDataloaderTask::class.java) {
        packageDir.set(layout.projectDirectory)
        this.force.set(force)
        this.forceDirect.set(forceDirect)
        channel?.let { envChannel.set(it) }
        val safeProjectName = path.removePrefix(":").replace(":", "-")
        displayLogPath.set(
            rootProject.layout.projectDirectory
                .file("$ZBB_GRADLE_DIR/logs/$safeProjectName-dataloader.log")
        )
        configure()
    }
}

/**
 * Resolve the dataloader force mode for the current build, returning
 * `(force, forceDirect)` to pass into [registerDataloader].
 *
 * Precedence (first match wins; [dataloaderForceMode] applies it):
 *
 *   1. `-Pdataloader.force=true`        → `-f`              (panic: reload everything)
 *   2. `-Pdataloader.forceDirect=true`  → `--force-direct`  (reload top-level only, also
 *                                                            under CI; `zbb gate --force-direct`
 *                                                            sets this property)
 *   3. `CI=true`                        → `-f`              (fresh-branch CI safety —
 *                                                            matches zbb's CI rule)
 *   4. otherwise (local dev)            → `--force-direct`  (skip transitive deps that
 *                                                            already match name@version)
 *
 * Either way, the top-level package is always re-loaded — preserving the
 * "no-op skip can't stamp gate green" safety net documented on
 * [NeonDataloaderTask.force]. The difference is whether every transitive
 * schema/vendor also gets re-walked.
 *
 * Used by zb.typescript / zb.typescript-collectorbot / zb.content so all
 * three pipelines pick up the same env-aware default and the same `-P`
 * escape hatches.
 */
fun Project.resolveDataloaderForceMode(): Pair<Boolean, Boolean> = dataloaderForceMode(
    force = providers.gradleProperty("dataloader.force").orNull?.toBoolean() ?: false,
    forceDirect = providers.gradleProperty("dataloader.forceDirect").orNull?.toBoolean() ?: false,
    ci = System.getenv("CI") == "true",
)

/**
 * The precedence [resolveDataloaderForceMode] documents, as `(force, forceDirect)`, from the
 * `-Pdataloader.force` and `-Pdataloader.forceDirect` properties and whether `CI=true`.
 */
fun dataloaderForceMode(force: Boolean, forceDirect: Boolean, ci: Boolean): Pair<Boolean, Boolean> {
    val useForce = force || (ci && !forceDirect)
    val useForceDirect = !useForce && (forceDirect || !ci)
    return useForce to useForceDirect
}

/** What [NeonDataloaderTask] does about `ZB_TOKEN`; see [dataloaderTokenCheck]. */
enum class DataloaderTokenCheck { LOAD, SKIP, FAIL }

/**
 * Decides what [NeonDataloaderTask] does about `ZB_TOKEN` ([token]), which the dataloader-service
 * requires before it creates the content-master branch. With a token the task loads. Without one
 * (unset or blank) a local run skips the load, and zb.base's `writeGateStamp` records
 * `dataloaderExec` as skipped (unless the stamp it replaces passed the load for the same source),
 * which `gate --check` and publish refuse. Under `CI=true` ([ci]) the task fails instead
 * ([missingTokenMessage]): a CI job that reaches the load is there to run it, and a skip would
 * pass the job without the package ever being loaded.
 */
fun dataloaderTokenCheck(token: String?, ci: String?): DataloaderTokenCheck = when {
    !token.isNullOrBlank() -> DataloaderTokenCheck.LOAD
    ci == "true" -> DataloaderTokenCheck.FAIL
    else -> DataloaderTokenCheck.SKIP
}

/** The error [NeonDataloaderTask] fails with when it runs without `ZB_TOKEN`, which only a `CI=true` run does. */
fun missingTokenMessage(taskName: String): String =
    "$taskName: ZB_TOKEN is not set (or is blank). Under CI=true the dataloader check fails rather than " +
    "skip the load, since a skipped load would let the gate pass without loading the package. The " +
    "dataloader-service creates the content-master branch only for a ZB_TOKEN that is a ZeroBias API key " +
    "of a superuser or of an admin of the package's org: expose one to this job."

const val DATALOADER_TASK_NAME = "dataloaderExec"

/** Environments a package can be checked against instead of prod; see [NeonDataloaderTask.envChannel]. */
private val ENV_CHANNELS = setOf("dev", "qa")

/**
 * The environment `DATALOADER_ENV` asks the content-master dataloader check to run against (`dev`
 * or `qa`), or null for the prod check (unset or `prod`). [registerDataloader] hands it to
 * [NeonDataloaderTask.envChannel], and zb.base's `writeGateStamp` records it in the gate stamp as
 * `dataloaderEnv`, which is how publishes to uat and main refuse a package that was only checked
 * against dev or qa.
 */
fun requestedDataloaderEnv(): String? {
    val value = System.getenv("DATALOADER_ENV")?.trim()?.lowercase()
        ?.takeIf { it.isNotEmpty() && it != "prod" }
        ?: return null
    if (value !in ENV_CHANNELS) {
        throw GradleException("DATALOADER_ENV must be dev, qa or prod, not '$value'")
    }
    return value
}
