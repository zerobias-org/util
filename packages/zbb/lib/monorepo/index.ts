/**
 * Monorepo command dispatcher.
 * Routes clean/build/test/gate/publish commands to the appropriate handlers.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
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

// ── Gradle routing layer (Phase 2.5) ────────────────────────────────

/**
 * Map a zbb command to the corresponding Gradle task name in the new
 * `zb.monorepo-*` plugin set.
 *
 * Returns null if the command is not yet supported by the new Gradle path
 * (caller falls through to the legacy TS implementation).
 */
function gradleTaskFor(command: string, parsed: ParsedArgs): string | null {
  switch (command) {
    case 'gate':
      return parsed.check ? 'monorepoGateCheck' : 'monorepoGate';
    case 'build':
      return 'monorepoBuild';
    case 'test':
      return 'monorepoTest';
    case 'clean':
      return 'monorepoClean';
    // publish wired up after zb.monorepo-publish plugin is written
    default:
      return null;
  }
}

/**
 * Check whether this repo is wired up to the new Gradle monorepo plugins.
 * Looks for: gradlew at repo root + settings.gradle.kts that references
 * `zb.monorepo-base` (the marker that the new plugins are applied).
 */
function repoSupportsGradleMonorepo(repoRoot: string): boolean {
  const gradlew = join(repoRoot, 'gradlew');
  if (!existsSync(gradlew)) return false;
  const settingsFile = join(repoRoot, 'settings.gradle.kts');
  if (!existsSync(settingsFile)) return false;
  try {
    const content = readFileSync(settingsFile, 'utf-8');
    return content.includes('zb.monorepo-base');
  } catch {
    return false;
  }
}

/**
 * Spawn `./gradlew <task>` from the repo root with the parsed args mapped
 * into Gradle properties. Inherits stdio so the user sees gradle output
 * directly. Exits with the gradle exit code.
 *
 * Returns only if the spawn fails to start (e.g. gradlew missing).
 */
function spawnGradleAndExit(repoRoot: string, task: string, parsed: ParsedArgs): never {
  const gradleArgs: string[] = [task];
  if (parsed.all) gradleArgs.push('-Pmonorepo.all=true');
  if (parsed.base) gradleArgs.push(`-Pmonorepo.base=${parsed.base}`);

  if (parsed.verbose) {
    console.log(`[zbb] routing to gradle: ./gradlew ${gradleArgs.join(' ')}`);
  }

  const result = spawnSync(join(repoRoot, 'gradlew'), gradleArgs, {
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

  // ── Phase 2.5 routing: prefer the new Gradle path unless legacy override ──
  //
  // ZBB_USE_LEGACY_MONOREPO=1 forces the original TS code path. Otherwise,
  // if the repo has gradlew + a settings.gradle.kts that wires up the new
  // zb.monorepo-* plugins, AND the command has a Gradle equivalent, route
  // to gradle. The TS path remains as a fallback for unsupported commands.
  const useLegacy = process.env.ZBB_USE_LEGACY_MONOREPO === '1';
  if (!useLegacy && repoSupportsGradleMonorepo(repoRoot)) {
    const task = gradleTaskFor(command, parsed);
    if (task !== null) {
      // Apply cleanse + preflight before spawning gradle (zbb owns those concerns)
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
      spawnGradleAndExit(repoRoot, task, parsed);
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
