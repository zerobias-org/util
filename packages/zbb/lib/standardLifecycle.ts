/**
 * Standard (non-monorepo) lifecycle dispatcher.
 *
 * Used for repos whose zbb.yaml does NOT contain a `monorepo:` block.
 * Each subproject is an independent package with its own gradle project
 * (build.gradle.kts + package.json). Running `zbb build` from inside a
 * subfolder should only affect that subfolder, not aggregate across the
 * whole repo.
 *
 * This dispatcher is deliberately simple and does NOT reach into any
 * monorepo-specific code paths:
 *   - No -Pmonorepo.all / -Pmonorepo.base flags (those are meaningless
 *     outside a monorepo)
 *   - No TUI display (deferred; monorepo's event pipeline expects
 *     monorepoBuild-style events that standard mode doesn't emit)
 *   - No publish plan / gate stamp aggregation
 *
 * Key behavior: if the current working directory has its own
 * build.gradle.kts and is a registered gradle subproject of the repo,
 * the lifecycle task name is prefixed with the subproject gradle path.
 * Example — `zbb build` from package/github/github in auditlogic/module
 * becomes `./gradlew :github:github:build`. If cwd isn't a gradle
 * subproject, we refuse to dispatch with a clear error pointing at the
 * rule: "a package must have build.gradle.kts to be buildable/gateable
 * as a standalone unit."
 */

import { spawn } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';

import {
  findGradleRoot,
  loadProjectCache,
  buildProjectCache,
  detectProject,
} from './gradle.js';
import type { ParsedLifecycleArgs } from './lifecycle.js';

// Sync `require` for use in ESM — lazy-load Display.js without making the
// whole call chain async. Same pattern used by the monorepo dispatcher.
const requireCJS = createRequire(import.meta.url);

/**
 * Run a lifecycle command in standard mode, exit with its status.
 *
 * @param repoRoot absolute path to the repo root (where zbb.yaml lives)
 * @param command the lifecycle command name (e.g. 'build', 'test', 'gate')
 * @param baseCommand the `./gradlew <task>` string from zbb.yaml's lifecycle entry
 * @param parsed parsed --force / --dry-run / --verbose flags
 */
