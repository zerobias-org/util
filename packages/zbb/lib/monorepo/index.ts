/**
 * Monorepo command dispatcher.
 * Routes clean/build/test/gate/publish commands to the appropriate handlers.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

// Sync `require` for use in ESM modules — needed because spawnLifecycleAndExit
// is a sync `never`-returning function and we want to lazy-load Display.ts
// without making the whole call chain async.
const requireCJS = createRequire(import.meta.url);
import type { MonorepoConfig, RepoConfig } from '../config.js';
import { loadRepoConfig, loadUserConfig } from '../config.js';
import { runPreflightChecks, formatPreflightResults } from '../preflight.js';
import type { ToolRequirement } from '../config.js';
import { discoverWorkspaces, buildDependencyGraph } from './Workspace.js';
import { detectChanges, getCurrentBranch } from './ChangeDetector.js';
import { isStampValid, validateStamp, GateStampResult } from './GateStamp.js';
import { clean, build, test, gate, install, injectRegistryForBuild, restoreRegistrySwap } from './Builder.js';
import { publish } from './Publisher.js';

// ── Detection ────────────────────────────────────────────────────────

/**
 * Check if the repo at repoRoot is a monorepo with monorepo mode enabled.
 */
export function isMonorepo(repoRoot: string): boolean {
  // Must have package.json with workspaces
  const pkgPath = join(repoRoot, 'package.json');
  if (!existsSync(pkgPath)) return false;

  try {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
    if (!pkg.workspaces || !Array.isArray(pkg.workspaces) || pkg.workspaces.length === 0) {
      return false;
    }
  } catch {
    return false;
  }

  // Must have .zbb.yaml with monorepo.enabled: true
  const zbbPath = join(repoRoot, '.zbb.yaml');
  if (!existsSync(zbbPath)) return false;

  try {
    // Quick check without full YAML parse — look for monorepo.enabled
    const content = readFileSync(zbbPath, 'utf-8');
    return /monorepo:[\s\S]*?enabled:\s*true/.test(content);
  } catch {
    return false;
  }
}

// ── Monorepo-specific preflight checks ───────────────────────────────

const MONOREPO_PREFLIGHT: ToolRequirement[] = [
  {
    tool: 'node',
    check: 'node --version',
    parse: 'v(\\S+)',
    version: '>=22.0.0',
    install: 'Install Node.js 22+ via nvm: nvm install 22',
  },
  {
    tool: 'npm',
    check: 'npm --version',
    parse: '(\\S+)',
    version: '>=10.0.0',
    install: 'Comes with Node.js 22+',
  },
  {
    tool: 'git',
    check: 'git --version',
    parse: 'git version (\\S+)',
    version: '>=2.0.0',
  },
];

const PUBLISH_PREFLIGHT: ToolRequirement[] = [
  {
    tool: 'gh',
    check: 'gh --version',
    parse: 'gh version (\\S+)',
    version: '>=2.0.0',
    install: 'Install GitHub CLI: https://cli.github.com/',
  },
];

function runMonorepoPreflight(command: string, config: MonorepoConfig): void {
  const requirements = [...MONOREPO_PREFLIGHT];
  if (command === 'publish') requirements.push(...PUBLISH_PREFLIGHT);
  if ((command === 'gate' || command === 'test') && config.gatePreflight) {
    requirements.push(...config.gatePreflight);
  }

  const results = runPreflightChecks(requirements);
  const failed = results.filter(r => !r.ok);

  if (failed.length > 0) {
    console.log(formatPreflightResults(results));
    process.exit(1);
  }
}

// ── CLI Argument Parsing ─────────────────────────────────────────────

interface ParsedArgs {
  all: boolean;
  base?: string;
  dryRun: boolean;
  force: boolean;
  verbose: boolean;
  check: boolean;
  skipDocker: boolean;
  remaining: string[];
}

