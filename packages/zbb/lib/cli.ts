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
import { isSlotLevelVar } from './slot/SlotEnvironment.js';
import {
  runPreflightChecks,
  formatPreflightResults,
  checkToolGates,
  checkEnvGates,
  formatEnvGateResults,
} from './preflight.js';
import { checkDeprecatedAlias, runGradle } from './gradle.js';
import {
  findLifecycleOwner,
  findMonorepoRoot,
  findRepoRoot,
  findActiveStackInChain,
  findZbbChain,
  loadRepoConfig,
  loadStackManifest,
  loadUserConfig,
  resolveGateRegistry,
  resolveRequireEntries,
  type RepoConfig,
  type StackManifest,
  type ToolDefinition,
  type ToolRequirement,
  type ZbbChainEntry,
} from './config.js';
import { derivePackageScope, type PackageScope } from './monorepo/scope.js';
import { spawn } from 'node:child_process';
import { isLifecycleCommand, parseLifecycleArgs } from './lifecycle.js';
import {
  spawnLifecycleAndExit,
  spawnGradleFallbackAndExit,
} from './monorepo/index.js';
import { handleStack } from './stack/commands.js';
import type { Stack } from './stack/Stack.js';

/**
 * Full slot preparation: resolve (DNS + vault) + re-export to process.env.
 * Shared by: slot load, --slot flag, publish, gate, testHub, and all Gradle commands.
 *
 * Phase 3: there is no longer a "lazy slot extension" step. Slot env
 * vars come from explicitly added stacks (`zbb stack add <path>`), not
 * from a cwd-driven repo scan. The user owns when each stack joins the
 * slot.
 *
 * @param slot - Loaded slot instance
 * @param options.fatal - If true, vault errors abort (exit 1). Default: false (warnings only).
 * @returns repo root path (from findRepoRoot of cwd), or null
 */
/**
 * Resolve slot + (optionally) stack env and apply to process.env.
 *
 * Two layers, applied in order:
 *
 *   1. Slot-level — ZBB_SLOT_VARS only (ZB_SLOT, ZB_SLOT_DIR, paths, etc).
 *      These are the slot's identity/path vars, always applied. Non-slot
 *      vars in the slot's .env are silently filtered out by
 *      SlotEnvironment.getAll().
 *
 *   2. Stack-level — if a stack is provided, that stack's env.resolve()
 *      recursively refreshes its full dep chain (including imports from
 *      other stacks), then the resolved result is overlaid onto
 *      process.env. ZB_STACK carries the stack short name so downstream
 *      consumers know which stack they're in.
 *
 * Without a stack, only the slot-level vars reach process.env. That's
 * the right behavior for commands that don't have a stack context
 * (e.g. `zbb slot list`, `zbb slot delete`, cross-stack admin ops).
 *
 * Key invariant: every call re-runs the stack dep chain resolution, so
 * values are never stale. If the minio stack changes its AWS vars, the
 * next `zbb gate` picks them up.
 */
async function prepareSlot(
  slot: Slot,
  options?: { fatal?: boolean; stack?: Stack | null },
): Promise<string | null> {
  const repoRoot = findRepoRoot(process.cwd());

  // DNS TXT provisioning (slot-level) + per-stack env refresh
  // (file/env/vault). Split explicitly: slot.resolve() is DNS only;
  // StackManager.refreshAll() handles the per-stack work. Pass the
  // stack so vault-sourced vars declared in the stack's zbb.yaml
  // write to the stack's own env instead of the slot.
  await slot.resolve();
  const vaultResult = await slot.stacks.refreshAll({
    repoRoot: repoRoot ?? undefined,
    stack: options?.stack ?? null,
  });

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

  // Layer 1: apply slot-level vars (ZB_SLOT, paths, etc). Filtered by
  // SlotEnvironment.getAll() to only return ZBB_SLOT_VARS.
  const slotEnv = slot.env.getAll();
  for (const [k, v] of Object.entries(slotEnv)) {
    if (v) process.env[k] = v;
  }

  // Layer 2: if a stack context is available, recursively resolve the
  // stack's full dep chain and apply its composed env. Stack.load() is
  // recursive — it walks manifest.depends + manifest.imports keys,
  // resolving each dep stack first, so by the time we call env.getAll()
  // here every imported value is fresh on disk.
  const stack = options?.stack;
  if (stack) {
    try {
      await stack.load();
    } catch (e: any) {
      // Stack import errors (from the fail-loudly check in
      // StackEnvironment.resolve) surface here. Re-throw with the same
      // message — the user needs to fix their zbb.yaml.
      throw new Error(`Failed to resolve stack '${stack.name}':\n${e.message}`);
    }
    // Pass showHidden=true so `hidden: true` vars still reach child
    // processes. `hidden` is a UI concern (suppresses from `zbb env list`) —
    // it must NOT filter env injection into subprocess env. Without this,
    // derived vars like `ORG_GRADLE_PROJECT_mavenCentralUsername` (used to
    // pass Sonatype + signing creds to gradle via its env-to-property
    // convention) are declared `hidden: true` to keep `env list` tidy and
    // end up stripped out here — gradle then reads them as NULL and
    // signing/publishing fails.
    const stackEnv = stack.env.getAll(true);
    for (const [k, v] of Object.entries(stackEnv)) {
      if (v) process.env[k] = v;
    }
    // ZB_STACK carries the current stack's short name. The cd hook
    // sources each stack .env (which contains ZB_STACK) on directory
    // change; here we stamp it for the zbb subprocess path.
    process.env.ZB_STACK = stack.name;
  }

  return repoRoot;
}