export async function spawnStandardLifecycleAndExit(
  repoRoot: string,
  command: string,
  baseCommand: string,
  parsed: ParsedLifecycleArgs,
): Promise<never> {
  // Gradle flags (-P*) and the TUI display only apply when the lifecycle
  // command is a gradle invocation. We detect that by literal `./gradlew`
  // in the command — no heuristics, no assumptions about wrapper scripts.
  // Anything else runs verbatim through bash (the default execution env)
  // with no flag injection and no TUI display. If a user wants gradle-
  // aware behavior, the command should say `./gradlew`.
  const isGradleCommand = /(^|\s|&)\.\/gradlew(\s|$)/.test(baseCommand);

  // Flag passthrough — identical semantics to the monorepo dispatcher
  // for the flags that make sense here. Standard mode drops --all and
  // --base (they're monorepo-specific affected-set selectors).
  const passthrough: string[] = [];
  if (isGradleCommand) {
    if (parsed.dryRun) passthrough.push('-PdryRun=true');
    if (parsed.force) passthrough.push('-Pforce=true');
    if (parsed.clean) passthrough.push('-Pcleanlocalregistry');
    // version-specific flags. modules: comma-separated list of relative
    // paths under package/ (matches the github workflow's `detect` output).
    // noPush: keeps the version commit local — used by tests / dry-runs.
    if (parsed.modules) passthrough.push(`-PmodulesToVersion=${parsed.modules}`);
    if (parsed.noPush) passthrough.push('-Ppush=false');
    // Anything zbb didn't recognize (gradle -P/-D project/system properties,
    // bare task names, `--`-style flags) — forward to gradle verbatim. Without
    // this, `zbb publish -PfooBar=true` silently drops the property and the
    // gradle script never sees the override.
    passthrough.push(...parsed.remaining);
  }

  // Resolve the command to a specific subproject if cwd is one.
  //
  // Rules:
  //   - If command is `version` → always root-level (versionStandardPackages
  //     is an aggregator on the root project; cwd-scoping makes no sense)
  //   - If cwd == repoRoot → run the lifecycle entry verbatim (root task)
  //   - If cwd has build.gradle.kts and is a registered subproject →
  //     prefix the task name with `:subproject:path:`
  //   - If cwd is a subfolder but has no build.gradle.kts → refuse, with
  //     a clear message. The user's stated rule (in the zbb.yaml design)
  //     is that a package must have build.gradle.kts to be publishable.
  //   - If cwd can't resolve at all → run the raw command (whatever the
  //     user has in their zbb.yaml), let gradle report its own error
  const cmdToRun = command === 'version'
    ? baseCommand
    : resolveCommandForCwd(repoRoot, baseCommand);

  if (parsed.verbose) {
    const dbg = passthrough.length > 0
      ? `${cmdToRun} ${passthrough.join(' ')}`
      : cmdToRun;
    console.log(`[zbb] standard lifecycle '${dbg}'`);
  }

  // Use the project-centric TTY display for commands that produce per-task
  // events. Same logic as the monorepo dispatcher — clean/gateCheck have
  // no per-task events worth rendering, so they fall through to plain bash.
  const forceDisplay = process.env.ZBB_FORCE_TTY === '1';
  const displayEligibleCommands = new Set(['build', 'test', 'gate', 'dockerBuild']);
  const isGateCheck = command === 'gate' && parsed.check;
  const useDisplay =
    isGradleCommand &&
    displayEligibleCommands.has(command) &&
    !isGateCheck &&
    (process.stdout.isTTY || forceDisplay);

  if (useDisplay) {
    // The display path requires the gradle invocation to be split into
    // (executable, args[]) form so it can spawn directly without bash -c.
    // This only works for single-command lifecycle entries; chained
    // commands (`./gradlew a && ./gradlew b`) fall through to bash.
    const parts = cmdToRun.trim().split(/\s+/);
    // Direct spawn skips shell parsing — a command with shell quoting,
    // semicolons, pipes, multi-line bodies, or env-var prefixes needs
    // bash to interpret it. Fall through to the bash -c path for those.
    const safe =
      parts.length > 0 &&
      !cmdToRun.includes('|') &&
      !cmdToRun.includes('&&') &&
      !cmdToRun.includes(';') &&
      !cmdToRun.includes('"') &&
      !cmdToRun.includes("'") &&
      !cmdToRun.includes('\n') &&
      !parts[0].includes('=');
    if (safe) {
      const cmd = parts[0];
      const args = [...parts.slice(1), ...passthrough];
      const { runWithDisplay } = requireCJS('./monorepo/Display.js');
      const code = await runWithDisplay(repoRoot, cmd, args);
      process.exit(code);
    }
  }

  // Resolve `./gradlew` against the actual gradle root if cwd lacks
  // one. Mirrors the same fix in monorepo/index.ts — see comments
  // there for the full rationale.
  let resolvedCmdToRun = cmdToRun;
  if (/(^|\s|&)\.\/gradlew(\s|$)/.test(cmdToRun) && !existsSync(join(repoRoot, 'gradlew'))) {
    const repo = findGradleRoot(repoRoot);
    if (repo) {
      resolvedCmdToRun = cmdToRun.replace(/(^|\s|&)\.\/gradlew(\s|$)/g, `$1${repo.wrapper}$2`);
      if (parsed.verbose) {
        console.log(`[zbb] resolved ./gradlew → ${repo.wrapper}`);
      }
    }
  }

  // Fallback path: bash -c "<full command>" with inherited stdio.
  const fullCommand = passthrough.length > 0
    ? `${resolvedCmdToRun} ${passthrough.join(' ')}`
    : resolvedCmdToRun;

  // Use async spawn so JS signal handlers can run on Ctrl-C. spawnSync
  // blocks the event loop — the parent dies but its gradle daemon can
  // escape the process group and keep building. detached:true puts bash
  // in its own process group so we can kill the whole tree at once.
  const child = spawn('bash', ['-c', fullCommand], {
    cwd: repoRoot,
    stdio: 'inherit',
    env: process.env,
    detached: true,
  });

  // Signal forwarding mirrors lib/gradle.ts:runGradle. First Ctrl-C
  // sends the signal to the whole process group + best-effort
  // ./gradlew --stop for any detached daemon. Second Ctrl-C escalates
  // to SIGKILL.
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
 * Resolve the baseCommand for the current cwd. Returns the baseCommand
 * unchanged when no subproject prefixing applies, or a rewritten command
 * when cwd is a gradle subproject.
 *
 * Exits the process with a helpful error when cwd is a package dir
 * (has package.json) but NOT a gradle subproject (no build.gradle.kts).
 *
 * Exported for test access. The dispatcher passes `process.cwd()` at the
 * call site; tests invoke it directly with a fixture cwd via process.chdir
 * (node:test files run in isolated worker processes, so chdir is safe).
 */
export function resolveCommandForCwd(repoRoot: string, baseCommand: string): string {
  const cwd = process.cwd();
  const atRoot = realpathSync(cwd) === realpathSync(repoRoot);
  if (atRoot) return baseCommand;

  // Bail if the command looks like something we can't safely parse.
  if (
    baseCommand.includes('&&') ||
    baseCommand.includes('|') ||
    baseCommand.includes(';')
  ) {
    return baseCommand;
  }

  const parts = baseCommand.trim().split(/\s+/);
  if (parts.length < 2) return baseCommand;
  const [cmd, ...rest] = parts;
  if (!cmd.endsWith('gradlew') && cmd !== 'gradle') return baseCommand;

  // Find the first positional task argument (skip flags).
  const taskIdx = rest.findIndex(a => !a.startsWith('-'));
  if (taskIdx < 0) return baseCommand;
  const taskName = rest[taskIdx];
  // Already prefixed — pass through.
  if (taskName.includes(':')) return baseCommand;

  // If cwd doesn't have a build.gradle.kts, it's not a gradle subproject.
  // Per the user's design rule, a package must have build.gradle.kts to
  // be buildable/publishable as a standalone unit — refuse with a clear
  // error that points at the fix.
  const hasBuildFile =
    existsSync(join(cwd, 'build.gradle.kts')) ||
    existsSync(join(cwd, 'build.gradle'));
  const hasPackageJson = existsSync(join(cwd, 'package.json'));
  if (!hasBuildFile) {
    if (hasPackageJson) {
      console.error(
        `This package has package.json but no build.gradle.kts — it is not\n` +
        `a registered gradle subproject, so \`zbb ${taskName}\` can't target it\n` +
        `individually. Add a build.gradle.kts to make it publishable.`,
      );
      process.exit(1);
    }
    // Neither build.gradle.kts nor package.json — probably a random
    // subfolder (docs, scripts, etc.). Run the root task as declared;
    // the user probably meant to run from repoRoot.
    return baseCommand;
  }

  // Look up the gradle subproject path from the cached projectPaths map.
  const found = findGradleRoot(cwd);
  if (!found || realpathSync(found.root) !== realpathSync(repoRoot)) {
    // Gradle root is somewhere else — user is in a nested gradle tree
    // we don't know about. Don't prefix; let it fail or succeed on its own.
    return baseCommand;
  }
  let projects = loadProjectCache(found.root);
  if (projects === null) {
    try {
      projects = buildProjectCache(found.root, found.wrapper);
    } catch (e) {
      console.error(`[zbb] could not enumerate gradle projects: ${(e as Error).message}`);
      return baseCommand;
    }
  }
  const projectPath = detectProject(found.root, projects);
  if (!projectPath) {
    console.error(
      `cwd ${cwd} has build.gradle.kts but isn't registered in settings.gradle.kts.\n` +
      `Add it to settings.gradle.kts or run \`zbb\` from the repo root.`,
    );
    process.exit(1);
  }

  const newRest = [...rest];
  newRest[taskIdx] = `${projectPath}:${taskName}`;
  return [cmd, ...newRest].join(' ');
}
