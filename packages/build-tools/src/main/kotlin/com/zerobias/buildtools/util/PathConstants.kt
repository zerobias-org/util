package com.zerobias.buildtools.util

/**
 * Shared filesystem path constants used across plugins.
 *
 * Centralized so renames (e.g. .zbb-monorepo → .zbb-gradle) happen in
 * exactly one place. Reference these from any plugin or task that
 * writes to the repo's gradle output directory.
 */
object PathConstants {
    /**
     * Repo-relative directory for gradle's auxiliary outputs:
     *   - gradle.log         — combined console capture (truncated per run)
     *   - events.jsonl       — task lifecycle events for the TUI
     *   - logs/              — per-task stdout/stderr files
     *   - publish-plan.json  — pending-publish snapshot
     *   - java-publish.json  — Maven Central publish targets
     *   - gate-check.marker  — gate validation marker
     *
     * Was `.zbb-monorepo`; renamed to `.zbb-gradle` since both standard
     * and monorepo lifecycles share the directory.
     */
    const val ZBB_GRADLE_DIR = ".zbb-gradle"
}
