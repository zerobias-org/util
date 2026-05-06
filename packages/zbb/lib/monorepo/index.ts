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

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { createWriteStream, existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { ZBB_GRADLE_DIR } from '../paths.js';
import { findGradleRoot } from '../gradle.js';

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

  // Resolve `./gradlew` against the actual gradle root via walk-up.
  // Sub-package zbb.yaml files commonly reference `./gradlew <task>`
  // (often because the manifest is shipped with the published artifact
  // and assumes a consumer's local gradlew). When zbb runs that command
  // from the lifecycle owner's dir — which usually doesn't have its own
  // wrapper — bash fails with "./gradlew: No such file or directory".
  //
  // Rewrite to the absolute wrapper path found by walking up. cwd stays
  // at repoRoot so gradle's "current subproject from cwd" resolution
  // still scopes the task correctly (e.g., `./gradlew test` from
  // `stack/` becomes `<root>/gradlew test`, which gradle interprets as
  // `:stack:test`).
  let resolvedBaseCommand = baseCommand;
  if (/(^|\s|&)\.\/gradlew(\s|$)/.test(baseCommand) && !existsSync(join(repoRoot, 'gradlew'))) {
    const repo = findGradleRoot(repoRoot);
    if (repo) {
      // Replace the literal `./gradlew` token. Anchored on word boundaries
      // (start/whitespace/&) to avoid touching strings like `something/./gradlew`.
      resolvedBaseCommand = baseCommand.replace(/(^|\s|&)\.\/gradlew(\s|$)/g, `$1${repo.wrapper}$2`);
      if (parsed.verbose) {
        console.log(`[zbb] resolved ./gradlew → ${repo.wrapper}`);
      }
    }
  }

  // Fallback path: bash -c "<full command>"
  const fullCommand = passthrough.length > 0
    ? `${resolvedBaseCommand} ${passthrough.join(' ')}`
    : resolvedBaseCommand;

  // Marker-based gradle delegation. When a wrapper script runs gradle
  // internally (e.g. com/hub's gate-with-neon.sh that creates a Neon DB
  // branch, exports PGHOST, then exec's into ./gradlew monorepoGate),
  // zbb can't see gradle directly to engage the TUI. The script can
  // opt-in by printing this marker to stderr or stdout BEFORE invoking
  // gradle:
  //
  //     echo "ZBB_DELEGATE_GRADLE: ./gradlew monorepoGate" >&2
  //     ./gradlew monorepoGate
  //
  // zbb watches the script's output for the marker. On detection it
  // pre-creates the events file, sets ZBB_MONOREPO_EVENT_FILE in the
  // child env (gradle's EventEmitter writes there), and starts a tailer
  // + MonorepoDisplay just like a direct gradle invocation. Output AFTER
  // the marker is redirected to gradle.log only — the TUI handles the
  // visual update from events. Output BEFORE the marker (script setup
  // logs) is passed through to the terminal as normal.
  const isMarkerEligibleCommand =
    !isGradleCommand &&
    displayEligibleCommands.has(command) &&
    !isGateCheck &&
    (process.stdout.isTTY || forceDisplay);

  const eventDir = join(repoRoot, ZBB_GRADLE_DIR);
  const logsDir = join(eventDir, 'logs');
  const eventFile = join(eventDir, 'events.jsonl');
  const gradleLogFile = join(eventDir, 'gradle.log');
  const childEnv: Record<string, string | undefined> = { ...process.env };
  if (isMarkerEligibleCommand) {
    mkdirSync(eventDir, { recursive: true });
    mkdirSync(logsDir, { recursive: true });
    try { unlinkSync(eventFile); } catch { /* didn't exist */ }
    childEnv.ZBB_MONOREPO_EVENT_FILE = eventFile;
    // Same gradle-console-plain hint as runWithDisplay, in case the
    // script's gradle invocation respects $TERM.
    childEnv.TERM = 'dumb';
    childEnv.GRADLE_OPTS = `${process.env.GRADLE_OPTS ?? ''} -Dorg.gradle.console=plain`.trim();
  }

  // Use async spawn (not spawnSync) so JS signal handlers can run on
  // Ctrl-C. spawnSync blocks the event loop; the parent dies but its
  // gradle daemon escapes the process group and keeps building.
  // detached:true puts bash in its own process group so we can kill the
  // whole tree with one signal.
  const child = spawn('bash', ['-c', fullCommand], {
    cwd: repoRoot,
    // For marker-eligible commands, pipe stdout/stderr so we can watch
    // for the delegation marker. Otherwise inherit (existing behavior).
    stdio: isMarkerEligibleCommand ? ['inherit', 'pipe', 'pipe'] : 'inherit',
    env: childEnv,
    detached: true,
  });

  // Marker watching: forward script output until the marker is seen,
  // then engage TUI and redirect subsequent output to gradle.log.
  if (isMarkerEligibleCommand && child.stdout && child.stderr) {
    let markerSeen = false;
    let display: import('./Display.js').MonorepoDisplay | null = null;
    let tailer: import('./Display.js').EventFileTailer | null = null;
    const gradleLog = createWriteStream(gradleLogFile);

    const markerRe = /ZBB_DELEGATE_GRADLE:\s*(.+)/;
    const onChunk = (chunk: Buffer, sinkBefore: NodeJS.WriteStream) => {
      if (markerSeen) {
        gradleLog.write(chunk);
        return;
      }
      sinkBefore.write(chunk);
      gradleLog.write(chunk);
      const m = chunk.toString('utf-8').match(markerRe);
      if (m) {
        markerSeen = true;
        const { MonorepoDisplay, EventFileTailer } = requireCJS('./Display.js');
        process.stdout.write(`\n${'[2m'}[zbb] delegated gradle: ${m[1].trim()}${'[0m'}\n\n`);
        const localDisplay = new MonorepoDisplay(logsDir, true);
        const localTailer = new EventFileTailer(eventFile, (ev: unknown) => localDisplay.handleEvent(ev as Parameters<typeof localDisplay.handleEvent>[0]));
        display = localDisplay;
        tailer = localTailer;
        localTailer.start();
      }
    };

    child.stdout.on('data', (c: Buffer) => onChunk(c, process.stdout));
    child.stderr.on('data', (c: Buffer) => onChunk(c, process.stderr));

    child.on('exit', () => {
      try { tailer?.stop(); } catch {}
      try { display?.finalize(child.exitCode === 0); } catch {}
      try { gradleLog.end(); } catch {}
    });
  }

  // Signal forwarding mirrors lib/gradle.ts:runGradle and Display.ts:
  // first Ctrl-C → SIGINT to the whole group + ./gradlew --stop;
  // second Ctrl-C → SIGKILL.
  let signalForwarded = false;
  const forwardSignal = (sig: NodeJS.Signals) => {
    if (signalForwarded) {
      try { if (child.pid) process.kill(-child.pid, 'SIGKILL'); } catch {}
      process.exit(130);
    }
    signalForwarded = true;
    try { if (child.pid) process.kill(-child.pid, sig); } catch {}
    if (isGradleCommand) {
      try {
        spawn('./gradlew', ['--stop'], {
          cwd: repoRoot,
          stdio: 'ignore',
          detached: true,
        }).unref();
      } catch {}
    }
  };
  process.on('SIGINT', () => forwardSignal('SIGINT'));
  process.on('SIGTERM', () => forwardSignal('SIGTERM'));

  await new Promise<void>((resolve) => {
    child.on('exit', (code, signal) => {
      if (signal) {
        process.exit(128 + (signal === 'SIGINT' ? 2 : signal === 'SIGTERM' ? 15 : 1));
      }
      process.exit(code ?? 1);
      resolve();
    });
    child.on('error', (err) => {
      process.stderr.write(`zbb: lifecycle spawn failed: ${err.message}\n`);
      process.exit(1);
    });
  });

  // Unreachable — process.exit() above terminates.
  throw new Error('unreachable');
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
