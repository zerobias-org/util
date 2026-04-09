/**
 * zbb CLI — command router
 *
 * Routes:
 *   zbb slot <create|load|list|info|delete|gc>  → slot management
 *   zbb env <list|get|set|unset|reset|diff>      → env var commands
 *   zbb logs <list|show>                          → log viewer
 *   zbb stack <start|stop|add|remove|...>           → stack management
 *   zbb --version | --help                        → meta
 *   zbb <anything else>                           → gradle wrapper
 */

import { SlotManager } from './slot/SlotManager.js';
import type { Slot } from './slot/Slot.js';
import { runPreflightChecks, formatPreflightResults } from './preflight.js';
import { checkDeprecatedAlias, runGradle } from './gradle.js';
import {
  findRepoRoot,
  loadProjectConfig,
  loadRepoConfig,
  loadStackManifest,
  loadUserConfig,
  type ToolRequirement,
} from './config.js';
import { scanEnvDeclarations } from './env/Scanner.js';
import { spawn } from 'node:child_process';
import {
  isLifecycleCommand,
  parseLifecycleArgs,
  lookupLifecycleCommand,
  spawnLifecycleAndExit,
  spawnGradleFallbackAndExit,
} from './monorepo/index.js';
import { handleStack, detectStackContext } from './stack/commands.js';

/**
 * Extend slot from cwd context: walk up to find repo root (.zbb.yaml/gradlew),
 * scan zbb.yaml declarations, add missing vars to slot, re-export to process.env.
 * Returns the repo root path, or null if no project context found.
 */
async function extendSlotFromCwd(slot: Slot): Promise<string | null> {
  const repoRoot = findRepoRoot(process.cwd());
  if (!repoRoot) return null;

  const { extendSlot } = await import('./slot/extend.js');
  const result = await extendSlot(slot, repoRoot);
  if (result.extended) {
    console.log(`Extended slot with ${result.addedVars.length} new var(s): ${result.addedVars.join(', ')}`);
    const newEnv = slot.env.getAll();
    for (const varName of result.addedVars) {
      if (newEnv[varName]) process.env[varName] = newEnv[varName];
    }
  }
  return repoRoot;
}

/**
 * Full slot preparation: extend + resolve (DNS + vault) + re-export to process.env.
 * Shared by: slot load, --slot flag, publish, gate, testHub, and all Gradle commands.
 *
 * @param slot - Loaded slot instance
 * @param options.fatal - If true, vault errors abort (exit 1). Default: false (warnings only).
 * @returns repo root path, or null
 */
async function prepareSlot(slot: Slot, options?: { fatal?: boolean }): Promise<string | null> {
  const repoRoot = await extendSlotFromCwd(slot);

  // Run resolve: DNS + vault
  const vaultResult = await slot.resolve(repoRoot ?? undefined);

  if (vaultResult.refreshed.length > 0) {
    console.log('Vault credentials refreshed:');
    for (const name of vaultResult.refreshed) {
      console.log(`  \u2713 ${name}`);
    }
  }
  if (vaultResult.errors.length > 0) {
    for (const { name, error } of vaultResult.errors) {
      console.error(`  \u2717 ${name}: ${error}`);
    }
    if (options?.fatal) {
      console.error('Vault credential refresh failed — aborting');
      process.exit(1);
    }
  }

  // Re-export all slot env to process.env so child processes see updated values
  const slotEnv = slot.env.getAll();
  for (const [k, v] of Object.entries(slotEnv)) {
    if (v) process.env[k] = v;
  }

  return repoRoot;
}

export async function main(argv: string[]): Promise<void> {
  try {
    await _main(argv);
  } catch (err: any) {
    console.error(err.stack ?? err.message);
    if (argv.includes('--verbose') || argv.includes('-v') || process.env.ZBB_VERBOSE === '1') {
      console.error(err.stack);
    }
    process.exit(1);
  }
}

