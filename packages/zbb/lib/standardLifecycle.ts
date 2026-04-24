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

import { spawnSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';

import {
  findGradleRoot,
  loadProjectCache,
  buildProjectCache,
  detectProject,
} from './gradle.js';
import type { ParsedLifecycleArgs } from './monorepo/index.js';

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
  // Flag passthrough — identical semantics to the monorepo dispatcher
  // for the flags that make sense here. Standard mode drops --all and
  // --base (they're monorepo-specific affected-set selectors).
  const passthrough: string[] = [];
  if (parsed.dryRun) passthrough.push('-PdryRun=true');
  if (parsed.force) passthrough.push('-Pforce=true');

  // Resolve the command to a specific subproject if cwd is one.
  //
  // Rules:
  //   - If cwd == repoRoot → run the lifecycle entry verbatim (root task)
  //   - If cwd has build.gradle.kts and is a registered subproject →
  //     prefix the task name with `:subproject:path:`
  //   - If cwd is a subfolder but has no build.gradle.kts → refuse, with
  //     a clear message. The user's stated rule (in the zbb.yaml design)
  //     is that a package must have build.gradle.kts to be publishable.
  //   - If cwd can't resolve at all → run the raw command (whatever the
  //     user has in their zbb.yaml), let gradle report its own error
  const cmdToRun = resolveCommandForCwd(repoRoot, baseCommand);

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
    displayEligibleCommands.has(command) &&
    !isGateCheck &&
    (process.stdout.isTTY || forceDisplay);

  if (useDisplay) {
    // The display path requires the gradle invocation to be split into
    // (executable, args[]) form so it can spawn directly without bash -c.
    // This only works for single-command lifecycle entries; chained
    // commands (`./gradlew a && ./gradlew b`) fall through to bash.
    const parts = cmdToRun.trim().split(/\s+/);
    const safe =
      parts.length > 0 &&
      !cmdToRun.includes('|') &&
      !cmdToRun.includes('&&') &&
      !cmdToRun.includes(';');
    if (safe) {
      const cmd = parts[0];
      const args = [...parts.slice(1), ...passthrough];
      const { runWithDisplay } = requireCJS('./monorepo/Display.js');
      const code = await runWithDisplay(repoRoot, cmd, args);
      process.exit(code);
    }
  }

  // Fallback path: bash -c "<full command>" with inherited stdio.
  const fullCommand = passthrough.length > 0
    ? `${cmdToRun} ${passthrough.join(' ')}`
    : cmdToRun;

  const result = spawnSync('bash', ['-c', fullCommand], {
    cwd: repoRoot,
    stdio: 'inherit',
    env: process.env,
  });

  process.exit(result.status ?? 1);
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
