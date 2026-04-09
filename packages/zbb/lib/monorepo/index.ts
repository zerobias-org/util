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

// ── Lifecycle commands ───────────────────────────────────────────────
//
// These are the commands that route through the lifecycle dispatch in
// cli.ts. Anything else (slot/stack/registry/secret/env/logs/etc.) has
// its own subcommand handler. Anything not in this set and not a
// recognized subcommand falls through to the gradle wrapper.

const LIFECYCLE_COMMANDS = new Set([
  'clean',
  'build',
  'test',
  'gate',
  'publish',
]);

export function isLifecycleCommand(command: string): boolean {
  return LIFECYCLE_COMMANDS.has(command);
}

// ── Argument parsing ─────────────────────────────────────────────────

export interface ParsedLifecycleArgs {
  all: boolean;
  base?: string;
  dryRun: boolean;
  force: boolean;
  verbose: boolean;
  check: boolean;
  skipDocker: boolean;
  remaining: string[];
}

export function parseLifecycleArgs(args: string[]): ParsedLifecycleArgs {
  const result: ParsedLifecycleArgs = {
    all: false,
    dryRun: false,
    force: false,
    verbose: false,
    check: false,
    skipDocker: false,
    remaining: [],
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--all':
        result.all = true;
        break;
      case '--base':
        result.base = args[i += 1];
        break;
      case '--dry-run':
        result.dryRun = true;
        break;
      case '--force':
        result.force = true;
        break;
      case '--verbose':
      case '-v':
        result.verbose = true;
        break;
      case '--check':
        result.check = true;
        break;
      case '--skipDocker':
      case '--skip-docker':
        result.skipDocker = true;
        break;
      default:
        result.remaining.push(args[i]);
    }
  }

  return result;
}

// ── Lifecycle lookup ─────────────────────────────────────────────────

import type { LifecycleConfig } from '../config.js';

/**
 * Look up a lifecycle command. `gate --check` reads `lifecycle.gateCheck`
 * if defined, falling back to `lifecycle.gate`. All other commands look
 * up by exact name. Returns null if no entry exists — caller falls
 * through to `./gradlew <command>`.
 */
export function lookupLifecycleCommand(
  lifecycle: LifecycleConfig | undefined,
  command: string,
  parsed: ParsedLifecycleArgs,
): string | null {
  if (!lifecycle) return null;

  if (command === 'gate' && parsed.check && lifecycle.gateCheck) {
    return lifecycle.gateCheck;
  }

  const value = (lifecycle as Record<string, unknown>)[command];
  return typeof value === 'string' ? value : null;
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
): Promise<never> {
  const passthrough: string[] = [];
  if (parsed.all) passthrough.push('-Pmonorepo.all=true');
  if (parsed.base) passthrough.push(`-Pmonorepo.base=${parsed.base}`);
  if (parsed.dryRun) passthrough.push('-PdryRun=true');
  if (parsed.force) passthrough.push('-Pforce=true');

  if (parsed.verbose) {
    const args = passthrough.length > 0 ? ` ${passthrough.join(' ')}` : '';
    console.log(`[zbb] lifecycle '${baseCommand}${args}'`);
  }

  // Use the project-centric display for commands that produce per-task events
  // (build, test, gate). Skip clean (single root task — no per-task events)
  // and gate --check (fast file read — no point spinning up the display).
  const forceDisplay = process.env.ZBB_FORCE_TTY === '1';
  const displayEligibleCommands = new Set(['build', 'test', 'gate']);
  const isGateCheck = command === 'gate' && parsed.check;
  const useDisplay =
    displayEligibleCommands.has(command) &&
    !isGateCheck &&
    (process.stdout.isTTY || forceDisplay);
  if (useDisplay) {
    const parts = baseCommand.trim().split(/\s+/);
    if (parts.length > 0 && !baseCommand.includes('|') && !baseCommand.includes('&&')) {
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
): Promise<never> {
  const baseCommand = `./gradlew ${command}`;
  return spawnLifecycleAndExit(repoRoot, command, baseCommand, parsed);
}