/**
 * Resolve the stack context for the current invocation.
 *
 * Resolution order:
 *   1. Explicit hint (from --stack flag, or ZB_STACK already in env).
 *   2. cwd's zbb.yaml manifest — match its `name` against the slot's
 *      added stacks (same logic as the lifecycle dispatcher).
 *   3. null — no stack context.
 *
 * Returning null is normal for invocations outside any stack (e.g.
 * `zbb slot list` from a random directory). Callers that require a
 * stack should error at their call site.
 *
 * Shared by --slot flag, `zbb run`, and the Gradle wrapper fallback
 * so all three dispatch paths load stack env identically to the
 * lifecycle dispatcher.
 */
/**
 * Convert a cwd-derived scope into the opts bag that
 * spawnLifecycleAndExit / spawnGradleFallbackAndExit accept. Only
 * monorepo mode uses this — standard mode's subproject targeting lives
 * in resolveCommandForCwd.
 *
 * At `kind: 'root'` (or `null`) we return `undefined` — no scope flag
 * means the aggregator runs over the full affected set (current
 * behavior when invoked from the repo root). At 'gradle' / 'npm' we
 * pass the npm package name, which is what the Kotlin plugin keys on.
 */
function monorepoScopeOpts(scope: PackageScope | null): { scopePackage?: string } | undefined {
  if (!scope || scope.kind === 'root') return undefined;
  if (scope.kind === 'gradle' || scope.kind === 'npm') {
    return { scopePackage: scope.packageName };
  }
  // 'invalid' — caller should have rejected upstream. Pass no scope so
  // we don't silently succeed on a full-repo run.
  return undefined;
}

/**
 * Find the closest chain entry whose `lifecycle[command]` is a string
 * AND the command is NOT one of the six canonical lifecycle verbs. Used
 * by the custom-verb dispatcher so `zbb buildVm` from a nested dir
 * picks up its definition from the closest zbb.yaml in the chain.
 */
function findCustomVerbOwner(
  chain: ZbbChainEntry[],
  command: string,
): { dir: string; entry: string } | null {
  for (const entry of chain) {
    const lifecycle = entry.config.lifecycle as Record<string, unknown> | undefined;
    const value = lifecycle?.[command];
    if (typeof value === 'string') {
      return { dir: entry.dir, entry: value };
    }
  }
  return null;
}

/**
 * Require a loaded slot for the current invocation. Fails fast with
 * the standard "zbb slot load" hint if `ZB_SLOT` isn't set.
 */
async function requireLoadedSlot(): Promise<Slot> {
  const slotName = process.env.ZB_SLOT;
  if (!slotName) {
    console.error('Not inside a loaded slot. Run: zbb slot load <name>');
    process.exit(1);
  }
  return SlotManager.load(slotName);
}

/**
 * Require a loaded slot AND resolve the active stack context from cwd /
 * `ZB_STACK`. Stack may be null when cwd doesn't map to any added stack —
 * most dispatchers tolerate that (run/exec/gradle fallback). Callers that
 * require a stack must check and error on null themselves.
 */
async function requireLoadedSlotAndStack(): Promise<{ slot: Slot; stack: Stack | null }> {
  const slot = await requireLoadedSlot();
  const stack = await resolveStackForCwd(slot, process.env.ZB_STACK);
  return { slot, stack };
}

