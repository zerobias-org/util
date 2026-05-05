/**
 * Lifecycle command helpers.
 *
 * Phase 3 collapsed the old three-tier dispatch (monorepo handler →
 * stack-from-cwd → gradle wrapper) into a single lifecycle dispatch in
 * cli.ts. This module now exports just the helpers that dispatch needs:
 * argument parsing for monorepo flags, lifecycle lookup against the
 * stack zbb.yaml, and the spawn-with-display helper.
 *
 * The legacy TS files (Builder.ts, Publisher.ts, GateStamp.ts,
 * ChangeDetector.ts, VerifyParity.ts, Workspace.ts) were deleted —
 * the Gradle plugins in `org/util/packages/build-tools` are now the
 * sole authoritative implementation.
 */

import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

// Sync `require` for use in ESM — we lazy-load Display.js without making
// the whole call chain async.
const requireCJS = createRequire(import.meta.url);

// ── Lifecycle dispatch surface ───────────────────────────────────────
//
// LIFECYCLE_COMMANDS / isLifecycleCommand / ParsedLifecycleArgs /
// parseLifecycleArgs moved to ../lifecycle.ts (shared between standard
// and monorepo modes). Re-exported here so downstream importers that
// still pull from ./monorepo/index.js keep working.
export {
  LIFECYCLE_COMMANDS,
  isLifecycleCommand,
  parseLifecycleArgs,
} from '../lifecycle.js';
export type { ParsedLifecycleArgs } from '../lifecycle.js';
import type { ParsedLifecycleArgs } from '../lifecycle.js';

// ── Lifecycle lookup ─────────────────────────────────────────────────

import type { LifecycleConfig } from '../config.js';
import { normalizeLifecycleEntry } from '../config.js';

/**
 * Look up a lifecycle command string. `gate --check` reads
 * `lifecycle.gateCheck` if defined. All other commands look up by
 * exact name. Returns null if no entry exists — caller falls through
 * to `./gradlew <command>`.
 *
 * Accepts both shorthand string form and object form (`{command,
 * tools?, env?}`); this function returns only the command string and
 * discards any gate metadata. The lifecycle dispatcher in cli.ts uses
 * `findLifecycleOwner` from config.ts instead, which returns the full
 * parsed entry so gates can run. This helper is retained for any
 * callers that only need the command string.
 */
export function lookupLifecycleCommand(
  lifecycle: LifecycleConfig | undefined,
  command: string,
  parsed: ParsedLifecycleArgs,
): string | null {
  if (!lifecycle) return null;

  const key = command === 'gate' && parsed.check ? 'gateCheck' : command;
  const raw = (lifecycle as Record<string, unknown>)[key];
  const entry = normalizeLifecycleEntry(raw);
  return entry ? entry.command : null;
}

// ── Spawn with display ───────────────────────────────────────────────

/**
 * Spawn a lifecycle command from the repo root with monorepo flag passthrough.
 *
 * For phases that produce per-task events (build, test, gate over a TTY),
 * uses the project-centric MonorepoDisplay to render a live table. For all
 * other commands, falls back to inherited stdio.
 *
 * Exits with the command's exit code via process.exit (returns Promise<never>).
 */
export async function spawnLifecycleAndExit(
  repoRoot: string,
  command: string,
  baseCommand: string,
  parsed: ParsedLifecycleArgs,
  opts?: { scopePackage?: string },
): Promise<never> {
  // Gradle flags (-P*) and the TUI display only apply when the lifecycle
  // command is a gradle invocation. We detect that by literal `./gradlew`
  // in the command — no heuristics, no assumptions about wrapper scripts.
  // Anything else runs verbatim through bash (the default execution env)
  // with no flag injection and no TUI display. If a user wants gradle-
  // aware behavior, the command should say `./gradlew`.
  const isGradleCommand = /(^|\s|&)\.\/gradlew(\s|$)/.test(baseCommand);

  const passthrough: string[] = [];
  if (isGradleCommand) {
    if (parsed.all) passthrough.push('-Pmonorepo.all=true');
    if (parsed.base) passthrough.push(`-Pmonorepo.base=${parsed.base}`);
    if (parsed.dryRun) passthrough.push('-PdryRun=true');
    if (parsed.force) passthrough.push('-Pforce=true');
    if (parsed.clean) passthrough.push('-Pcleanlocalregistry');
    if (opts?.scopePackage) passthrough.push(`-Pmonorepo.scope=${opts.scopePackage}`);
    // Anything zbb didn't recognize — forward to gradle verbatim so callers
    // can pass through `-PfooBar=true` etc. without zbb needing to know each
    // property name.
    passthrough.push(...parsed.remaining);
  }

  if (parsed.verbose) {
    const args = passthrough.length > 0 ? ` ${passthrough.join(' ')}` : '';
    console.log(`[zbb] lifecycle '${baseCommand}${args}'`);
  }

  // Use the project-centric display for commands that produce per-task events
  // (build, test, gate). Skip clean (single root task — no per-task events)
  // and gate --check (fast file read — no point spinning up the display).
  // Display also requires the command to BE gradle — the event tailer parses
  // gradle's per-task events, which arbitrary scripts don't emit.
  const forceDisplay = process.env.ZBB_FORCE_TTY === '1';
  const displayEligibleCommands = new Set(['build', 'test', 'gate', 'dockerBuild']);
  const isGateCheck = command === 'gate' && parsed.check;
  const useDisplay =
    isGradleCommand &&
    displayEligibleCommands.has(command) &&
    !isGateCheck &&
    (process.stdout.isTTY || forceDisplay);
  if (useDisplay) {
    const parts = baseCommand.trim().split(/\s+/);
    // Direct spawn skips shell parsing — a command with shell quoting,
    // semicolons, pipes, multi-line bodies, or env-var prefixes needs
    // bash to interpret it. Fall through to the bash -c path for those.
    const safeForDirectSpawn = parts.length > 0
      && !baseCommand.includes('|')
      && !baseCommand.includes('&&')
      && !baseCommand.includes(';')
      && !baseCommand.includes('"')
      && !baseCommand.includes("'")
      && !baseCommand.includes('\n')
      && !parts[0].includes('=');
    if (safeForDirectSpawn) {
      const cmd = parts[0];
      const args = [...parts.slice(1), ...passthrough];
      const { runWithDisplay } = requireCJS('./Display.js');
      const code = await runWithDisplay(repoRoot, cmd, args);
      process.exit(code);
    }
  }

  // Fallback path: bash -c "<full command>"
  const fullCommand = passthrough.length > 0
    ? `${baseCommand} ${passthrough.join(' ')}`
    : baseCommand;

  const result = spawnSync('bash', ['-c', fullCommand], {
    cwd: repoRoot,
    stdio: 'inherit',
    env: process.env,
  });

  process.exit(result.status ?? 1);
}

/**
 * Same as spawnLifecycleAndExit but for the fall-through case where
 * no lifecycle entry was defined. Spawns `./gradlew <command>` directly
 * with the same flag passthrough rules.
 *
 * The user's `zbb.yaml` doesn't have to enumerate every gradle task —
 * if there's no `lifecycle.<command>` entry, we just hand off to gradle
 * and let it report "task not found" if the task doesn't exist.
 */
export async function spawnGradleFallbackAndExit(
  repoRoot: string,
  command: string,
  parsed: ParsedLifecycleArgs,
  opts?: { scopePackage?: string },
): Promise<never> {
  const baseCommand = `./gradlew ${command}`;
  return spawnLifecycleAndExit(repoRoot, command, baseCommand, parsed, opts);
}