async function _main(argv: string[]): Promise<void> {
  let args = argv.slice(2);

  // Global --slot flag: load slot env before running any command
  // Usage: zbb --slot local build, zbb --slot local testDocker
  const slotIdx = args.indexOf('--slot');
  if (slotIdx !== -1 && args[slotIdx + 1]) {
    const slotName = args[slotIdx + 1];
    args = [...args.slice(0, slotIdx), ...args.slice(slotIdx + 2)];

    // Load slot and prepare: extend + resolve (DNS + vault) + re-export env
    const slot = await SlotManager.load(slotName);
    process.env.ZB_SLOT = slotName;

    // Set JAVA_HOME if not already correct
    if (!process.env.JAVA_HOME || !process.env.JAVA_HOME.includes('21')) {
      const java21Home = '/usr/lib/jvm/java-21-openjdk-amd64';
      const { existsSync } = await import('node:fs');
      if (existsSync(`${java21Home}/bin/java`)) {
        process.env.JAVA_HOME = java21Home;
        process.env.PATH = `${java21Home}/bin:${process.env.PATH ?? ''}`;
      }
    }

    await prepareSlot(slot);
  }

  // Global --stack flag: set stack context for non-interactive use
  // Usage: zbb --slot local --stack hub start
  const stackIdx = args.indexOf('--stack');
  if (stackIdx !== -1 && args[stackIdx + 1]) {
    process.env.ZB_STACK = args[stackIdx + 1];
    args = [...args.slice(0, stackIdx), ...args.slice(stackIdx + 2)];
  }

  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    printUsage();
    return;
  }

  if (args[0] === '--version') {
    const { readFileSync } = await import('node:fs');
    const { join, dirname } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const dir = dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(readFileSync(join(dir, '..', 'package.json'), 'utf-8'));
    console.log(`zbb ${pkg.version}`);
    return;
  }

  const command = args[0];
  const repoRoot = findRepoRoot(process.cwd());

  // Slot subcommands
  if (command === 'slot') return handleSlot(args.slice(1));

  // Stack subcommands
  if (command === 'stack') {
    const slotName = process.env.ZB_SLOT;
    if (!slotName) {
      console.error('Not inside a loaded slot. Run: zbb slot load <name>');
      process.exit(1);
    }
    const slot = await SlotManager.load(slotName);
    return handleStack(args.slice(1), slot);
  }

  // Registry subcommands
  if (command === 'registry') {
    const slotName = process.env.ZB_SLOT;
    if (!slotName) {
      console.error('Not inside a loaded slot. Run: zbb slot load <name>');
      process.exit(1);
    }
    const slot = await SlotManager.load(slotName);
    const { handleRegistry } = await import('./registry/commands.js');
    return handleRegistry(args.slice(1), slot);
  }

  // Secret subcommands
  if (command === 'secret') return handleSecretCmd(args.slice(1));

  // Env subcommands (stack-aware)
  if (command === 'env') return handleEnv(args.slice(1));

  // Log subcommands
  if (command === 'logs') return handleLogs(args.slice(1));

  // Dataloader — spawn platform dataloader with slot PG env injection
  if (command === 'dataloader') {
    const { handleDataloader } = await import('./dataloader.js');
    return handleDataloader(args.slice(1));
  }

  // Run — execute a command or npm script with slot/stack env
  if (command === 'run') {
    const slotName = process.env.ZB_SLOT;
    if (!slotName) {
      console.error('Not inside a loaded slot. Run: zbb slot load <name>');
      process.exit(1);
    }
    const slot = await SlotManager.load(slotName);
    await prepareSlot(slot);

    const runArgs = args.slice(1);
    if (runArgs.length === 0) {
      console.error('Usage: zbb run <npm-script> [args...]');
      console.error('       zbb run -- <command> [args...]');
      process.exit(1);
    }

    const { spawnSync } = await import('node:child_process');
    let cmd: string;
    let cmdArgs: string[];

    if (runArgs[0] === '--') {
      // Arbitrary command: zbb run -- node src/seed.js
      cmdArgs = runArgs.slice(1);
      if (cmdArgs.length === 0) {
        console.error('No command specified after --');
        process.exit(1);
      }
      cmd = cmdArgs[0];
      cmdArgs = cmdArgs.slice(1);
    } else {
      // npm script: zbb run test:integration
      cmd = 'npm';
      cmdArgs = ['run', ...runArgs];
    }

    const result = spawnSync(cmd, cmdArgs, {
      stdio: 'inherit',
      env: process.env,
      cwd: process.cwd(),
    });
    process.exit(result.status ?? 1);
  }

  // Publish Gradle plugins/libs to GitHub Packages Maven
  if (command === 'publishRemote') {
    runGradle(['publishAllPublicationsToGitHubPackagesRepository', ...args.slice(1)]);
    return;
  }

  // Deprecated stack aliases
  const replacement = checkDeprecatedAlias(command);
  if (replacement) {
    console.log(`zbb ${command} no longer exists. Did you mean: ${replacement}`);
    return;
  }

  // ── Lifecycle dispatch ───────────────────────────────────────────────
  //
  // Phase 3 single-tier dispatch. clean/build/test/gate/publish all route
  // here. The flow:
  //
  //   1. Read zbb.yaml from repo root (if present).
  //   2. gate --check fast path: skip slot/stack/preflight, just spawn the
  //      lifecycle.gateCheck command (or ./gradlew monorepoGateCheck if no
  //      lifecycle entry exists). Validates the stamp file only.
  //   3. All other lifecycle commands require a loaded slot.
  //   4. Match the repo's stack against added stacks in the slot.
  //   5. Apply slot env (which already includes the stack's env via the
  //      stack composition system), then apply repo cleanse, then run
  //      preflight.
  //   6. If lifecycle[command] exists → spawn it (with TTY display for
  //      build/test/gate). Else → fall through to ./gradlew <command>.
  //
  // No zbb.yaml → permissive fallback to runGradle (smart wrapper mode).
  if (isLifecycleCommand(command) && repoRoot) {
    const zbbYaml = await loadRepoConfig(repoRoot);
    const manifest = await loadStackManifest(repoRoot);
    const parsed = parseLifecycleArgs(args.slice(1));

    // gate --check fast path: no slot, no stack, no preflight
    if (command === 'gate' && parsed.check) {
      const lifecycleCmd = lookupLifecycleCommand(zbbYaml.lifecycle, command, parsed);
      if (lifecycleCmd) {
        return spawnLifecycleAndExit(repoRoot, command, lifecycleCmd, parsed);
      }
      return spawnGradleFallbackAndExit(repoRoot, 'monorepoGateCheck', parsed);
    }

    // All other lifecycle commands require a loaded slot + an added stack
    if (!process.env.ZB_SLOT) {
      console.error(`Not inside a loaded slot. Run: zbb slot load <name>`);
      process.exit(1);
    }
    const slot = await SlotManager.load(process.env.ZB_SLOT);

    // The repo's zbb.yaml IS the stack manifest in Phase 3 — its `name`
    // field identifies the stack. Match against the slot's added stacks.
    if (!manifest) {
      console.error(`Repo has zbb.yaml but it's missing required 'name'/'version' fields.`);
      console.error(`Phase 3 requires the repo-root zbb.yaml to also be a stack manifest.`);
      process.exit(1);
    }
    const stackShortName = manifest.name.split('/').pop() ?? manifest.name;
    const addedStacks = await slot.stacks.list();
    const stack = addedStacks.find(
      s => s.name === stackShortName || s.identity.name === manifest.name,
    );
    if (!stack) {
      console.error(`Stack '${stackShortName}' is not added to slot '${slot.name}'.`);
      console.error(`Run: zbb stack add .`);
      process.exit(1);
    }

    // Apply slot env (resolve vault/DNS, export to process.env). The stack's
    // contributed env vars are already part of the slot env via the stack
    // composition system from `zbb stack add`.
    await prepareSlot(slot, { fatal: command === 'publish' });

    // Apply repo-level cleanse so child processes don't inherit unwanted
    // vars from the parent shell.
    if (zbbYaml.cleanse && zbbYaml.cleanse.length > 0) {
      for (const varName of zbbYaml.cleanse) {
        delete process.env[varName];
      }
    }

    // Run command-filtered preflight from `require:`
    if (zbbYaml.require && zbbYaml.require.length > 0) {
      const userConfig = await loadUserConfig();
      const applicable = zbbYaml.require.filter(r => {
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

    // Look up lifecycle entry → spawn, or fall through to ./gradlew <cmd>
    const lifecycleCmd = lookupLifecycleCommand(zbbYaml.lifecycle, command, parsed);
    if (lifecycleCmd) {
      return spawnLifecycleAndExit(repoRoot, command, lifecycleCmd, parsed);
    }
    return spawnGradleFallbackAndExit(repoRoot, command, parsed);
  }

  // ── Permissive gradle fallback ───────────────────────────────────────
  // No zbb.yaml in cwd, or command isn't a lifecycle command. Just run
  // gradle. This preserves the smart-wrapper behaviour for non-zbb repos
  // (resolves subproject from cwd, prefixes task names).
  if (process.env.ZB_SLOT) {
    const slot = await SlotManager.load(process.env.ZB_SLOT);
    await prepareSlot(slot);
  }
  runGradle(args);
}

// ── Slot Commands ────────────────────────────────────────────────────

async function handleSlot(args: string[]): Promise<void> {
  const sub = args[0];

  switch (sub) {
    case 'create': {
      const name = args.find(a => !a.startsWith('-')) !== args[0] ? '' : args[1] ?? '';
      const ephemeral = args.includes('--ephemeral');
      const ttlIdx = args.indexOf('--ttl');
      const ttl = ttlIdx !== -1 ? parseTtl(args[ttlIdx + 1]) : undefined;
      // CI mode: snapshot process.env as the source-of-truth for declared
      // vars (so vault-action's pre-injected secrets are picked up directly).
      // Auto-on when CI=true is set in the parent shell.
      const ci = args.includes('--ci') || process.env.CI === 'true';

      // Find the slot name — it's the positional arg after 'create' that isn't a flag
      let slotName = '';
      for (let i = 1; i < args.length; i += 1) {
        if (args[i].startsWith('--')) {
          if (args[i] === '--ttl') i += 1; // skip ttl value
          continue;
        }
        slotName = args[i];
        break;
      }

      const slot = await SlotManager.create(slotName, { ephemeral, ttl, ci });

      const envCount = slot.env.list().length;
      const portCount = Object.values(slot.env.getManifest())
        .filter(m => m.type === 'port').length;
      const secretCount = Object.values(slot.env.getManifest())
        .filter(m => m.type === 'secret').length;

      console.log(`Slot '${slot.name}' created.`);
      console.log(`  ${envCount} env vars (${portCount} ports, ${secretCount} secrets)`);
      console.log(`  ${slot.path}`);
      if (slot.isEphemeral()) {
        console.log(`  Ephemeral, expires: ${slot.meta.expires}`);
      }
      console.log(`\nLoad with: zbb slot load ${slot.name}`);
      break;
    }

    case 'load': {
      let slotName = args[1];
      const isReload = !slotName && !!process.env.ZB_SLOT;

      if (!slotName) {
        slotName = process.env.ZB_SLOT ?? '';
        if (!slotName) {
          console.error('Not inside a slot. Usage: zbb slot load <name>');
          process.exit(1);
        }
      }

      // GC expired ephemeral slots first
      const deleted = await SlotManager.gc();
      if (deleted.length > 0) {
        console.log(`GC: removed ${deleted.length} expired slot(s): ${deleted.join(', ')}`);
      }

      const slot = await SlotManager.load(slotName);

      // Extend + resolve (DNS + vault) + re-export env
      const repoRoot = await prepareSlot(slot);
      if (!repoRoot) {
        if (isReload) {
          console.error('No zbb.yaml or .zbb.yaml found. Run from inside a project directory.');
          process.exit(1);
        }
        console.warn('Warning: No zbb.yaml or .zbb.yaml found in directory tree. Slot extension skipped.');
      }

      // Re-eval mode: already inside a slot, just confirm
      if (isReload) {
        console.log(`Slot '${slotName}' re-evaluated from ${process.cwd()}`);
        break;
      }

      // First load: run preflight, spawn subshell

      // Run preflight checks and apply cleanse (only if in a project)
      if (repoRoot) {
        const repoConfig = await loadRepoConfig(repoRoot);

        // Filter requirements that apply to the 'slot' command
        const requirements: ToolRequirement[] = (repoConfig.require ?? []).filter(r => {
          if (!r.commands) return true;
          return r.commands.includes('slot');
        });

        const userConfig = await loadUserConfig();
        if (requirements.length > 0) {
          const results = runPreflightChecks(requirements, userConfig.skip_checks);
          console.log(formatPreflightResults(results));
          const failed = results.filter(r => !r.ok);
          if (failed.length > 0) {
            process.exit(1);
          }
          console.log('');
        }
      }

      // Build env for subshell
      const slotEnv = slot.env.getAll();
      const shellEnv: Record<string, string> = { ...process.env as Record<string, string> };

      // Apply cleanse list
      if (repoRoot) {
        const repoConfig = await loadRepoConfig(repoRoot);
        for (const varName of repoConfig.cleanse ?? []) {
          delete shellEnv[varName];
        }
      }

      // Merge slot env
      Object.assign(shellEnv, slotEnv);

      // Ensure JAVA_HOME is set and on PATH if not already correct
      if (!shellEnv.JAVA_HOME || !shellEnv.JAVA_HOME.includes('21')) {
        const java21Home = '/usr/lib/jvm/java-21-openjdk-amd64';
        const { existsSync } = await import('node:fs');
        if (existsSync(`${java21Home}/bin/java`)) {
          shellEnv.JAVA_HOME = java21Home;
          shellEnv.PATH = `${java21Home}/bin:${shellEnv.PATH ?? ''}`;
        }
      }

      // Set prompt
      const userConfig = await loadUserConfig();
      // Set slot prompt — replaces user@host with slot tag, keeps colored path
      const promptTemplate = userConfig.prompt ?? '\\[\\033[01;36m\\][zb:{{slot}}]\\[\\033[00m\\]:\\[\\033[01;34m\\]\\w\\[\\033[00m\\]\\$ ';
      shellEnv.ZBB_PS1 = promptTemplate.replace('{{slot}}', slotName);

      // Generate rcfile that sources the hook
      const { join: pathJoin, dirname: pathDirname } = await import('node:path');
      const { fileURLToPath: pathFileURLToPath } = await import('node:url');
      const { writeFileSync } = await import('node:fs');

      const thisDir = pathDirname(pathFileURLToPath(import.meta.url));
      // hook.sh lives in lib/shell/ — go up from dist/ to package root, then into lib/
      const pkgRoot = pathJoin(thisDir, '..');
      const hookPath = pathJoin(pkgRoot, 'lib', 'shell', 'hook.sh');
      const rcFile = pathJoin(slot.path, '.zbb-bashrc');

      // Build cleanse unset commands — apply AFTER sourcing .bashrc so it can't re-export them
      const cleanseList: string[] = [];
      if (repoRoot) {
        const repoConfig = await loadRepoConfig(repoRoot);
        for (const varName of repoConfig.cleanse ?? []) {
          cleanseList.push(`unset ${varName}`);
        }
      }

      // Source the user's normal bashrc first (for aliases, colors, etc.), then overlay zbb
      const rcLines = [
        '# Source user shell config for colors, aliases, etc.',
        '[ -f /etc/bash.bashrc ] && source /etc/bash.bashrc',
        '[ -f ~/.bashrc ] && source ~/.bashrc',
        '',
        '# zbb cleanse — strip vars that .bashrc may have re-exported',
        ...cleanseList,
        '',
        '# zbb slot overrides',
        '[ -n "$ZBB_PS1" ] && PS1="$ZBB_PS1"',
        `[ -f "${hookPath}" ] && source "${hookPath}"`,
      ].join('\n');
      writeFileSync(rcFile, rcLines + '\n', 'utf-8');

      // Check stack health on slot load — show status, update stale state, start heartbeat
      if (slot.hasStacks) {
        const { ensureHeartbeat } = await import('./stack/commands.js');
        const { handleStack } = await import('./stack/commands.js');

        // Run heartbeat check (non-quiet) to show all stack health + update stale states
        console.log('Stack health:');
        await handleStack(['heartbeat'], slot);

        // Start background heartbeat if any stacks are running
        const stacks = await slot.stacks.list();
        const anyRunning = (await Promise.all(stacks.map(async s => {
          const st = await s.getState();
          return st.status === 'healthy' || st.status === 'partial';
        }))).some(Boolean);
        if (anyRunning) {
          await ensureHeartbeat(slot);
        }
      }

      // Spawn subshell
      console.log(`Loading slot '${slotName}'...`);
      const shell = spawn('bash', ['--rcfile', rcFile, '-i'], {
        stdio: 'inherit',
        env: shellEnv,
      });

      shell.on('exit', async (code) => {
        // Stop heartbeat on slot exit
        if (slot.hasStacks) {
          const { stopHeartbeat } = await import('./stack/commands.js');
          await stopHeartbeat(slot);
        }
        process.exit(code ?? 0);
      });

      // Keep the process alive while subshell runs
      await new Promise<void>(() => {});
      break;
    }

    case 'list': {
      // GC first
      await SlotManager.gc();

      const slots = await SlotManager.list();
      if (slots.length === 0) {
        console.log('No slots. Create one with: zbb slot create <name>');
        return;
      }

      // Table header
      const header = '  NAME            STATUS    PORTS   TTL          CREATED';
      console.log(header);

      for (const s of slots) {
        const name = s.name.padEnd(16);
        const status = 'idle'.padEnd(10); // TODO: detect if loaded (check PID)
        const ports = Object.values(s.env.getManifest())
          .filter(m => m.type === 'port').length;
        const portsStr = String(ports).padEnd(8);
        const ttl = s.isEphemeral()
          ? (s.isExpired() ? 'expired' : formatTimeLeft(s.meta.expires!))
          : 'persistent';
        const ttlStr = ttl.padEnd(13);
        const created = s.meta.created.substring(0, 10);
        console.log(`  ${name}${status}${portsStr}${ttlStr}${created}`);
      }
      break;
    }

    case 'info': {
      const slotName = args[1];
      if (!slotName) {
        console.error('Usage: zbb slot info <name>');
        process.exit(1);
      }

      const slot = await SlotManager.load(slotName);
      const manifest = slot.env.getManifest();
      const ports = Object.entries(manifest).filter(([, m]) => m.type === 'port');
      const secrets = Object.entries(manifest).filter(([, m]) => m.type === 'secret');
      const overrides = slot.env.list().filter(k => slot.env.isOverride(k));

      console.log(`Slot: ${slot.name}`);
      console.log(`Created: ${slot.meta.created.substring(0, 10)}`);
      console.log(`Type: ${slot.isEphemeral() ? `ephemeral (expires: ${slot.meta.expires})` : 'persistent'}`);
      console.log('');

      if (ports.length > 0) {
        console.log('Ports:');
        for (const [name, m] of ports) {
          console.log(`  ${name}=${m.allocated}  (${m.source})`);
        }
        console.log('');
      }

      console.log(`Secrets: ${secrets.length} generated`);
      console.log(`Env vars: ${slot.env.list().length} total (${overrides.length} overrides)`);
      console.log('');
      console.log('Directories:');
      console.log(`  config  ${slot.configDir}`);
      console.log(`  logs    ${slot.logsDir}`);
      console.log(`  state   ${slot.stateDir}`);
      break;
    }

    case 'delete': {
      const slotName = args[1];
      if (!slotName) {
        console.error('Usage: zbb slot delete <name>');
        process.exit(1);
      }
      const result = await SlotManager.delete(slotName);
      const parts = [`Slot '${slotName}' deleted.`];
      if (result.containers > 0) parts.push(`Removed ${result.containers} container(s).`);
      if (result.volumes > 0) parts.push(`Removed ${result.volumes} volume(s).`);
      if (result.containers === 0 && result.volumes === 0) parts.push('No docker resources to clean up.');
      console.log(parts.join(' '));
      break;
    }

    case 'gc': {
      const deleted = await SlotManager.gc();
      if (deleted.length === 0) {
        console.log('No expired ephemeral slots.');
      } else {
        console.log(`Removed ${deleted.length} expired slot(s): ${deleted.join(', ')}`);
      }
      break;
    }

    default:
      console.error(`Unknown slot command: ${sub}`);
      console.error('Usage: zbb slot <create|load|list|info|delete|gc>');
      process.exit(1);
  }
}

// ── Secret Commands ──────────────────────────────────────────────────

async function handleSecretCmd(args: string[]): Promise<void> {
  const slotName = process.env.ZB_SLOT;
  if (!slotName) {
    console.error('Not inside a loaded slot. Run: zbb slot load <name>');
    process.exit(1);
  }

  if (!args[0]) {
    console.error('Usage: zbb secret <create|get|list|update|delete>');
    process.exit(1);
  }

  const slot = await SlotManager.load(slotName);
  const { handleSecret } = await import('./secret.js');
  return handleSecret(args, slot);
}

// ── Env Commands ─────────────────────────────────────────────────────

async function handleEnv(args: string[]): Promise<void> {
  const slotName = process.env.ZB_SLOT;
  if (!slotName) {
    console.error('Not inside a loaded slot. Run: zbb slot load <name>');
    process.exit(1);
  }

  const slot = await SlotManager.load(slotName);
  const sub = args[0];

  // Detect stack context for stack-scoped env operations
  const stackCtx = slot.hasStacks
    ? (process.env.ZB_STACK
        ? await slot.stacks.load(process.env.ZB_STACK)
        : await detectStackContext(slot))
    : null;

  switch (sub) {
    case 'list': {
      const unmask = args.includes('--unmask');

      if (stackCtx) {
        // Stack-scoped env list
        const manifest = stackCtx.env.getManifest();
        console.log(`  [stack: ${stackCtx.name}]`);
        for (const key of stackCtx.env.list()) {
          const value = unmask ? stackCtx.env.get(key)! : (stackCtx.env.shouldMask(key) ? '***' : stackCtx.env.getMasked(key)!);
          const entry = manifest[key];
          const resolution = entry?.resolution ?? '';
          const typeInfo = entry?.type ?? '';
          console.log(`  ${key}=${value}  (${resolution} — ${typeInfo})`);
        }
      } else {
        // Slot-level env list
        const manifest = slot.env.getManifest();
        for (const key of slot.env.list()) {
          const value = unmask ? slot.env.get(key)! : (slot.env.shouldMask(key) ? '***' : slot.env.getMasked(key)!);
          const entry = manifest[key];
          const source = entry?.source ?? '';
          const typeInfo = entry?.derived ? 'derived' : (entry?.type ?? '');
          const override = slot.env.isOverride(key) ? ' (override)' : '';
          console.log(`  ${key}=${value}  (${source} — ${typeInfo}${override})`);
        }
      }
      break;
    }

    case 'get': {
      const key = args[1];
      if (!key) {
        console.error('Usage: zbb env get <VAR>');
        process.exit(1);
      }
      const value = stackCtx ? stackCtx.env.get(key) : slot.env.get(key);
      if (value === undefined) {
        console.error(`Variable '${key}' not set.`);
        process.exit(1);
      }
      console.log(value);
      break;
    }

    case 'set': {
      const key = args[1];
      const value = args[2];
      if (!key || value === undefined) {
        console.error('Usage: zbb env set <VAR> <value>');
        process.exit(1);
      }
      if (stackCtx) {
        const old = stackCtx.env.get(key);
        await stackCtx.env.set(key, value);
        console.log(`  ${key}: ${old ?? '(unset)'} -> ${value} (stack: ${stackCtx.name})`);
        // Sync merged slot .env
        await slot.stacks.syncSlotEnv();
      } else {
        const old = slot.env.get(key);
        await slot.env.set(key, value);
        console.log(`  ${key}: ${old ?? '(unset)'} -> ${value} (saved to overrides.env)`);
      }
      break;
    }

    case 'unset': {
      const key = args[1];
      if (!key) {
        console.error('Usage: zbb env unset <VAR>');
        process.exit(1);
      }
      if (stackCtx) {
        await stackCtx.env.unset(key);
        // Sync merged slot .env
        await slot.stacks.syncSlotEnv();
      } else {
        await slot.env.unset(key);
      }
      console.log(`  ${key}: unset`);
      break;
    }

    case 'reset': {
      if (stackCtx) {
        console.error('Reset is only supported at slot level, not per-stack.');
        process.exit(1);
      }
      await slot.env.reset();
      console.log('All overrides cleared.');
      break;
    }

    case 'refresh': {
      const repoRoot = findRepoRoot(process.cwd());
      if (!repoRoot) {
        console.error('Could not find repo root (.zbb.yaml or gradlew)');
        process.exit(1);
      }
      console.log('Resolving external sources (DNS + vault)...');
      const result = await slot.resolve(repoRoot);
      if (result.refreshed.length > 0) {
        for (const name of result.refreshed) {
          console.log(`  \u2713 ${name}`);
        }
      }
      if (result.errors.length > 0) {
        for (const { name, error } of result.errors) {
          console.error(`  \u2717 ${name}: ${error}`);
        }
        process.exit(1);
      }
      if (result.refreshed.length === 0 && result.errors.length === 0) {
        console.log('  No vars to refresh.');
      }
      break;
    }

    case 'explain': {
      const key = args[1];
      if (!key) {
        console.error('Usage: zbb env explain <VAR>');
        process.exit(1);
      }

      if (stackCtx) {
        const result = stackCtx.env.explain(key, stackCtx.manifest.env);
        console.log(`  Name:        ${result.name}`);
        if (result.type) console.log(`  Type:        ${result.type} (from ${stackCtx.identity.name})`);
        if (result.description) console.log(`  Description: ${result.description}`);
        console.log(`  Resolution:  ${result.resolution}`);
        if (result.formula) console.log(`  Formula:     ${result.formula}`);
        if (result.inputs) {
          const inputStr = Object.entries(result.inputs).map(([k, v]) => `${k} = ${v}`).join(', ');
          console.log(`  Inputs:      ${inputStr}`);
        }
        console.log(`  Current:     ${result.current ?? '(unset)'}`);
        if (result.from) console.log(`  From:        ${result.from}`);
        if (result.original_name) console.log(`  Original:    ${result.original_name}`);
        console.log(`  Overridable: ${result.overridable ? 'yes' : 'no'}`);
      } else {
        const value = slot.env.get(key);
        const entry = slot.env.getManifestEntry(key);
        console.log(`  Name:   ${key}`);
        console.log(`  Value:  ${slot.env.shouldMask(key) ? '***MASKED***' : (value ?? '(unset)')}`);
        console.log(`  Source: ${entry?.source ?? 'unknown'}`);
        console.log(`  Type:   ${entry?.type ?? 'string'}`);
        if (entry?.derived) console.log('  Derived: yes');
      }
      break;
    }

    case 'resolve': {
      if (stackCtx) {
        await stackCtx.env.resolve();
        console.log(`Resolved stack '${stackCtx.name}' environment.`);
      } else {
        const repoRoot = findRepoRoot(process.cwd());
        await slot.resolve(repoRoot ?? undefined);
        console.log(`Resolved slot '${slot.name}' environment.`);
      }
      break;
    }

    case 'diff': {
      const slotEnv = slot.env.getAll();
      const parentKeys = new Set(Object.keys(process.env));
      const slotKeys = new Set(Object.keys(slotEnv));

      // Vars added by slot
      for (const key of slotKeys) {
        if (!parentKeys.has(key)) {
          const value = slot.env.shouldMask(key) ? '***' : slotEnv[key];
          console.log(`  + ${key}=${value}`);
        } else if (process.env[key] !== slotEnv[key]) {
          const value = slot.env.shouldMask(key) ? '***' : slotEnv[key];
          console.log(`  ~ ${key}=${value}`);
        }
      }
      break;
    }

    default:
      console.error(`Unknown env command: ${sub}`);
      console.error('Usage: zbb env <list|get|set|unset|reset|resolve|refresh|explain|diff>');
      process.exit(1);
  }
}

// ── Logs Commands ────────────────────────────────────────────────────

async function handleLogs(args: string[]): Promise<void> {
  const slotName = process.env.ZB_SLOT;
  if (!slotName) {
    console.error('Not inside a loaded slot. Run: zbb slot load <name>');
    process.exit(1);
  }

  const slot = await SlotManager.load(slotName);
  const sub = args[0];

  // Resolve stack log sources if in stack context
  const logStackCtx = slot.hasStacks
    ? (process.env.ZB_STACK
        ? await slot.stacks.load(process.env.ZB_STACK)
        : await detectStackContext(slot))
    : null;

  switch (sub) {
    case 'list': {
      const { readdir, stat } = await import('node:fs/promises');
      const { existsSync } = await import('node:fs');
      const { join } = await import('node:path');

      // Stack-declared log sources
      if (slot.hasStacks) {
        const stacks = await slot.stacks.list();
        for (const stack of stacks) {
          if (!stack.manifest.logs) continue;
          const logs = stack.manifest.logs;
          const envAll = stack.env.getAll();
          const interpolateStr = (s: string) => s.replace(/\$\{([^}]+)\}/g, (_, k) => envAll[k] ?? process.env[k] ?? `\${${k}}`);

          if ('source' in logs) {
            // Single source
            const src = logs as import('./config.js').LogSourceConfig;
            const label = src.container ? interpolateStr(src.container) : (src.path ? interpolateStr(src.path) : stack.name);
            console.log(`  ${stack.name.padEnd(16)} (${src.source})   ${label}`);
          } else {
            // Multi-source
            for (const [name, src] of Object.entries(logs)) {
              const typed = src as import('./config.js').LogSourceConfig;
              const label = typed.container ? interpolateStr(typed.container) : (typed.path ? interpolateStr(typed.path) : name);
              console.log(`  ${stack.name}:${name}`.padEnd(18) + ` (${typed.source})   ${label}`);
            }
          }
        }
      }
      const { execSync } = await import('node:child_process');

      // File-based logs
      if (existsSync(slot.logsDir)) {
        const files = await readdir(slot.logsDir);
        const logFiles = files.filter(f => f.endsWith('.log'));

        for (const f of logFiles) {
          const s = await stat(join(slot.logsDir, f));
          const size = formatSize(s.size);
          const modified = formatAge(s.mtimeMs);
          const name = f.replace('.log', '');
          console.log(`  ${name.padEnd(16)} ${size.padEnd(10)} modified ${modified}`);
        }
      }

      // Docker container logs
      const stackName = slot.env.get('STACK_NAME') ?? slot.name;
      try {
        const containers = execSync(
          `docker ps --filter "name=${stackName}-" --format "{{.Names}}\t{{.Status}}"`,
          { encoding: 'utf8' }
        ).trim();
        if (containers) {
          for (const line of containers.split('\n')) {
            const [fullName, status] = line.split('\t');
            const name = fullName.replace(`${stackName}-`, '');
            const statusShort = status.replace(/\s*\(.*\)/, '').toLowerCase();
            console.log(`  ${name.padEnd(16)} (docker)   ${statusShort}`);
          }
        }
      } catch { /* docker not available */ }

      break;
    }

    case 'show': {
      const logName = args[1];
      if (!logName) {
        console.error('Usage: zbb logs show <name> [--source local|docker|aws] [-n|--tail N] [-f|--follow]');
        process.exit(1);
      }

      const follow = args.includes('--follow') || args.includes('-f');
      const tailIdx = Math.max(args.indexOf('--tail'), args.indexOf('-n'));
      const tailN = tailIdx !== -1 ? args[tailIdx + 1] : '50';
      const sourceIdx = args.indexOf('--source');
      let source = sourceIdx !== -1 ? args[sourceIdx + 1] : 'auto';

      // Try to resolve from stack log declarations first
      // Supports: "dana" (single source), "hub:server" (substack), "hub:node:app" (named source)
      if (source === 'auto' && slot.hasStacks) {
        const logParts = logName.split(':');
        const targetStackName = logParts[0];
        const logSourceName = logParts.length > 1 ? logParts.slice(1).join(':') : undefined;

        try {
          const targetStack = await slot.stacks.load(targetStackName);
          if (targetStack.manifest.logs) {
            const logs = targetStack.manifest.logs;
            const envAll = targetStack.env.getAll();
            const interpolateLogStr = (s: string) => s.replace(/\$\{([^}]+)\}/g, (_, k) => envAll[k] ?? process.env[k] ?? `\${${k}}`);

            let logConfig: import('./config.js').LogSourceConfig | undefined;
            if ('source' in logs) {
              logConfig = logs as import('./config.js').LogSourceConfig;
            } else if (logSourceName && logSourceName in logs) {
              logConfig = (logs as Record<string, import('./config.js').LogSourceConfig>)[logSourceName];
            }

            if (logConfig) {
              source = logConfig.source;
              // Override log target based on config
              if (logConfig.source === 'docker' && logConfig.container) {
                // Will be used below in docker case
                process.env._ZBB_LOG_CONTAINER = interpolateLogStr(logConfig.container);
              } else if (logConfig.source === 'file' && logConfig.path) {
                process.env._ZBB_LOG_PATH = interpolateLogStr(logConfig.path);
              } else if (logConfig.source === 'aws' && logConfig.log_group) {
                process.env._ZBB_LOG_GROUP = interpolateLogStr(logConfig.log_group);
              }
            }
          }
        } catch { /* stack not found, fall through to auto-detect */ }
      }

      // Auto-detect source: try local file, fall back to docker
      if (source === 'auto') {
        const { join } = await import('node:path');
        const { existsSync } = await import('node:fs');
        const logPath = join(slot.logsDir, `${logName}.log`);
        if (existsSync(logPath)) {
          source = 'local';
        } else {
          source = 'docker';
        }
      }

      const { spawn: spawnChild } = await import('node:child_process');

      /** Spawn a command with stdio inherited; resolves on exit, rejects on error. */
      const run = (cmd: string, cmdArgs: string[]) =>
        new Promise<void>((resolve, reject) => {
          const child = spawnChild(cmd, cmdArgs, { stdio: 'inherit' });
          child.on('error', reject);
          child.on('exit', () => resolve());
        });

      switch (source) {
        case 'local':
        case 'file': {
          const { join } = await import('node:path');
          const { existsSync } = await import('node:fs');
          const logPath = process.env._ZBB_LOG_PATH ?? join(slot.logsDir, `${logName}.log`);
          delete process.env._ZBB_LOG_PATH;

          if (!existsSync(logPath)) {
            console.error(`Log file not found: ${logPath}`);
            process.exit(1);
          }

          const tailArgs = ['-n', tailN];
          if (follow) tailArgs.push('-f');
          tailArgs.push(logPath);

          await run('tail', tailArgs);
          break;
        }

        case 'docker': {
          const containerName = process.env._ZBB_LOG_CONTAINER ?? `${slot.env.get('STACK_NAME') ?? slot.name}-${logName}`;
          delete process.env._ZBB_LOG_CONTAINER;
          const dockerArgs = ['logs', '--tail', tailN];
          if (follow) dockerArgs.push('-f');
          dockerArgs.push(containerName);

          try {
            await run('docker', dockerArgs);
          } catch {
            console.error(`Docker container not found or docker not available: ${containerName}`);
          }
          break;
        }

        case 'aws': {
          const envKey = `HUB_AWS_LOG_GROUP_${logName.toUpperCase().replace(/-/g, '_')}`;
          const logGroup = process.env._ZBB_LOG_GROUP ?? slot.env.get(envKey) ?? slot.env.get('HUB_AWS_LOG_GROUP');
          delete process.env._ZBB_LOG_GROUP;
          if (!logGroup) {
            console.error(`No log group configured. Set ${envKey} or HUB_AWS_LOG_GROUP in slot env.`);
            process.exit(1);
          }

          const awsArgs = ['logs', 'tail', logGroup];
          if (follow) awsArgs.push('--follow');

          try {
            await run('aws', awsArgs);
          } catch {
            console.error('AWS CLI not found or not configured. Install aws-cli and run: aws configure');
          }
          break;
        }

        default:
          console.error(`Unknown source: ${source}. Use: local, docker, aws`);
          process.exit(1);
      }
      break;
    }

    case 'debug': {
      const serviceName = args[1];
      if (!serviceName) {
        console.error('Usage: zbb logs debug <service>');
        process.exit(1);
      }
      await signalContainer(slot, serviceName, 'SIGUSR2', 'DEBUG');
      break;
    }

    case 'info': {
      const serviceName = args[1];
      if (!serviceName) {
        console.error('Usage: zbb logs info <service>');
        process.exit(1);
      }
      await signalContainer(slot, serviceName, 'SIGUSR1', 'INFO');
      break;
    }

    default:
      console.error(`Unknown logs command: ${sub}`);
      console.error('Usage: zbb logs <list|show|debug|info>');
      process.exit(1);
  }
}

