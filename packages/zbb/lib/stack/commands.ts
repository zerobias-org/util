/**
 * CLI handlers for stack and lifecycle commands.
 */

import type { Slot } from '../slot/Slot.js';
import type { Stack } from './Stack.js';
import { findRepoRoot, loadStackManifest } from '../config.js';

/**
 * Handle `zbb stack <subcommand>` routing.
 */
export async function handleStack(args: string[], slot: Slot): Promise<void> {
  const sub = args[0];

  switch (sub) {
    case 'add': {
      const source = args[1];
      if (!source) {
        console.error('Usage: zbb stack add <path|package> [--as <alias>]');
        process.exit(1);
      }
      const asIdx = args.indexOf('--as');
      const alias = asIdx !== -1 ? args[asIdx + 1] : undefined;

      console.log(`Adding stack from ${source}...`);
      const stack = await slot.stacks.add(source, { as: alias });
      const status = await stack.getStatus();

      console.log(`Stack '${stack.name}' added to slot '${slot.name}'`);
      console.log(`  Name:    ${stack.identity.name}`);
      console.log(`  Version: ${stack.identity.version}`);
      console.log(`  Mode:    ${stack.identity.mode}`);
      console.log(`  Source:  ${stack.identity.source}`);
      if (Object.keys(status.ports).length > 0) {
        console.log('  Ports:');
        for (const [name, port] of Object.entries(status.ports)) {
          console.log(`    ${name} = ${port}`);
        }
      }
      if (status.deps.length > 0) {
        console.log(`  Deps:    ${status.deps.join(', ')}`);
      }
      break;
    }

    case 'list': {
      const stacks = await slot.stacks.list();
      if (stacks.length === 0) {
        console.log('No stacks in this slot. Add one with: zbb stack add <path>');
        return;
      }

      console.log(`Stacks in slot '${slot.name}':\n`);
      const header = '  NAME            VERSION     MODE       STATUS     DEPS';
      console.log(header);

      for (const stack of stacks) {
        const status = await stack.getStatus();
        const name = stack.name.padEnd(16);
        const version = status.version.padEnd(12);
        const mode = status.mode.padEnd(11);
        const st = status.status.padEnd(11);
        const deps = status.deps.join(', ') || '-';
        console.log(`  ${name}${version}${mode}${st}${deps}`);
      }
      break;
    }

    case 'info': {
      const stackName = args[1];
      if (!stackName) {
        console.error('Usage: zbb stack info <name>');
        process.exit(1);
      }

      const stack = await slot.stacks.load(stackName);
      const status = await stack.getStatus();
      const envAll = stack.env.getAll();
      const manifest = stack.env.getManifest();

      console.log(`Stack: ${stack.identity.name}`);
      console.log(`  Alias:   ${stack.name}`);
      console.log(`  Version: ${stack.identity.version}`);
      console.log(`  Mode:    ${stack.identity.mode}`);
      console.log(`  Source:  ${stack.identity.source}`);
      console.log(`  Status:  ${status.status}`);
      console.log(`  Added:   ${stack.identity.added}`);

      if (Object.keys(status.ports).length > 0) {
        console.log('\n  Ports:');
        for (const [name, port] of Object.entries(status.ports)) {
          console.log(`    ${name} = ${port}`);
        }
      }

      if (status.deps.length > 0) {
        console.log(`\n  Dependencies: ${status.deps.join(', ')}`);
      }

      if (stack.manifest.exports?.length) {
        console.log(`\n  Exports: ${stack.manifest.exports.join(', ')}`);
      }

      const envCount = Object.keys(envAll).length;
      const secretCount = Object.values(manifest).filter(m => m.type === 'secret').length;
      console.log(`\n  Env vars: ${envCount} (${secretCount} secrets)`);

      if (stack.manifest.lifecycle) {
        console.log('\n  Lifecycle:');
        for (const [phase, cmd] of Object.entries(stack.manifest.lifecycle)) {
          const cmdStr = typeof cmd === 'string' ? cmd : JSON.stringify(cmd);
          console.log(`    ${phase}: ${cmdStr}`);
        }
      }
      break;
    }

    case 'remove': {
      let stackName = args[1];
      if (!stackName) {
        console.error('Usage: zbb stack remove <name|path>');
        process.exit(1);
      }
      // If the argument looks like a path (., ./, /, ~), resolve the
      // stack name from the manifest — same logic as `stack add .`.
      if (stackName === '.' || stackName.startsWith('./') || stackName.startsWith('/') || stackName.startsWith('~')) {
        const { resolve: resolvePath } = await import('node:path');
        const { existsSync } = await import('node:fs');
        const sourcePath = resolvePath(stackName);
        const manifest = await loadStackManifest(sourcePath);
        if (!manifest) {
          console.error(`No stack manifest found at ${sourcePath}/zbb.yaml`);
          process.exit(1);
        }
        // Extract short name (same as StackManager.extractShortName)
        stackName = manifest.name.split('/').pop() ?? manifest.name;
      }
      await slot.stacks.remove(stackName);
      break;
    }

    case 'update': {
      console.error('Packaged stack updates are not yet implemented.');
      process.exit(1);
    }

    case 'destroy': {
      const stackName = args[1] ?? await detectStackName(slot);
      if (!stackName) {
        console.error('Usage: zbb stack destroy <name>');
        process.exit(1);
      }
      const stack = await slot.stacks.load(stackName);
      // Stop first
      try { await stack.runLifecycle('stop'); } catch { /* ignore */ }
      // Run cleanup (docker compose down -v — removes containers + volumes)
      if (stack.manifest.lifecycle?.cleanup) {
        await stack.runLifecycle('cleanup');
      }
      console.log(`Destroyed ${stackName} (app data removed, stack config preserved)`);
      break;
    }

    case 'heartbeat':
      return handleHeartbeat(slot, { quiet: args.includes('--quiet') });

    // Lifecycle commands under `zbb stack <verb>`
    case 'start':
    case 'stop':
    case 'restart':
    case 'status':
      return handleLifecycle(sub, args.slice(1), slot);

    default:
      console.error(`Unknown stack command: ${sub}`);
      console.error('Usage: zbb stack <add|list|info|start|stop|restart|destroy|remove>');
      process.exit(1);
  }
}