async function resolveStackForCwd(slot: Slot, hint?: string): Promise<Stack | null> {
  if (hint) {
    try {
      return await slot.stacks.load(hint);
    } catch {
      return null;
    }
  }
  // Walk up from cwd looking for the nearest zbb.yaml whose name matches
  // an added stack. Nested packages (e.g. appliance/zbb.yaml inside
  // com/hub/zbb.yaml) can declare their own identity without being
  // standalone stacks in the slot — in that case the parent's stack is
  // the right scope. Mirrors the bash cd hook's walk-up logic.
  const addedStacks = await slot.stacks.list();
  const { resolve: resolvePath, dirname } = await import('node:path');
  let dir = process.cwd();
  while (true) {
    const manifest = await loadStackManifest(dir);
    if (manifest) {
      const shortName = manifest.name.split('/').pop() ?? manifest.name;
      const match = addedStacks.find(
        s => s.name === shortName || s.identity.name === manifest.name,
      );
      if (match) return match;
    }
    const parent = resolvePath(dir, '..');
    if (parent === dir) return null;
    dir = parent;
  }
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

  // Global --stack flag: parsed first so --slot handler can use it.
  // Usage: zbb --slot local --stack hub start
  const stackIdx = args.indexOf('--stack');
  if (stackIdx !== -1 && args[stackIdx + 1]) {
    process.env.ZB_STACK = args[stackIdx + 1];
    args = [...args.slice(0, stackIdx), ...args.slice(stackIdx + 2)];
  }

  // Global --slot flag: load slot + stack env before running any command
  // Usage: zbb --slot local build, zbb --slot local --stack hub run qemu
  const slotIdx = args.indexOf('--slot');
  if (slotIdx !== -1 && args[slotIdx + 1]) {
    const slotName = args[slotIdx + 1];
    args = [...args.slice(0, slotIdx), ...args.slice(slotIdx + 2)];

    // Load slot and prepare: extend + resolve (DNS + vault) + re-export env
    const slot = await SlotManager.load(slotName);
    process.env.ZB_SLOT = slotName;

    // Set JAVA_HOME if not already correct. findDefaultJavaHome walks
    // platform-appropriate candidates (brew on macOS, distro paths on
    // Linux) and returns null if none exist — in which case we leave
    // env alone for downstream tools to diagnose.
    if (!process.env.JAVA_HOME || !process.env.JAVA_HOME.includes('21')) {
      const { findDefaultJavaHome } = await import('./java-home.js');
      const java21Home = findDefaultJavaHome();
      if (java21Home) {
        process.env.JAVA_HOME = java21Home;
        process.env.PATH = `${java21Home}/bin:${process.env.PATH ?? ''}`;
      }
    }

    // Resolve stack from ZB_STACK (set above by --stack) or cwd manifest,
    // then apply slot + stack env in one prepareSlot call. Without this,
    // downstream dispatch paths (run, Gradle wrapper fallback) only see
    // slot env — no ports, no imported vars from dep stacks.
    const stack = await resolveStackForCwd(slot, process.env.ZB_STACK);
    await prepareSlot(slot, { stack });
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
  // Walk-up chain: used by lifecycle dispatch + custom-verb dispatch
  // below. Cheap to compute; each file in the chain's parsed YAML is
  // reused without re-reading.
  const chain = await findZbbChain(process.cwd());
  const monorepoEntry = findMonorepoRoot(chain);

  // Slot subcommands
  if (command === 'slot') return handleSlot(args.slice(1));

  // Stack subcommands
  if (command === 'stack') {
    const slot = await requireLoadedSlot();
    return handleStack(args.slice(1), slot);
  }

  // Registry subcommands
  if (command === 'registry') {
    const slot = await requireLoadedSlot();
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

  // Run — execute a named script defined in zbb.yaml lifecycle or
  // package.json scripts. Error if neither defines it. All trailing args
  // pass through to the script implementation.
  if (command === 'run') {
    // Resolve stack context so scripts see the full composed env (ports,
    // imports from dep stacks). Without this, `zbb run` degrades to plain
    // bash with only ZB_SLOT/ZB_SLOT_DIR — defeats the whole point.
    const { slot, stack } = await requireLoadedSlotAndStack();
    await prepareSlot(slot, { stack });

    const runArgs = args.slice(1);
    if (runArgs.length === 0) {
      console.error('Usage: zbb run <script> [args...]');
      console.error('       zbb exec <command> [args...]');
      process.exit(1);
    }

    const scriptName = runArgs[0];
    const scriptArgs = runArgs.slice(1);
    const { spawnSync } = await import('node:child_process');
    const { readFile } = await import('node:fs/promises');
    const { join } = await import('node:path');

    // 1. zbb.yaml `scripts:` — canonical home for user-defined dev scripts.
    const repoRootForRun = findRepoRoot(process.cwd());
    const zbbYaml = repoRootForRun ? await loadRepoConfig(repoRootForRun) : {};
    const zbbScripts = zbbYaml.scripts ?? {};
    const zbbScriptCmd = zbbScripts[scriptName];
    if (zbbScriptCmd) {
      const fullCmd = scriptArgs.length > 0
        ? `${zbbScriptCmd} ${scriptArgs.join(' ')}`
        : zbbScriptCmd;
      const result = spawnSync('bash', ['-c', fullCmd], {
        stdio: 'inherit',
        env: process.env,
        cwd: repoRootForRun ?? process.cwd(),
      });
      process.exit(result.status ?? 1);
    }

    // 2. package.json scripts — fallback for npm-native projects.
    let npmScripts: Record<string, string> = {};
    try {
      const pkg = JSON.parse(await readFile(join(process.cwd(), 'package.json'), 'utf-8'));
      if (pkg && typeof pkg.scripts === 'object') npmScripts = pkg.scripts;
    } catch {
      // no package.json or unreadable
    }
    if (scriptName in npmScripts) {
      const result = spawnSync('npm', ['run', scriptName, ...scriptArgs], {
        stdio: 'inherit',
        env: process.env,
        cwd: process.cwd(),
      });
      process.exit(result.status ?? 1);
    }

    // 3. Error — not defined anywhere.
    console.error(`zbb: no script '${scriptName}' defined.`);
    const zbbKeys = Object.keys(zbbScripts);
    const npmKeys = Object.keys(npmScripts);
    if (zbbKeys.length > 0) {
      console.error(`  zbb.yaml scripts: ${zbbKeys.join(', ')}`);
    }
    if (npmKeys.length > 0) {
      console.error(`  package.json scripts: ${npmKeys.join(', ')}`);
    }
    if (zbbKeys.length === 0 && npmKeys.length === 0) {
      console.error(`  No scripts defined in zbb.yaml or package.json.`);
    }
    console.error(`\nFor arbitrary commands with slot+stack env, use: zbb exec <command>`);
    process.exit(1);
  }

  // Exec — run an arbitrary command with slot+stack env applied.
  // Replaces the legacy `zbb run -- <cmd>` form.
  if (command === 'exec') {
    const { slot, stack } = await requireLoadedSlotAndStack();
    await prepareSlot(slot, { stack });

    const execArgs = args.slice(1);
    if (execArgs.length === 0) {
      console.error('Usage: zbb exec <command> [args...]');
      process.exit(1);
    }
    const { spawnSync } = await import('node:child_process');
    const result = spawnSync(execArgs[0], execArgs.slice(1), {
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
  if (isLifecycleCommand(command) && chain.length > 0) {
    const parsed = parseLifecycleArgs(args.slice(1));

    // Lifecycle owner = the closest chain entry whose zbb.yaml defines
    // `lifecycle[command]`. Falls back to the outermost entry (which is
    // the monorepo root when one exists) — preserving the old
    // "./gradlew <cmd>" passthrough when no file in the chain declares
    // the command. This is what lets `zbb build` from
    // com/hub/node-stack/ pick up com/hub/zbb.yaml's lifecycle.build
    // instead of erroring on the nested stack manifest.
    const owner = findLifecycleOwner(chain, command, parsed);
    if (!owner) {
      console.error('zbb: no zbb.yaml found in cwd or any ancestor directory.');
      process.exit(1);
    }
    const ownerDir = owner.entry.dir;
    const ownerConfig = owner.entry.config;

    // Mode split: monorepo root present in the chain → monorepo
    // dispatch (root aggregators, event pipeline, TUI display). No
    // monorepo root → standard dispatch (plain gradle passthrough with
    // cwd-aware subproject prefixing, no monorepo flags, no pipeline).
    const isMonorepo = monorepoEntry != null;

    // `zbbYaml` used by the preflight / cleanse block below comes from
    // the lifecycle owner — `require:` and `cleanse:` logically belong
    // next to the lifecycle definition they apply to.
    const zbbYaml = ownerConfig as Partial<RepoConfig>;

    // Derive cwd scope once. For standard mode we only use the
    // `{kind:'invalid'}` signal; the actual subproject prefixing lives
    // in standardLifecycle.resolveCommandForCwd.
    const scope: PackageScope | null = isMonorepo
      ? derivePackageScope(process.cwd(), monorepoEntry!.dir)
      : null;

    // Publish from a subpackage is intentionally blocked — see
    // project_publish_subdir_block memory. Scoping publish interacts
    // with the PR #52 changedSinceTag guard in ways that aren't
    // resolved; until they are, require root invocation.
    if (command === 'publish' && scope && scope.kind !== 'root') {
      console.error(
        `zbb publish must be run from the monorepo root (${monorepoEntry!.dir}).\n` +
        `Running from a subpackage is currently not supported — the publish pipeline's\n` +
        `change-detector guard has caveats that need resolving first.`,
      );
      process.exit(1);
    }

    // gate --check fast path: no slot, no stack, no preflight
    if (command === 'gate' && parsed.check) {
      if (isMonorepo) {
        // Same invalid-scope guard as the main lifecycle path — we
        // don't want a gate --check from a non-workspace subdir to
        // silently fall back to a full-repo validation.
        if (scope && scope.kind === 'invalid') {
          console.error(`zbb ${command} --check: ${scope.reason}`);
          process.exit(1);
        }
        const scopeOpts = monorepoScopeOpts(scope);
        if (owner.lifecycleCmd) {
          return spawnLifecycleAndExit(ownerDir, command, owner.lifecycleCmd, parsed, scopeOpts);
        }
        return spawnGradleFallbackAndExit(ownerDir, 'monorepoGateCheck', parsed, scopeOpts);
      }
      // Standard: fall through to the lifecycle entry (or `./gradlew gateCheck`
      // scoped to the cwd subproject). The standard dispatcher handles the
      // subproject prefix logic.
      const { spawnStandardLifecycleAndExit } = await import('./standardLifecycle.js');
      const cmd = owner.lifecycleCmd ?? './gradlew gateCheck';
      return spawnStandardLifecycleAndExit(ownerDir, command, cmd, parsed);
    }

    // All other lifecycle commands require a loaded slot + an added stack
    const slot = await requireLoadedSlot();

    // Resolve the ACTIVE stack — the closest zbb.yaml in the chain
    // whose name matches a stack currently added to the slot. This
    // walks PAST nameless overlays, `overlay: true` markers, and
    // named-but-not-added sub-manifests. The effect: running a
    // lifecycle command from a sub-dir that has its own zbb.yaml
    // (just for lifecycle overrides, not a standalone stack)
    // correctly uses the parent monorepo's stack for context while
    // still picking up the sub-dir's lifecycle overrides.
    const addedStacks = await slot.stacks.list();
    const addedStackNames = new Set(addedStacks.map(s => s.name));
    const addedIdentityNames = new Set(addedStacks.map(s => s.identity.name));
    const activeStackEntry = findActiveStackInChain(chain, addedStackNames, addedIdentityNames);

    if (!activeStackEntry) {
      if (addedStacks.length > 0) {
        const stackList = addedStacks.map(s => `  - ${s.name}`).join('\n');
        console.error(
          `No added stack is reachable from ${process.cwd()}.\n` +
          `Stacks in slot '${slot.name}':\n${stackList}\n\n` +
          `Either cd into the stack's repo, pass --stack <name>, or ` +
          `run zbb stack add on the stack's zbb.yaml.`,
        );
      } else {
        console.error(
          `Slot '${slot.name}' has no stacks added.\n` +
          `Add one with: zbb stack add <path-to-stack-manifest>`,
        );
      }
      process.exit(1);
    }

    const activeManifest = activeStackEntry.config as Partial<StackManifest>;
    const activeName = activeManifest.name!;  // guaranteed by findActiveStackInChain
    const activeShortName = activeName.split('/').pop() ?? activeName;
    const stack = addedStacks.find(
      s => s.name === activeShortName || s.identity.name === activeName,
    )!;

    // Apply repo-level cleanse FIRST so parent-shell leaks get stripped
    // before the slot/stack env is applied. Ordering matters: if cleanse
    // ran AFTER prepareSlot, cleansing a var would remove a value the
    // stack just provided (the correct value), not a parent-shell leak.
    if (zbbYaml.cleanse && zbbYaml.cleanse.length > 0) {
      for (const varName of zbbYaml.cleanse) {
        delete process.env[varName];
      }
    }

    // Apply slot-level + stack-level env. prepareSlot:
    //   1. Applies slot identity/path vars (ZB_SLOT, ZB_SLOT_DIR, etc)
    //   2. Recursively resolves the stack's full dep chain
    //   3. Applies the resolved stack env (including imports from dep stacks)
    //   4. Injects ZB_STACK from stack.name
    //
    // Without the stack parameter, only slot ZB_* vars would be applied —
    // the user's tests would have no PG/AWS/port vars at all.
    await prepareSlot(slot, { fatal: false, stack });

    // Run preflight from `require:`
    //
    // New model: `require:` is stack-level — always runs, no filter.
    // Entries can be string name references (resolved against the
    // stack manifest's `tools:` registry) or inline ToolRequirement
    // objects. Legacy inline entries with a `commands:` filter still
    // parse and, for back-compat during migration, we still honor that
    // filter — so an in-progress repo keeps its existing per-command
    // preflight behavior until the author moves those entries into
    // lifecycle.<cmd>.tools.
    if (zbbYaml.require && zbbYaml.require.length > 0) {
      const userConfig = await loadUserConfig();
      // require: names resolve against the ACTIVE stack's tools registry.
      // Overlay sub-dirs don't carry their own tools: — they borrow the
      // active stack's, so the registry lookup must walk to the added
      // ancestor rather than stopping at the closest named file.
      const stackTools = (activeStackEntry.config as { tools?: Record<string, ToolDefinition> } | undefined)?.tools;
      const { requirements, unresolved } = resolveRequireEntries(zbbYaml.require, stackTools);
      if (unresolved.length > 0) {
        console.error(
          `zbb ${command}: require: names not defined in tools: registry: ` +
          `${unresolved.join(', ')}. Add them to the stack manifest's tools: block.`,
        );
        process.exit(1);
      }
      const applicable = requirements.filter(r => {
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

    // New per-command gates: `lifecycle.<cmd>.tools` + `lifecycle.<cmd>.env`.
    // These only fire when the lifecycle entry is in object form. String
    // shorthand = no gates. Both lists resolve against the ACTIVE stack's
    // tools/env registry — overlay lifecycle entries borrow the stack's
    // vocabulary, they don't declare their own.
    if ((owner.tools && owner.tools.length > 0) || (owner.env && owner.env.length > 0)) {
      const registry = resolveGateRegistry(activeStackEntry);
      const userConfig = await loadUserConfig();
      let gateFailed = false;

      if (owner.tools && owner.tools.length > 0) {
        const results = checkToolGates(owner.tools, registry.tools, userConfig.skip_checks);
        const failed = results.filter(r => !r.ok);
        if (failed.length > 0) {
          console.log(formatPreflightResults(results));
          gateFailed = true;
        }
      }

      if (owner.env && owner.env.length > 0) {
        const results = checkEnvGates(
          owner.env,
          registry.envDecls,
          (name) => {
            // Prefer the stack env (resolved deps + imports) when we have
            // a stack context; fall through to slot env for slot-level
            // vars. Both already include the resolved values after
            // prepareSlot ran above.
            return stack.env.get(name) ?? slot.env.get(name);
          },
        );
        const failed = results.filter(r => !r.ok);
        if (failed.length > 0) {
          console.log(formatEnvGateResults(results));
          gateFailed = true;
        }
      }

      if (gateFailed) process.exit(1);
    }

    // Look up lifecycle entry → spawn, or fall through to ./gradlew <cmd>
    if (isMonorepo) {
      // When scope is {kind:'invalid'} AND we're not at root, refuse
      // rather than running the aggregator across the whole monorepo.
      // Refusal message comes straight from scope.reason.
      if (scope && scope.kind === 'invalid') {
        console.error(`zbb ${command}: ${scope.reason}`);
        process.exit(1);
      }
      const scopeOpts = monorepoScopeOpts(scope);
      if (owner.lifecycleCmd) {
        return spawnLifecycleAndExit(ownerDir, command, owner.lifecycleCmd, parsed, scopeOpts);
      }
      return spawnGradleFallbackAndExit(ownerDir, command, parsed, scopeOpts);
    }
    // Standard mode: use the plain-gradle dispatcher with cwd-aware
    // subproject prefixing. No monorepo flags, no TUI display (yet).
    const { spawnStandardLifecycleAndExit } = await import('./standardLifecycle.js');
    const cmd = owner.lifecycleCmd ?? `./gradlew ${command}`;
    return spawnStandardLifecycleAndExit(ownerDir, command, cmd, parsed);
  }

  // ── Custom lifecycle verb from local zbb.yaml ────────────────────────
  // The standard lifecycle dispatcher above only handles the 6 canonical
  // verbs (clean/build/test/gate/publish/dockerBuild). A package can
  // declare additional verbs in its zbb.yaml lifecycle: block — e.g.
  // appliance/zbb.yaml has `buildVm`. Walk the chain so a custom verb
  // defined in an ancestor zbb.yaml is visible from nested subdirs.
  // We scan every chain entry (closest first) — whichever defines the
  // verb owns it. Execution still happens from that owner's dir with
  // slot + stack env wrapped, same as `zbb run`.
  if (chain.length > 0) {
    const customOwner = findCustomVerbOwner(chain, command);
    if (customOwner) {
      const { slot, stack } = await requireLoadedSlotAndStack();
      await prepareSlot(slot, { stack });

      const extraArgs = args.slice(1);
      const fullCmd = extraArgs.length > 0
        ? `${customOwner.entry} ${extraArgs.join(' ')}`
        : customOwner.entry;
      const { spawnSync } = await import('node:child_process');
      const result = spawnSync('bash', ['-c', fullCmd], {
        stdio: 'inherit',
        env: process.env,
        cwd: customOwner.dir,
      });
      process.exit(result.status ?? 1);
    }
  }

  // ── Permissive gradle fallback ───────────────────────────────────────
  // No zbb.yaml in cwd, or command isn't a lifecycle command. Just run
  // gradle. This preserves the smart-wrapper behaviour for non-zbb repos
  // (resolves subproject from cwd, prefixes task names). Gradle IS the
  // task DAG — custom verbs like `buildVm` wire up their own dependsOn
  // chains. zbb's job here is just to load the env Gradle will inherit.
  if (process.env.ZB_SLOT) {
    const slot = await SlotManager.load(process.env.ZB_SLOT);
    const stack = await resolveStackForCwd(slot, process.env.ZB_STACK);
    await prepareSlot(slot, { stack });
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

      // Run preflight checks and apply cleanse (only if in a project).
      // New model: require: is stack-level — always runs, no filter.
      // Name references resolve against the stack manifest's tools:
      // registry. Legacy inline entries with a `commands: [slot]` filter
      // still work for back-compat during migration.
      if (repoRoot) {
        const repoConfig = await loadRepoConfig(repoRoot);
        const manifest = await loadStackManifest(repoRoot);
        const stackTools = manifest?.tools;
        const { requirements: resolvedReq, unresolved } = resolveRequireEntries(
          repoConfig.require,
          stackTools,
        );
        if (unresolved.length > 0) {
          console.error(
            `zbb slot load: require: names not defined in tools: registry: ` +
            `${unresolved.join(', ')}.`,
          );
          process.exit(1);
        }
        // Legacy filter: if an inline entry has `commands: [...]` without
        // 'slot', exclude it. Pure string name refs (no .commands) pass through.
        const requirements: ToolRequirement[] = resolvedReq.filter(r => {
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

      // Merge slot env + ensure ZB_SLOT is always set (the .env file may
      // not have it if created by an older zbb version or if slot create
      // was interrupted before writing the env file).
      Object.assign(shellEnv, slotEnv);
      shellEnv.ZB_SLOT = slotName;
      shellEnv.ZB_SLOT_DIR = slot.path;

      // Ensure JAVA_HOME is set and on PATH if not already correct.
      // Same platform-aware fallback as the global --slot path above.
      if (!shellEnv.JAVA_HOME || !shellEnv.JAVA_HOME.includes('21')) {
        const { findDefaultJavaHome } = await import('./java-home.js');
        const java21Home = findDefaultJavaHome();
        if (java21Home) {
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
  if (!args[0]) {
    console.error('Usage: zbb secret <create|get|list|update|delete>');
    process.exit(1);
  }
  const slot = await requireLoadedSlot();
  const { handleSecret } = await import('./secret.js');
  return handleSecret(args, slot);
}

// ── Env Commands ─────────────────────────────────────────────────────

/**
 * Route an env key to the right env accessor.
 *
 * The slot only owns the 7 `ZB_SLOT_*` framework path vars; every
 * other var belongs to a stack. Routing by `isSlotLevelVar(key)` picks
 * the correct owner regardless of cwd — a ZB_SLOT_DIR override always
 * hits slot.env, and an app var always hits the stack env even if the
 * user ran the command from the slot root.
 *
 * Callers handle the no-stack-context case themselves (via the
 * returned `scope: 'stack-missing'` signal) so they can emit a command-
 * specific error message.
 */
type EnvAccessor =
  | { scope: 'slot'; env: import('./slot/SlotEnvironment.js').SlotEnvironment }
  | { scope: 'stack'; env: import('./stack/StackEnvironment.js').StackEnvironment; stack: Stack }
  | { scope: 'stack-missing' };

function envAccessorFor(
  key: string,
  slot: Slot,
  stackCtx: Stack | null,
): EnvAccessor {
  if (isSlotLevelVar(key)) return { scope: 'slot', env: slot.env };
  if (!stackCtx) return { scope: 'stack-missing' };
  return { scope: 'stack', env: stackCtx.env, stack: stackCtx };
}

async function handleEnv(args: string[]): Promise<void> {
  const { slot, stack: stackCtx } = await requireLoadedSlotAndStack();
  const sub = args[0];

  switch (sub) {
    case 'list': {
      const unmask = args.includes('--unmask');
      const slotOnly = args.includes('--slot');

      // Default: stack env when a stack context exists; slot env otherwise
      // (e.g. when the user hasn't cd'd into a stack yet). `--slot` forces
      // the slot view — useful for inspecting the 7 framework path vars
      // without cd'ing out of a stack.
      if (stackCtx && !slotOnly) {
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
        const manifest = slot.env.getManifest();
        console.log(`  [slot: ${slot.name}]`);
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
      const acc = envAccessorFor(key, slot, stackCtx);
      if (acc.scope === 'stack-missing') {
        console.error(`'${key}' is a stack-level var but no stack context is active. cd into a stack directory or pass --stack.`);
        process.exit(1);
      }
      const value = acc.env.get(key);
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
      const acc = envAccessorFor(key, slot, stackCtx);
      if (acc.scope === 'stack-missing') {
        console.error(`'${key}' is a stack-level var but no stack context is active. cd into a stack directory or pass --stack.`);
        process.exit(1);
      }
      const old = acc.env.get(key);
      await acc.env.set(key, value);
      const where = acc.scope === 'stack'
        ? `stack: ${acc.stack.name}`
        : 'saved; manifest source: override';
      console.log(`  ${key}: ${old ?? '(unset)'} -> ${value} (${where})`);
      break;
    }

    case 'unset': {
      const key = args[1];
      if (!key) {
        console.error('Usage: zbb env unset <VAR>');
        process.exit(1);
      }
      const acc = envAccessorFor(key, slot, stackCtx);
      if (acc.scope === 'stack-missing') {
        console.error(`'${key}' is a stack-level var but no stack context is active. cd into a stack directory or pass --stack.`);
        process.exit(1);
      }
      try {
        await acc.env.unset(key);
        const where = acc.scope === 'stack' ? ` (stack: ${acc.stack.name})` : '';
        console.log(`  ${key}: override cleared${where}`);
      } catch (err: unknown) {
        console.error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
      break;
    }

    case 'reset': {
      // Slot-only operation — clears the 7 framework-var overrides.
      // Requires an explicit --slot flag so a user inside a stack
      // context doesn't accidentally wipe their intended target.
      // (There's no per-stack reset yet — use `zbb env unset <VAR>`
      // on individual stack overrides.)
      if (!args.includes('--slot')) {
        console.error(
          'zbb env reset clears SLOT-level overrides (the 7 ZB_SLOT_* path vars). ' +
          'Pass --slot to confirm. For stack-level overrides, use `zbb env unset <VAR>`.',
        );
        process.exit(1);
      }
      await slot.env.reset();
      console.log('Slot overrides cleared.');
      break;
    }

    case 'refresh': {
      const repoRoot = findRepoRoot(process.cwd());
      if (!repoRoot) {
        console.error('Could not find repo root (.zbb.yaml or gradlew)');
        process.exit(1);
      }
      console.log('Re-reading external sources (DNS + file + env + vault)...');
      await slot.resolve();
      const result = await slot.stacks.refreshAll({ repoRoot, stack: stackCtx ?? null });
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
        console.log('  No values changed.');
      }
      break;
    }

    case 'explain': {
      const key = args[1];
      if (!key) {
        console.error('Usage: zbb env explain <VAR>');
        process.exit(1);
      }
      const acc = envAccessorFor(key, slot, stackCtx);
      if (acc.scope === 'stack-missing') {
        console.error(`'${key}' is a stack-level var but no stack context is active. cd into a stack directory or pass --stack.`);
        process.exit(1);
      }
      if (acc.scope === 'stack') {
        const result = acc.env.explain(key, acc.stack.manifest.env);
        console.log(`  Name:        ${result.name}`);
        if (result.type) console.log(`  Type:        ${result.type} (from ${acc.stack.identity.name})`);
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
        const value = acc.env.get(key);
        const entry = acc.env.getManifestEntry(key);
        console.log(`  Name:   ${key}`);
        console.log(`  Value:  ${acc.env.shouldMask(key) ? '***MASKED***' : (value ?? '(unset)')}`);
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
        // Slot-level resolve = DNS. For file/env/vault sources, use
        // `zbb env refresh` (which orchestrates DNS + stack refresh).
        await slot.resolve();
        console.log(`Resolved slot '${slot.name}' environment (DNS).`);
      }
      break;
    }

    case 'diff': {
      // Show the delta between the current shell env and what the slot
      // + active stack would produce at command dispatch time. This
      // composes the same two layers that `prepareSlot` in cli.ts
      // applies to process.env before spawning a lifecycle command —
      // without actually applying them.
      const composed: Record<string, string> = { ...slot.env.getAll() };
      const maskFor = new Map<string, (key: string) => boolean>();
      for (const k of Object.keys(composed)) maskFor.set(k, (key) => slot.env.shouldMask(key));

      if (stackCtx) {
        const stackEnv = stackCtx.env.getAll();
        for (const [k, v] of Object.entries(stackEnv)) {
          composed[k] = v;
          maskFor.set(k, (key) => stackCtx.env.shouldMask(key));
        }
        composed.ZB_STACK = stackCtx.name;
        maskFor.set('ZB_STACK', () => false);
      }

      const parentKeys = new Set(Object.keys(process.env));
      for (const key of Object.keys(composed).sort()) {
        const masker = maskFor.get(key);
        const shown = masker && masker(key) ? '***' : composed[key];
        if (!parentKeys.has(key)) {
          console.log(`  + ${key}=${shown}`);
        } else if (process.env[key] !== composed[key]) {
          console.log(`  ~ ${key}=${shown}`);
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
  const { slot, stack: logStackCtx } = await requireLoadedSlotAndStack();
  const sub = args[0];

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
      const stackName = slot.name;
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
          const containerName = process.env._ZBB_LOG_CONTAINER ?? `${slot.name}-${logName}`;
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
  const stackName = slot.name;
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
  zbb run <script> [args...]                          Run a script defined in zbb.yaml lifecycle or package.json, with slot+stack env
  zbb exec <command> [args...]                        Run an arbitrary command with slot+stack env
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
