package com.zerobias.buildtools.tasks

import org.gradle.api.Project
import java.io.File

/**
 * Context passed to each NeonDataloaderTask.postLoadActions entry.
 *
 * Actions run inside the same try-block that runs dataloader, AFTER the
 * load succeeds and BEFORE the finally branch teardown. They see the live
 * Postgres credentials in `pgEnv` and can spawn subprocesses against the
 * branch.
 *
 * If an action throws, the exception propagates: the finally still
 * tears the branch down, and the gate fails. This is the right shape
 * for things like TS interface generation, which must fail the gate if
 * the generator can't produce valid output for the loaded schema.
 */
data class NeonBranchContext(
    /** Project this task belongs to. Use for project.version, project.file, etc. */
    val project: Project,
    /**
     * The directory dataloader was pointed at (the package being loaded).
     * Use this as the working dir for any post-load codegen — NOT
     * project.projectDir, since for hub-style content packages they can
     * differ.
     */
    val packageDir: File,
    /**
     * PG environment that dataloader saw. Inject into any ProcessBuilder
     * that needs to read from the loaded branch:
     *   ProcessBuilder(cmd).apply { environment().putAll(ctx.pgEnv) }
     *
     * Keys: PGHOST, PGPORT, PGUSER, PGPASSWORD, PGDATABASE, PGSSLMODE.
     */
    val pgEnv: Map<String, String>,
)