/**
 * Handle lifecycle commands: start, stop, restart, build, test, gate, status.
 */
export async function handleLifecycle(
  command: string,
  args: string[],
  slot: Slot,
): Promise<void> {
  switch (command) {
    case 'start': {
      const target = args[0] ?? await detectStackName(slot);
      if (!target) {
        console.error('Usage: zbb start <stack[:substack]>');
        process.exit(1);
      }

      // Run preflight checks for tools required during stack operations.
      // Filter require entries to those with `commands:` including 'stack'
      // (or no commands filter = always required).
      const stackName = target.split(':')[0];
      const stack = await slot.stacks.load(stackName);
      if (stack.manifest.require && stack.manifest.require.length > 0) {
        const { runPreflightChecks, formatPreflightResults } = await import('../preflight.js');
        const applicable = stack.manifest.require.filter(
          (r: any) => !r.commands || r.commands.includes('stack'),
        );
        if (applicable.length > 0) {
          const results = runPreflightChecks(applicable);
          const failed = results.filter(r => !r.ok);
          if (failed.length > 0) {
            console.log(formatPreflightResults(results));
            process.exit(1);
          }
        }
      }

      console.log(`Starting ${target}...`);
      await slot.stacks.start(target);
      console.log(`Started ${target}`);

      // Ensure heartbeat background loop is running
      await ensureHeartbeat(slot);
      break;
    }

    case 'stop': {
      const target = args[0] ?? await detectStackName(slot);
      if (!target) {
        console.error('Usage: zbb stop <stack>');
        process.exit(1);
      }
      await slot.stacks.stop(target);
      console.log(`Stopped ${target}`);

      // Check if any stacks still running — if none, stop heartbeat
      const remaining = await slot.stacks.list();
      const anyRunning = (await Promise.all(remaining.map(async s => {
        const st = await s.getState();
        return st.status === 'healthy' || st.status === 'partial';
      }))).some(Boolean);
      if (!anyRunning) {
        await stopHeartbeat(slot);
      }
      break;
    }

    case 'restart': {
      const target = args[0] ?? await detectStackName(slot);
      if (!target) {
        console.error('Usage: zbb restart <stack[:substack]>');
        process.exit(1);
      }
      await slot.stacks.restart(target);
      console.log(`Restarted ${target}`);
      break;
    }

    case 'build':
    case 'test':
    case 'gate': {
      const target = args[0] ?? await detectStackName(slot);
      if (!target) {
        console.error(`Usage: zbb ${command} <stack>`);
        process.exit(1);
      }
      const stack = await slot.stacks.load(target);
      console.log(`Running ${command} for ${target}...`);
      const code = await stack.runLifecycle(command);
      if (code !== 0) {
        console.error(`${command} failed for ${target} (exit code ${code})`);
        process.exit(code);
      }
      console.log(`${command} passed for ${target}`);
      break;
    }

    case 'status': {
      const statuses = await slot.stacks.status();
      if (statuses.length === 0) {
        console.log('No stacks in this slot.');
        return;
      }

      const header = '  NAME            VERSION     STATUS     PORTS';
      console.log(header);
      for (const s of statuses) {
        const name = s.name.padEnd(16);
        const version = s.version.padEnd(12);
        const status = s.status.padEnd(11);
        const ports = Object.entries(s.ports).map(([k, v]) => `${k}=${v}`).join(', ') || '-';
        console.log(`  ${name}${version}${status}${ports}`);
      }
      break;
    }

    default:
      console.error(`Unknown lifecycle command: ${command}`);
      process.exit(1);
  }
}

/**
 * Detect stack context from cwd — walk up looking for zbb.yaml with a name field,
 * then match against stacks in the slot.
 */