function parseArgs(args: string[]): ParsedArgs {
  const result: ParsedArgs = {
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

// ── Command Router ───────────────────────────────────────────────────

/** Commands that the monorepo handler intercepts */
const MONOREPO_COMMANDS = new Set(['clean', 'build', 'test', 'gate', 'publish']);

/**
 * Check if a command should be handled by the monorepo system.
 */
export function isMonorepoCommand(command: string): boolean {
  return MONOREPO_COMMANDS.has(command);
}

// ── Lifecycle delegation (Phase 2.5 — declarative routing) ──────────
//
// If `.zbb.yaml` defines a `lifecycle:` block (mirroring the per-stack
// `lifecycle:` in stack zbb.yaml files), zbb commands like `zbb build`,
// `zbb gate`, etc. delegate to the lifecycle string instead of running
// the legacy TS monorepo flow. zbb is just a wrapper — the repo controls
// what each command actually runs.
//
// zbb still applies cleanse + preflight + slot env before spawning, since
// those are wrapper concerns. Flag passthrough for `--all` and `--base` is
// appended as Gradle properties (since the new monorepo plugins read them
// as `-Pmonorepo.all=true` / `-Pmonorepo.base=<ref>`). For non-Gradle
// lifecycle commands, the repo can ignore those flags.

/**
 * Look up a lifecycle command in the repo config for the given zbb command.
 * Returns the command string or null if no entry is defined.
 */
function lookupLifecycleCommand(
  repoConfig: RepoConfig,
  command: string,
  parsed: ParsedArgs,
): string | null {
  const lifecycle = repoConfig.lifecycle;
  if (!lifecycle) return null;

  // gate --check uses gateCheck if defined, else falls back to gate
  if (command === 'gate' && parsed.check && lifecycle.gateCheck) {
    return lifecycle.gateCheck;
  }

  const value = (lifecycle as Record<string, unknown>)[command];
  return typeof value === 'string' ? value : null;
}

/**
 * Spawn a lifecycle command from the repo root with monorepo flag passthrough.
 *
 * For phases that produce per-task events (build, etc.), uses the project-centric
 * MonorepoDisplay to render a live TTY table (Phase 2.7). For all other commands,
 * falls back to inherited stdio.
 *
 * Exits with the command's exit code via process.exit (returns Promise<never>).
 */
async function spawnLifecycleAndExit(
  repoRoot: string,
  command: string,
  baseCommand: string,
  parsed: ParsedArgs,
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
  // (build, test, gate). Skip for clean (single root task — no per-task events)
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
 * Main monorepo command handler.
 */
export async function handleMonorepo(
  command: string,
  args: string[],
  repoRoot: string,
): Promise<void> {
  const parsed = parseArgs(args);
  const repoConfig = await loadRepoConfig(repoRoot);
  const config = repoConfig.monorepo!;

  // ── Lifecycle delegation: prefer .zbb.yaml lifecycle when defined ──
  //
  // ZBB_USE_LEGACY_MONOREPO=1 forces the legacy TS code path. Otherwise,
  // if `.zbb.yaml` defines a `lifecycle:` entry for this command, spawn
  // the lifecycle command instead of the TS handler. The repo controls
  // exactly what runs — zbb is just a wrapper that adds slot env + cleanse
  // + preflight + flag passthrough.
  const useLegacy = process.env.ZBB_USE_LEGACY_MONOREPO === '1';
  if (!useLegacy) {
    const lifecycleCommand = lookupLifecycleCommand(repoConfig, command, parsed);
    if (lifecycleCommand !== null) {
      // Apply cleanse + preflight before spawning (zbb owns those concerns)
      if (repoConfig.cleanse && repoConfig.cleanse.length > 0) {
        for (const varName of repoConfig.cleanse) {
          delete process.env[varName];
        }
      }
      if (!(command === 'gate' && parsed.check)) {
        runMonorepoPreflight(command, config);
        if (repoConfig.require && repoConfig.require.length > 0) {
          const userConfig = await loadUserConfig();
          const applicable = repoConfig.require.filter(r => {
            if (!r.commands) return true;
            return r.commands.includes(command);
          });
          const results = runPreflightChecks(applicable, userConfig.skip_checks);
          const failed = results.filter(r => !r.ok);
          if (failed.length > 0) {
            console.log(formatPreflightResults(results));
            process.exit(1);
          }
        }
      }
      await spawnLifecycleAndExit(repoRoot, command, lifecycleCommand, parsed);
    }
  }

  // Apply repo-level cleanse to process.env so child processes (npm test, etc.)
  // don't inherit unwanted env vars from parent shell or slot stacks.
  if (repoConfig.cleanse && repoConfig.cleanse.length > 0) {
    for (const varName of repoConfig.cleanse) {
      delete process.env[varName];
    }
  }

  // Skip preflight checks for stamp-only validation (gate --check)
  if (!(command === 'gate' && parsed.check)) {
    runMonorepoPreflight(command, config);

    // Repo-level preflight checks from .zbb.yaml
    // Filter by command — only run checks that apply to this command
    if (repoConfig.require && repoConfig.require.length > 0) {
      const userConfig = await loadUserConfig();
      const applicable = repoConfig.require.filter(r => {
        if (!r.commands) return true; // no command filter — applies to all
        return r.commands.includes(command);
      });
      const results = runPreflightChecks(applicable, userConfig.skip_checks);
      const failed = results.filter(r => !r.ok);
      if (failed.length > 0) {
        console.log(formatPreflightResults(results));
        process.exit(1);
      }
    }
  }

  // Discover workspaces and build dependency graph
  const packages = discoverWorkspaces(repoRoot);
  const graph = buildDependencyGraph(packages);

  console.log(`Monorepo: ${packages.size} workspace packages`);

  // publish has its own version-based change detection — skip git diff detection
  if (command === 'publish') {
    await publish({
      dryRun: parsed.dryRun,
      force: parsed.force,
      verbose: parsed.verbose,
      repoRoot,
      graph,
      config,
    });
    return;
  }

  // gate and clean always run on all packages
  const forceAll = parsed.all || command === 'gate' || command === 'clean';

  const changes = detectChanges(repoRoot, graph, {
    all: forceAll,
    base: parsed.base,
  });

  if (changes.affectedOrdered.length === 0) {
    console.log(`No packages affected (base: ${changes.baseRef})`);
    return;
  }

  const branch = getCurrentBranch(repoRoot);
  console.log(`Branch: ${branch} | Base: ${changes.baseRef}`);
  console.log(`Changed: ${changes.changed.size} | Affected: ${changes.affected.size}`);

  const ctx = {
    repoRoot,
    graph,
    affectedOrdered: changes.affectedOrdered,
    config,
    verbose: parsed.verbose,
    skipDocker: parsed.skipDocker,
  };

  switch (command) {
    case 'clean':
      await clean(ctx);
      break;

    case 'build': {
      const registrySwap = injectRegistryForBuild(repoRoot);
      try {
        install(repoRoot);
        await build(ctx);
      } finally {
        restoreRegistrySwap(registrySwap, repoRoot);
      }
      break;
    }

    case 'test': {
      const registrySwap = injectRegistryForBuild(repoRoot);
      try {
        install(repoRoot);
        await test(ctx);
      } finally {
        restoreRegistrySwap(registrySwap, repoRoot);
      }
      break;
    }

    case 'gate': {
      // Registry guard: gate must not pass if locally-published registry packages are in use
      const slotName = process.env.ZB_SLOT;
      if (slotName) {
        const { getZbbDir } = await import('../config.js');
        const publishManifest = join(getZbbDir(), 'slots', slotName, 'stacks', 'registry', 'publishes.json');
        if (existsSync(publishManifest)) {
          const publishes = JSON.parse(readFileSync(publishManifest, 'utf-8'));
          if (Array.isArray(publishes) && publishes.length > 0) {
            console.error('Cannot write gate stamp — local registry packages in use:');
            for (const pkg of publishes) {
              console.error(`  ${pkg.name}@${pkg.version}`);
            }
            console.error('\nRun: zbb registry clear');
            process.exit(1);
          }
        }
      }

      if (parsed.check) {
        // --check mode: validate only, exit 0 or 1
        const valid = isStampValid(changes.affectedOrdered, graph, repoRoot, config);
        if (valid) {
          console.log('Gate stamp valid — all affected packages pass validation.');
          process.exit(0);
        } else {
          // Print which packages are invalid
          const results = validateStamp(changes.affectedOrdered, graph, repoRoot, config);
          for (const [name, result] of results) {
            const shortName = graph.packages.get(name)!.name.replace(/^@[^/]+\//, '');
            const icon = result === GateStampResult.VALID ? '✓' : '✗';
            console.log(`  ${icon} ${shortName}: ${result}`);
          }
          console.log('\nGate stamp invalid — full gate required.');
          process.exit(1);
        }
      }
      await gate(ctx);
      break;
    }

    default:
      console.error(`Unknown monorepo command: ${command}`);
      process.exit(1);
  }
}