/**
 * Send a signal to the node process inside a Docker container.
 * PID 1 is typically a shell wrapper (start.sh), so we find the
 * actual node process and signal it directly.
 */
async function signalContainer(slot: Slot, serviceName: string, signal: string, levelName: string): Promise<void> {
  const stackName = slot.env.get('STACK_NAME') ?? slot.name;
  const containerName = `${stackName}-${serviceName}`;
  try {
    const { execSync } = await import('node:child_process');
    // Find the node PID inside the container (not PID 1 which is often a shell wrapper)
    const pid = execSync(
      `docker exec ${containerName} sh -c "ps aux | grep '[n]ode' | awk '{print \\$1}' | head -1"`,
      { encoding: 'utf8' }
    ).trim();
    if (!pid) {
      console.error(`No node process found in container: ${containerName}`);
      process.exit(1);
    }
    execSync(`docker exec ${containerName} kill -${signal} ${pid}`);
    console.log(`Log level set to ${levelName} for ${serviceName} (PID ${pid})`);
  } catch {
    console.error(`Failed to signal container: ${containerName}`);
    process.exit(1);
  }
}

// ── Helpers ──────────────────────────────────────────────────────────

function printUsage(): void {
  console.log(`zbb — ZeroBias Build

Usage:
  zbb slot <create|load|list|info|delete|gc>          Slot management
  zbb stack <add|list|info|remove|update>             Stack management
  zbb registry <start|stop|publish|install|list|clear|status>  Local npm registry
  zbb env <list|get|set|unset|reset|resolve|refresh|explain|diff>  Environment variables
  zbb secret <create|get|list|update|delete>          Secret management
  zbb logs <list|show|debug|info>                     Log viewer + log level control
  zbb run <npm-script> [args...]                      Run npm script with slot/stack env
  zbb run -- <command> [args...]                      Run arbitrary command with slot/stack env
  zbb dataloader [args...]                            Run dataloader with slot SQL env
  zbb publish [--dry-run]                             Publish all artifacts (Gradle)
  zbb <gradle-task> [args...]                         Run Gradle task
  zbb --version                                       Show version
  zbb --help                                          Show this help

Stack commands:
  zbb stack add <path> [--as <alias>]     Add dev stack from local path
  zbb stack add <pkg@version>             Add packaged stack from npm
  zbb stack list                          List stacks in current slot
  zbb stack info <name>                   Show stack details, deps, exports, ports
  zbb stack remove <name>                 Remove stack (runs cleanup hooks)
  zbb stack start <stack[:substack]>      Start stack + deps (health-checked)
  zbb stack stop <stack>                  Stop stack (deps stay running)
  zbb stack restart <stack[:substack]>    Stop + start
  zbb stack status                        Show all stack statuses
  zbb stack build <stack>                 Run stack's build command
  zbb stack test <stack>                  Run stack's test command
  zbb stack gate <stack>                  Run stack's gate command

Registry commands:
  zbb registry start                    Start the local Verdaccio registry
  zbb registry stop                     Stop the registry
  zbb registry publish [path]           Publish a package to the local registry
  zbb registry install [stack]          npm install with local registry
  zbb registry list                     List locally published packages
  zbb registry clear [--all]            Clear local packages (--all = wipe cache)
  zbb registry status                   Show registry status

Lifecycle commands (require zbb.yaml + loaded slot + added stack):
  zbb clean [--all]                        Run lifecycle.clean (or ./gradlew clean)
  zbb build [--all] [--verbose]            Run lifecycle.build (or ./gradlew build)
  zbb test [--all] [--verbose]             Run lifecycle.test (or ./gradlew test)
  zbb gate [--all]                         Run lifecycle.gate (or ./gradlew gate)
  zbb gate --check                         Validate gate-stamp.json (no slot needed)
  zbb publish [--dry-run] [--force]        Run lifecycle.publish (or ./gradlew publish)
  Without zbb.yaml in cwd, all of these fall through to ./gradlew <command>.

Secret commands:
  zbb secret create <name> [key=value ...] [@file.yml] [--type @schema.yml]
  zbb secret get <name> [key] [--json]    Read secret (resolves {{env.X}} refs)
  zbb secret list [--module <key>]        List secrets in slot
  zbb secret update <name> [key=value ...]  Update secret values
  zbb secret delete <name>                Delete secret`);
}

function parseTtl(value: string): number {
  if (!value) return 7200;
  const match = value.match(/^(\d+)(s|m|h)?$/);
  if (!match) throw new Error(`Invalid TTL: ${value}. Use e.g. 30m, 2h, 1800`);
  const num = parseInt(match[1], 10);
  const unit = match[2] ?? 's';
  switch (unit) {
    case 's': return num;
    case 'm': return num * 60;
    case 'h': return num * 3600;
    default: return num;
  }
}

function formatTimeLeft(expires: string): string {
  const ms = new Date(expires).getTime() - Date.now();
  if (ms <= 0) return 'expired';
  const minutes = Math.floor(ms / 60000);
  if (minutes < 60) return `${minutes}m left`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m left`;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)}K`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}M`;
}

function formatAge(mtimeMs: number): string {
  const seconds = Math.floor((Date.now() - mtimeMs) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ago`;
}
