package com.zerobias.buildtools.tasks

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
 *
 * Skips cleanly (no failure) when ZB_TOKEN is not set — lets local dev
 * without vault proceed without blowing up gate. CI jobs that require
 * dataloader validation must ensure the slot exposes ZB_TOKEN.
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

    init {
        group = "lifecycle"
        description = "Run dataloader against an ephemeral Neon branch (via dataloader-service)"
        // Fresh Neon branch every invocation; no sensible up-to-date signal.
        outputs.upToDateWhen { false }
        // onlyIf: skip entirely when ZB_TOKEN isn't available.
        onlyIf {
            val hasToken = System.getenv("ZB_TOKEN")?.isNotBlank() == true
            if (!hasToken) {
                logger.lifecycle("${name}: ZB_TOKEN not set — skipping")
            }
            hasToken
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
            ?: throw GradleException(
                "${name}: ZB_TOKEN is not set. testDataloader requires ZB_TOKEN " +
                "for ZeroBias production authentication against the dataloader-service /branches endpoint."
            )

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

            val cmd = mutableListOf("dataloader")
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
        }
    }

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
 * One name across the codebase keeps the EventEmitter display map and
 * zbb's failure reporter trivial — no per-plugin aliasing, no drift.
 */
fun Project.registerDataloader(
    force: Boolean = false,
    forceDirect: Boolean = false,
    configure: NeonDataloaderTask.() -> Unit = {},
): TaskProvider<NeonDataloaderTask> =
    tasks.register(DATALOADER_TASK_NAME, NeonDataloaderTask::class.java) {
        packageDir.set(layout.projectDirectory)
        this.force.set(force)
        this.forceDirect.set(forceDirect)
        val safeProjectName = path.removePrefix(":").replace(":", "-")
        displayLogPath.set(
            rootProject.layout.projectDirectory
                .file("$ZBB_GRADLE_DIR/logs/$safeProjectName-dataloader.log")
        )
        configure()
    }

/**
 * Resolve the dataloader force mode for the current build, returning
 * `(force, forceDirect)` to pass into [registerDataloader].
 *
 * Precedence (first match wins):
 *
 *   1. `-Pdataloader.force=true`        → `-f`              (panic: reload everything)
 *   2. `-Pdataloader.forceDirect=true`  → `--force-direct`  (reload top-level only)
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
fun Project.resolveDataloaderForceMode(): Pair<Boolean, Boolean> {
    val forceProp = providers.gradleProperty("dataloader.force").orNull?.toBoolean() ?: false
    val forceDirectProp = providers.gradleProperty("dataloader.forceDirect").orNull?.toBoolean() ?: false
    val isCi = System.getenv("CI") == "true"
    val useForce = forceProp || (isCi && !forceDirectProp)
    val useForceDirect = !useForce && (forceDirectProp || !isCi)
    return useForce to useForceDirect
}

const val DATALOADER_TASK_NAME = "dataloaderExec"