export async function detectStackContext(slot: Slot): Promise<Stack | null> {
  const name = await detectStackName(slot);
  if (!name) return null;
  try {
    return await slot.stacks.load(name);
  } catch {
    return null;
  }
}

async function detectStackName(slot: Slot): Promise<string | null> {
  const repoRoot = findRepoRoot(process.cwd());
  if (!repoRoot) return null;

  const manifest = await loadStackManifest(process.cwd());
  if (!manifest) return null;

  // Extract short name from full package name
  const parts = manifest.name.split('/');
  const shortName = parts[parts.length - 1];

  // Check if this stack exists in the slot
  const stacks = await slot.stacks.list();
  const match = stacks.find(s => s.name === shortName || s.identity.name === manifest.name);
  return match?.name ?? null;
}

// ── Heartbeat ─────────────────────────────────────────────────────

const HEARTBEAT_PID_FILE = 'heartbeat.pid';

/**
 * Run a single heartbeat pass — check health of all running stacks.
 * Called by `zbb stack heartbeat` (invoked by the background loop).
 */
async function handleHeartbeat(slot: Slot, options?: { quiet?: boolean }): Promise<void> {
  const stacks = await slot.stacks.list();
  const quiet = options?.quiet ?? false;

  for (const stack of stacks) {
    const state = await stack.getState();
    const prevStatus = String(state.status);

    // Skip stopped/stopping stacks — intentionally not running
    // Skip starting stacks — zbb's own start flow is managing the health check
    if (prevStatus === 'stopped' || prevStatus === 'stopping' || prevStatus === 'starting') {
      if (!quiet) console.log(`  \x1b[90m${stack.name} — ${prevStatus}\x1b[0m`);
      continue;
    }

    // Skip stacks without a health check
    if (!stack.manifest.lifecycle?.health) {
      if (!quiet) console.log(`  ${stack.name} — ${prevStatus} (no health check)`);
      continue;
    }

    const code = await stack.runLifecycleQuiet('health');

    if (code !== 0 && prevStatus !== 'error') {
      // Was healthy/partial, now failing
      await stack.setState({ status: 'error' });
      console.error(`\x07\x1b[31m[heartbeat] ${stack.name} — error (was ${prevStatus})\x1b[0m`);
    } else if (code === 0 && prevStatus === 'error') {
      // Was error, now passing — recovered
      await stack.setState({ status: 'healthy' });
      console.log(`\x1b[32m[heartbeat] ${stack.name} — recovered\x1b[0m`);
    } else if (code === 0) {
      // Still healthy
      if (!quiet) console.log(`  \x1b[32m${stack.name} — healthy\x1b[0m`);
    } else {
      // Still in error
      if (!quiet) console.log(`  \x1b[31m${stack.name} — error\x1b[0m`);
    }
  }
}

/**
 * Ensure a heartbeat background loop is running for this slot.
 * Spawns `zbb stack heartbeat` every 30s in the background.
 * Writes PID to slot state so duplicates are prevented.
 */
export async function ensureHeartbeat(slot: Slot): Promise<void> {
  const { join } = await import('node:path');
  const { readFileSync, writeFileSync, existsSync } = await import('node:fs');
  const { spawn } = await import('node:child_process');

  const pidFile = join(slot.path, 'state', HEARTBEAT_PID_FILE);

  // Check if already running
  if (existsSync(pidFile)) {
    try {
      const pid = parseInt(readFileSync(pidFile, 'utf-8').trim(), 10);
      if (pid > 0) {
        process.kill(pid, 0); // throws if process doesn't exist
        return; // already running
      }
    } catch {
      // PID stale — continue to start new one
    }
  }

  // Spawn background loop: runs zbb stack heartbeat every 30s
  // Writes heartbeat alerts to a file that the shell hook checks on each prompt
  const { join: joinPath } = await import('node:path');
  const alertsFile = joinPath(slot.path, 'state', 'heartbeat-alerts.log');

  const child = spawn('bash', ['-c', `
    ALERTS_FILE="${alertsFile}"
    while true; do
      sleep 30
      OUTPUT=$(zbb stack heartbeat --quiet 2>&1)
      if [ -n "$OUTPUT" ]; then
        echo "$OUTPUT" >> "$ALERTS_FILE"
      fi
    done
  `], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, ZB_SLOT: slot.name },
  });

  child.unref();

  if (child.pid) {
    writeFileSync(pidFile, String(child.pid), 'utf-8');
  }
}

/**
 * Stop the heartbeat background loop for this slot.
 */
export async function stopHeartbeat(slot: Slot): Promise<void> {
  const { join } = await import('node:path');
  const { readFileSync, unlinkSync, existsSync } = await import('node:fs');

  const pidFile = join(slot.path, 'state', HEARTBEAT_PID_FILE);

  if (!existsSync(pidFile)) return;

  try {
    const pid = parseInt(readFileSync(pidFile, 'utf-8').trim(), 10);
    if (pid > 0) {
      process.kill(pid, 'SIGTERM');
    }
  } catch {
    // Process already dead
  }

  try { unlinkSync(pidFile); } catch { /* ignore */ }
}
