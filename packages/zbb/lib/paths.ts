/**
 * Shared filesystem path constants used across zbb modules.
 *
 * Centralized so renames happen in exactly one place. Mirrors the kotlin
 * `PathConstants.ZBB_GRADLE_DIR` from build-tools — keep them in sync.
 */

/**
 * Repo-relative directory for gradle's auxiliary outputs:
 *   - gradle.log         — combined console capture (truncated per run)
 *   - events.jsonl       — task lifecycle events for the TUI
 *   - logs/              — per-task stdout/stderr files
 *   - publish-plan.json  — pending-publish snapshot
 *   - java-publish.json  — Maven Central publish targets
 *
 * Was `.zbb-monorepo`; renamed to `.zbb-gradle` since both standard and
 * monorepo lifecycles share the directory.
 */
export const ZBB_GRADLE_DIR = '.zbb-gradle';
