/**
 * Stack orchestration within a slot.
 * Handles add, remove, list, start, stop, and dependency resolution.
 */

import { join, resolve as resolvePath, dirname } from 'node:path';
import { existsSync } from 'node:fs';
import { readdir, rm, mkdir } from 'node:fs/promises';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import { toposort } from '../graph/toposort.js';
import { generateSecret } from '../env/SecretGen.js';
import { loadStackManifest, getZbbDir } from '../config.js';
import { runPreflightChecks, formatPreflightResults } from '../preflight.js';
import { loadYamlOrDefault, saveYaml } from '../yaml.js';
import { Stack } from './Stack.js';
import { StackEnvironment } from './StackEnvironment.js';
import type { StackManifest, StackIdentity, DependencySpec } from '../config.js';
import type { ImportSpec, StackStatus } from './types.js';
import type { Slot } from '../slot/Slot.js';

/** Regex to detect npm package specs: @scope/name, @scope/name@version, name@version */
const PKG_SPEC_RE = /^(@[\w-]+\/[\w-]+|[\w-]+)(@.+)?$/;

export interface AddOptions {
  as?: string;
}

/**
 * Manages stacks within a single slot.
 */
export class StackManager {
  private slot: Slot;

  constructor(slot: Slot) {
    this.slot = slot;
  }

  get stacksDir(): string {
    return join(this.slot.path, 'stacks');
  }

  // ── Add ─────────────────────────────────────────────────────

  /**
   * Add a stack to the slot from a local path (dev mode).
   * Resolves deps, allocates ports, generates secrets, builds env.
   */
  async add(source: string, options?: AddOptions): Promise<Stack> {
    // Determine mode: dev (local path) or packaged (npm spec)
    // A package spec starts with @ or has no path separators and contains no . or /
    // Local paths start with . or / or are existing directories
    const looksLikePath = source.startsWith('.') || source.startsWith('/') || source.startsWith('~')
      || existsSync(source);  // Local directory takes precedence over package spec
    const isPackageSpec = !looksLikePath && PKG_SPEC_RE.test(source);
    let sourcePath: string;
    let mode: 'dev' | 'packaged';

    if (isPackageSpec) {
      sourcePath = await this.fetchPackagedStack(source);
      mode = 'packaged';
    } else {
      sourcePath = resolvePath(source);
      mode = 'dev';
    }

    // Load stack manifest
    const manifest = await loadStackManifest(sourcePath);
    if (!manifest) {
      throw new Error(
        mode === 'packaged'
          ? `Package '${source}' does not contain a stack manifest (zbb.yaml with 'name' field)`
          : `No stack manifest found at ${sourcePath}/zbb.yaml (missing 'name' field)`,
      );
    }

    const stackName = options?.as ?? this.extractShortName(manifest.name);

    // Check for existing stack with same name
    const stackPath = join(this.stacksDir, stackName);
    if (existsSync(stackPath)) {
      throw new Error(`Stack '${stackName}' already exists in slot '${this.slot.name}'`);
    }

    // Run preflight checks if stack declares tool requirements
    if (manifest.require && manifest.require.length > 0) {
      const results = runPreflightChecks(manifest.require);
      const failed = results.filter(r => !r.ok);
      if (failed.length > 0) {
        console.log(formatPreflightResults(results));
        throw new Error(`Stack '${stackName}' has unmet tool requirements`);
      }
    }

    // Resolve dependencies — auto-pull packaged deps if missing
    await this.resolveDeps(manifest);

    // Validate imports against dependency exports
    const imports = this.resolveImports(manifest);
    await this.validateImports(imports, manifest);

    // Create directory tree
    await Stack.createDirectories(stackPath);

    // Create substack directories for substacks with state declarations
    await Stack.createSubstackDirectories(stackPath, manifest);

    // Allocate ports (reuses cached values from previous add if available)
    const ports = await this.allocatePortsCached(manifest, stackName);

    // Generate secrets (reuses cached values from previous add if available)
    const secrets = await this.generateSecrets(manifest, stackName);

    // Get slot env vars + stack-level vars
    // STACK_NAME = slot name so all stacks share the same Docker compose project/network.
    // ZB_STACK = individual stack name for stack-level identity.
    const slotVars = {
      ...this.slot.getSlotEnvVars(),
      ZB_STACK: stackName,
      STACK_NAME: this.slot.name,
    };

    // Initialize env (builds manifest + .env)
    await StackEnvironment.initialize(
      stackPath,
      manifest.env ?? {},
      ports,
      secrets,
      imports,
      slotVars,
      this.stacksDir,
      sourcePath,
    );

    // For dev mode, override *_IMAGE env vars to use local dev tags.
    // Packaged stacks default to ghcr.io images; dev stacks use locally-built images.
    if (mode === 'dev' && manifest.env) {
      const stack = new Stack(stackName, this.stacksDir);
      await stack.load();
      for (const [key, decl] of Object.entries(manifest.env)) {
        if (key.endsWith('_IMAGE') && decl.default?.includes('ghcr.io')) {
          // Extract the local image name from the ghcr.io path: ghcr.io/org/name:tag → name:dev
          const imageName = decl.default.split('/').pop()?.replace(/:.*$/, '') ?? key;
          const localTag = `${imageName}:dev`;
          stack.env.set(key, localTag);
          console.log(`  [dev] ${key} = ${localTag}`);
        }
      }
    }

    // Write stack identity
    const identity: StackIdentity = {
      name: manifest.name,
      version: manifest.version,
      mode,
      source: sourcePath,
      added: new Date().toISOString(),
      alias: options?.as,
    };
    await saveYaml(join(stackPath, 'stack.yaml'), identity);

    // Initialize state
    await saveYaml(join(stackPath, 'state.yaml'), { status: 'stopped' });

    // Load and return
    const stack = new Stack(stackName, this.stacksDir);
    await stack.load();

    // Sync merged slot-level .env (all stack exports combined)
    await this.syncSlotEnv();

    return stack;
  }

  // ── Remove ──────────────────────────────────────────────────

  async remove(name: string): Promise<void> {
    const stack = new Stack(name, this.stacksDir);
    if (!stack.exists()) {
      throw new Error(`Stack '${name}' not found in slot '${this.slot.name}'`);
    }

    await stack.load();

    // Cascade: remove dependents first (reverse dependency order)
    const allStacks = await this.list();
    const dependents = allStacks.filter(s =>
      s.name !== name && s.manifest.depends && name in s.manifest.depends,
    );
    for (const dep of dependents) {
      console.log(`  Removing dependent '${dep.name}' (depends on '${name}')...`);
      await this.remove(dep.name);
    }

    // Cache secrets and ports before removal — reused if stack is re-added
    await this.cacheStackSecrets(name, stack);

    // Stop the stack first if it's running
    const state = await stack.getState();
    if (state.status === 'healthy' || state.status === 'starting' || state.status === 'degraded') {
      console.log(`Stopping stack '${name}'...`);
      try {
        await stack.runLifecycle('stop');
      } catch {
        // Stop failed — try cleanup anyway
      }
    }

    // Run cleanup lifecycle if defined (removes containers, volumes, temp files)
    if (stack.manifest.lifecycle?.cleanup) {
      console.log(`Running cleanup for stack '${name}'...`);
      try {
        await stack.runLifecycle('cleanup');
      } catch {
        // Cleanup failed — still remove the directory
        console.log(`  Warning: cleanup command failed, removing stack directory anyway.`);
      }
    }

    // Remove stack directory from slot
    await rm(stack.path, { recursive: true, force: true });
    console.log(`Removed stack '${name}'`);

    // Sync merged slot-level .env (removed stack's vars purged)
    await this.syncSlotEnv();
  }

  // ── List / Load / Info ──────────────────────────────────────

  async list(): Promise<Stack[]> {
    if (!existsSync(this.stacksDir)) return [];

    const entries = await readdir(this.stacksDir, { withFileTypes: true });
    const stacks: Stack[] = [];

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const stackYaml = join(this.stacksDir, entry.name, 'stack.yaml');
      if (!existsSync(stackYaml)) continue;

      const stack = new Stack(entry.name, this.stacksDir);
      await stack.load();
      stacks.push(stack);
    }

    return stacks;
  }

  async load(name: string): Promise<Stack> {
    const stack = new Stack(name, this.stacksDir);
    if (!stack.exists()) {
      const available = await this.list();
      const names = available.map(s => s.name).join(', ');
      throw new Error(
        `Stack '${name}' not found in slot '${this.slot.name}'. ` +
        (names ? `Available: ${names}` : 'No stacks added yet.'),
      );
    }
    await stack.load();
    return stack;
  }

  // ── Start / Stop / Restart ──────────────────────────────────

  /**
   * Start a stack and its dependencies in topological order.
   * Supports sub-stack notation: "hub:server"
   */
  async start(target: string): Promise<void> {
    const { stackName, substack } = this.parseTarget(target);

    // Verify the target stack exists before proceeding
    const targetStack = new Stack(stackName, this.stacksDir);
    if (!targetStack.exists()) {
      throw new Error(`Stack '${stackName}' not found in slot '${this.slot.name}'. Add it first: zbb stack add <path>`);
    }

    const startOrder = await this.getStartOrder(stackName);

    for (const name of startOrder) {
      const stack = await this.load(name);
      const state = await stack.getState();

      // If state says healthy/partial, verify with a live health check.
      // Containers may have crashed since the state was last written.
      if (state.status === 'healthy' || state.status === 'partial') {
        const stillHealthy = stack.manifest.lifecycle?.health
          ? (await stack.runLifecycleQuiet('health')) === 0
          : true; // no health check defined — trust state

        if (stillHealthy) {
          if (state.status === 'healthy') {
            console.log(`  ${name} — already running`);
            continue;
          }
          if (state.status === 'partial' && name !== stackName) {
            console.log(`  ${name} — already running (partial)`);
            continue;
          }
        } else {
          console.log(`  ${name} — was healthy but health check failed, restarting...`);
          await stack.setState({ status: 'stopped' });
          // Fall through to start
        }
      }

      if (state.status === 'partial' && name !== stackName) {
        // Dependency is partially running — for deps, partial counts as running
        console.log(`  ${name} — already running (partial)`);
        continue;
      }

      console.log(`  Starting ${name}...`);
      await stack.setState({ status: 'starting' });

      // Substack support: if targeting hub:server and this is the target stack,
      // run the substack's compose/services instead of the top-level start
      let code: number;
      if (substack && name === stackName) {
        code = await this.startSubstack(stack, substack);

        if (code !== 0) {
          await stack.setState({ status: 'error' });
          throw new Error(`Failed to start stack '${name}:${substack}' (exit code ${code})`);
        }

        // Substack start — mark as partial, not fully healthy
        // The full stack health check only applies to full starts
        await stack.setState({ status: 'partial' });

      } else {
        code = await stack.runLifecycle('start');

        if (code !== 0) {
          await stack.setState({ status: 'error' });
          throw new Error(`Failed to start stack '${name}' (exit code ${code})`);
        }

        // Run health check — zbb always verifies health after start.
        if (stack.manifest.lifecycle?.health) {
          const hcode = await stack.runLifecycle('health');
          if (hcode !== 0) {
            await stack.setState({ status: 'error' });
            throw new Error(`Health check failed for stack '${name}'`);
          }
        } else {
          await stack.setState({ status: 'healthy' });
        }
      }
    }

    // Sync merged slot-level .env after full start sequence
    await this.syncSlotEnv();
  }

  /**
   * Stop a stack. Cascades: stops dependents first (reverse dep order).
   */
  async stop(target: string): Promise<void> {
    const { stackName, substack } = this.parseTarget(target);
    const stack = await this.load(stackName);

    // Substack stop — only stop specific services, no cascade
    if (substack) {
      console.log(`  Stopping ${stackName}:${substack}...`);
      await this.stopSubstack(stack, substack);
      return;
    }

    // Cascade: stop dependents first
    const allStacks = await this.list();
    const dependents = allStacks.filter(s =>
      s.name !== stackName && s.manifest.depends && stackName in s.manifest.depends,
    );
    for (const dep of dependents) {
      const depState = await dep.getState();
      if (depState.status === 'healthy' || depState.status === 'starting' || depState.status === 'degraded') {
        console.log(`  Stopping dependent '${dep.name}' (depends on '${stackName}')...`);
        await this.stop(dep.name);
      }
    }

    console.log(`  Stopping ${stackName}...`);
    await stack.setState({ status: 'stopping' });
    const code = await stack.runLifecycle('stop');

    if (code !== 0) {
      await stack.setState({ status: 'error' });
      throw new Error(`Failed to stop stack '${stackName}' (exit code ${code})`);
    }

    await stack.setState({ status: 'stopped' });
  }

  /**
   * Stop specific substack services.
   */
  private async stopSubstack(stack: Stack, substackName: string): Promise<number> {
    const substackConfig = stack.manifest.substacks?.[substackName];
    if (!substackConfig) {
      throw new Error(
        `Substack '${substackName}' not found in '${stack.name}'. ` +
        `Available: ${Object.keys(stack.manifest.substacks ?? {}).join(', ') || 'none'}`,
      );
    }

    // Stop the substack's specific containers
    if (substackConfig.services?.length) {
      const stackEnvName = stack.env.get('STACK_NAME') ?? this.slot.name;
      const containers = substackConfig.services
        .map(s => `${stackEnvName}-${s}`)
        .join(' ');
      const cmd = `docker stop ${containers} 2>/dev/null; docker rm ${containers} 2>/dev/null; true`;
      return stack.execSubstackCommand(cmd);
    }

    return 0;
  }

  async restart(target: string): Promise<void> {
    await this.stop(target);
    await this.start(target);
  }

  // ── Status ──────────────────────────────────────────────────

  async status(): Promise<StackStatus[]> {
    const stacks = await this.list();
    const statuses: StackStatus[] = [];
    for (const stack of stacks) {
      statuses.push(await stack.getStatus());
    }
    return statuses;
  }

  // ── Dependency Resolution ───────────────────────────────────

  /**
   * Get the start order for a stack (topo-sorted deps first, target last).
   */
  async getStartOrder(targetName: string): Promise<string[]> {
    const stacks = await this.list();

    interface DepNode { name: string; deps: string[] }
    const nodes: DepNode[] = stacks.map(s => ({
      name: s.name,
      deps: s.manifest.depends ? Object.keys(s.manifest.depends) : [],
    }));

    const { sorted, cycles } = toposort<DepNode>(
      nodes,
      n => n.name,
      n => n.deps,
    );

    if (cycles.length > 0) {
      throw new Error(`Circular dependency: ${cycles.map(c => c.name).join(' → ')}`);
    }

    // Filter to only include target and its transitive deps
    const needed = new Set<string>();
    const collect = (name: string) => {
      if (needed.has(name)) return;
      needed.add(name);
      const node = nodes.find(n => n.name === name);
      if (node) {
        for (const dep of node.deps) collect(dep);
      }
    };
    collect(targetName);

    return sorted.filter(s => needed.has(s.name)).map(s => s.name);
  }

  // ── Import Resolution ───────────────────────────────────────

  /**
   * Parse import declarations from manifest into ImportSpec[].
   */
  resolveImports(manifest: StackManifest): ImportSpec[] {
    const imports: ImportSpec[] = [];
    if (!manifest.imports) return imports;

    for (const [depName, vars] of Object.entries(manifest.imports)) {
      for (const v of vars) {
        if (typeof v === 'string') {
          // Check for "VAR as ALIAS" syntax
          const match = v.match(/^(\S+)\s+as\s+(\S+)$/);
          if (match) {
            imports.push({ varName: match[1], alias: match[2], fromStack: depName });
          } else {
            imports.push({ varName: v, fromStack: depName });
          }
        } else {
          // ImportAlias object
          imports.push({ varName: v.from, alias: v.as, fromStack: depName });
        }
      }
    }

    return imports;
  }

  // ── Private Helpers ─────────────────────────────────────────

  /**
   * Start a specific substack within a stack, respecting intra-stack deps.
   * E.g., hub:server depends on hub:postgres → start postgres first.
   */
  private async startSubstack(stack: Stack, substackName: string): Promise<number> {
    const allSubstacks = stack.manifest.substacks ?? {};
    const substackConfig = allSubstacks[substackName];
    if (!substackConfig) {
      throw new Error(
        `Substack '${substackName}' not found in '${stack.name}'. ` +
        `Available: ${Object.keys(allSubstacks).join(', ') || 'none'}`,
      );
    }

    // Run seed if defined and not already seeded
    const state = await stack.getState();
    if (stack.manifest.lifecycle?.seed && !state.seeded) {
      const seedCode = await stack.runLifecycle('seed');
      if (seedCode === 0) {
        await stack.setState({ seeded: true });
      }
    }

    // Resolve intra-stack dep ordering: collect substackName + its transitive deps
    const needed = new Set<string>();
    const collectIntraStackDeps = (name: string) => {
      if (needed.has(name)) return;
      needed.add(name);
      const cfg = allSubstacks[name];
      if (cfg?.depends) {
        for (const dep of cfg.depends) collectIntraStackDeps(dep);
      }
    };
    collectIntraStackDeps(substackName);

    // Topo-sort the needed substacks
    interface SubNode { name: string; deps: string[] }
    const subNodes: SubNode[] = [...needed].map(name => ({
      name,
      deps: allSubstacks[name]?.depends?.filter(d => needed.has(d)) ?? [],
    }));
    const { sorted, cycles } = toposort(subNodes, n => n.name, n => n.deps);
    if (cycles.length > 0) {
      throw new Error(`Circular intra-stack dependency in '${stack.name}': ${cycles.map(c => c.name).join(' → ')}`);
    }

    // Start each substack in order
    const stackEnvName = stack.env.get('STACK_NAME') ?? this.slot.name;
    const envFile = join(this.stacksDir, stack.name, '.env');

    for (const sub of sorted) {
      const cfg = allSubstacks[sub.name];
      if (cfg?.compose && cfg.services?.length) {
        const services = cfg.services.join(' ');
        const cmd = `docker compose -f ${cfg.compose} -p ${stackEnvName} --env-file ${envFile} up -d ${services}`;
        const code = await stack.execSubstackCommand(cmd);
        if (code !== 0) return code;
      }
    }

    return 0;
  }

  /**
   * Get the DependencySpec that the target stack declares for a given dependency.
   * Loads the target's manifest to check depends[depName].ready_when.
   */
  private async getDependencySpecForTarget(
    depName: string,
    targetName: string,
  ): Promise<DependencySpec | null> {
    try {
      const target = await this.load(targetName);
      if (!target.manifest.depends) return null;
      const spec = target.manifest.depends[depName];
      if (!spec) return null;
      if (typeof spec === 'string') return null; // no ready_when on string specs
      return spec;
    } catch {
      return null;
    }
  }

  /**
   * Wait for a stack to meet ready_when conditions (poll state.yaml).
   */
  private async waitForReady(
    stack: Stack,
    conditions: Record<string, unknown>,
    timeoutMs = 120_000,
    intervalMs = 2_000,
  ): Promise<boolean> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const met = await stack.checkReadyWhen(conditions);
      if (met) return true;
      await new Promise(r => setTimeout(r, intervalMs));
    }
    return false;
  }

  /**
   * Fetch a packaged stack from the npm registry.
   * Downloads the tarball, extracts it to ~/.zbb/cache/stacks/<name>@<version>/
   * Returns the path to the extracted package directory.
   */
  private async fetchPackagedStack(spec: string): Promise<string> {
    const cacheDir = join(getZbbDir(), 'cache', 'stacks');
    await mkdir(cacheDir, { recursive: true });

    // Use npm pack to download the tarball, then extract
    // npm pack writes a .tgz to cwd and prints the filename
    const tgzName = execSync(`npm pack ${spec} --pack-destination ${cacheDir} 2>/dev/null`, {
      encoding: 'utf-8',
      cwd: cacheDir,
    }).trim().split('\n').pop()!;

    const tgzPath = join(cacheDir, tgzName);

    // Derive a stable cache key from the tarball name (e.g., zerobias-com-dana-1.0.0.tgz)
    const extractDir = join(cacheDir, tgzName.replace(/\.tgz$/, ''));

    // Always re-extract: remove stale extract dir and extract fresh from tarball.
    // Previous logic skipped extraction if the dir existed, but stale/broken
    // extractions from older versions would persist and cause manifest errors.
    if (existsSync(extractDir)) {
      await rm(extractDir, { recursive: true, force: true });
    }
    await mkdir(extractDir, { recursive: true });
    execSync(`tar xzf ${tgzPath} -C ${extractDir}`, { encoding: 'utf-8' });

    // npm pack extracts to a `package/` subdirectory
    const packageDir = join(extractDir, 'package');
    if (existsSync(join(packageDir, 'zbb.yaml'))) {
      return packageDir;
    }

    // Fallback: check if zbb.yaml is at root of extract
    if (existsSync(join(extractDir, 'zbb.yaml'))) {
      return extractDir;
    }

    throw new Error(
      `Package '${spec}' was downloaded but contains no zbb.yaml. ` +
      `Ensure the package includes zbb.yaml in its "files" array.`,
    );
  }

  /**
   * Check if a stack name matches a built-in stack shipped with zbb.
   * Built-in stacks live at packages/zbb/stacks/<name>/.
   */
  private getBuiltinStackPath(name: string): string | null {
    const thisDir = dirname(fileURLToPath(import.meta.url));
    // From dist/stack/ → ../../stacks/<name> (reaches packages/zbb/stacks/)
    const builtinDir = join(thisDir, '..', '..', 'stacks', name);
    if (existsSync(join(builtinDir, 'zbb.yaml'))) return builtinDir;
    return null;
  }

  private parseTarget(target: string): { stackName: string; substack?: string } {
    const parts = target.split(':');
    return { stackName: parts[0], substack: parts[1] };
  }

  private extractShortName(fullName: string): string {
    // "@zerobias-com/dana" → "dana"
    const parts = fullName.split('/');
    return parts[parts.length - 1];
  }

  /**
   * Resolve dependencies: check slot for existing stacks, auto-resolve missing ones.
   * Resolution order: slot → built-in → npm registry.
   * Recurses for transitive deps (like npm install).
   */
  private async resolveDeps(manifest: StackManifest): Promise<void> {
    if (!manifest.depends) return;

    for (const [depName, depSpec] of Object.entries(manifest.depends)) {
      const depPath = join(this.stacksDir, depName);
      if (existsSync(depPath)) {
        // Already in slot — TODO: bounds checking (version, exports)
        continue;
      }

      // Not in slot — try built-in first, then npm
      const builtinPath = this.getBuiltinStackPath(depName);
      if (builtinPath) {
        console.log(`  Dependency '${depName}' not in slot — using built-in stack`);
        try {
          await this.add(builtinPath);
          continue;
        } catch (err: unknown) {
          throw new Error(`Failed to add built-in stack '${depName}': ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      // Not built-in — pull from npm
      const spec = typeof depSpec === 'string' ? depSpec : depSpec.package;
      console.log(`  Dependency '${depName}' not in slot — pulling ${spec}...`);

      try {
        await this.add(spec);
      } catch (err: unknown) {
        throw new Error(
          `Failed to auto-resolve dependency '${depName}' (${spec}): ${err instanceof Error ? err.message : String(err)}\n` +
          `You can add it manually: zbb stack add <path-to-${depName}>`,
        );
      }
    }
  }

  private async validateImports(imports: ImportSpec[], manifest: StackManifest): Promise<void> {
    // Check for bare import collisions (two deps export same name, both imported bare)
    const bareImports = new Map<string, string>(); // varName → fromStack
    for (const imp of imports) {
      if (!imp.alias) {
        if (bareImports.has(imp.varName)) {
          throw new Error(
            `Import collision: '${imp.varName}' is imported from both ` +
            `'${bareImports.get(imp.varName)}' and '${imp.fromStack}'. ` +
            `Alias one: ${imp.varName} as MY_${imp.varName}`,
          );
        }
        bareImports.set(imp.varName, imp.fromStack);
      }
    }

    // Validate that imported vars exist in dependency exports
    for (const imp of imports) {
      const depStackYaml = join(this.stacksDir, imp.fromStack, 'stack.yaml');
      if (!existsSync(depStackYaml)) continue;

      const depIdentity = await loadYamlOrDefault<StackIdentity | null>(depStackYaml, null);
      if (!depIdentity?.source) continue;

      const depManifest = await loadStackManifest(depIdentity.source);
      if (!depManifest?.exports) continue;

      if (!depManifest.exports.includes(imp.varName)) {
        throw new Error(
          `Stack '${this.extractShortName(manifest.name)}' imports '${imp.varName}' from '${imp.fromStack}', ` +
          `but '${imp.fromStack}' doesn't export it. Exports: ${depManifest.exports.join(', ')}`,
        );
      }
    }
  }

  private async allocatePorts(manifest: StackManifest): Promise<Map<string, number>> {
    const ports = new Map<string, number>();
    if (!manifest.env) return ports;

    const portVars = Object.entries(manifest.env)
      .filter(([_, decl]) => decl.type === 'port');

    if (portVars.length === 0) return ports;

    // Collect existing port allocations across all stacks
    const existingPorts = await this.collectExistingPorts();
    const portRange = this.slot.meta.portRange;
    if (!portRange) {
      throw new Error('Slot has no port range allocated');
    }

    let nextPort = portRange[0];
    for (const [name] of portVars) {
      while (nextPort <= portRange[1]) {
        if (existingPorts.has(nextPort) || !(await isPortAvailable(nextPort))) {
          nextPort += 1;
          continue;
        }
        break;
      }
      if (nextPort > portRange[1]) {
        throw new Error(
          `Port range exhausted [${portRange[0]}-${portRange[1]}]. ` +
          `Need port for ${name} but all ports are allocated.`,
        );
      }
      ports.set(name, nextPort);
      existingPorts.add(nextPort);
      nextPort += 1;
    }

    return ports;
  }

  private async collectExistingPorts(): Promise<Set<number>> {
    const used = new Set<number>();
    if (!existsSync(this.stacksDir)) return used;

    const entries = await readdir(this.stacksDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const envPath = join(this.stacksDir, entry.name, '.env');
      if (!existsSync(envPath)) continue;

      const manifestPath = join(this.stacksDir, entry.name, 'manifest.yaml');
      const manifest = await loadYamlOrDefault<Record<string, Record<string, unknown>>>(manifestPath, {});
      for (const [_, meta] of Object.entries(manifest)) {
        if (meta?.type === 'port' && meta?.value) {
          used.add(parseInt(String(meta.value), 10));
        }
      }
    }

    return used;
  }

  private async generateSecrets(manifest: StackManifest, stackName: string): Promise<Map<string, string>> {
    const secrets = new Map<string, string>();
    if (!manifest.env) return secrets;

    // Check for cached secrets from a previous add (stable across re-adds)
    const cached = await this.loadCachedSecrets(stackName);

    for (const [name, decl] of Object.entries(manifest.env)) {
      if (decl.type === 'secret' && decl.generate) {
        if (cached.has(name)) {
          secrets.set(name, cached.get(name)!);
        } else {
          secrets.set(name, generateSecret(decl.generate, secrets));
        }
      }
    }

    return secrets;
  }

  private async allocatePortsCached(manifest: StackManifest, stackName: string): Promise<Map<string, number>> {
    const ports = new Map<string, number>();
    if (!manifest.env) return ports;

    const portVars = Object.entries(manifest.env).filter(([_, decl]) => decl.type === 'port');
    if (portVars.length === 0) return ports;

    // Check for cached port allocations from a previous add
    const cached = await this.loadCachedSecrets(stackName);
    const allCached = portVars.every(([name]) => cached.has(name));

    if (allCached) {
      // Verify cached ports don't collide with other stacks AND are available on host
      const existingPorts = await this.collectExistingPorts();
      let allAvailable = true;
      for (const [name] of portVars) {
        const port = parseInt(cached.get(name)!, 10);
        if (existingPorts.has(port) || !(await isPortAvailable(port))) {
          allAvailable = false;
          break;
        }
      }
      if (allAvailable) {
        for (const [name] of portVars) {
          ports.set(name, parseInt(cached.get(name)!, 10));
        }
        return ports;
      }
      // Cached ports stale — fall through to fresh allocation
    }

    // Fresh allocation (with host port availability checks)
    return this.allocatePorts(manifest);
  }

  /**
   * Rebuild the slot-level .env as a merged projection of all stacks.
   * This keeps legacy consumers (node-lib Slot, hub-cli) working — they read
   * the flat slot .env, not per-stack .env files.
   *
   * Merge order: slot vars first, then each stack's EXPORTED vars (topo-sorted).
   * Later stacks override earlier ones (so hub's SERVER_URL overrides dana's if both export it).
   */
  async syncSlotEnv(): Promise<void> {
    const { writeFile } = await import('node:fs/promises');

    const merged = new Map<string, string>();

    // 1. Slot-level vars always present
    const slotVars = this.slot.getSlotEnvVars();
    for (const [k, v] of Object.entries(slotVars)) {
      merged.set(k, v);
    }

    // 2. Load all stacks in topo-sorted order (deps first)
    const stacks = await this.list();
    if (stacks.length === 0) {
      // No stacks — write just slot vars
      await this.writeSlotEnv(merged);
      return;
    }

    // Topo-sort stacks by dependencies
    interface DepNode { name: string; deps: string[] }
    const nodes: DepNode[] = stacks.map(s => ({
      name: s.name,
      deps: s.manifest.depends ? Object.keys(s.manifest.depends) : [],
    }));
    const { sorted } = toposort(nodes, n => n.name, n => n.deps);

    // 3. Merge each stack's vars (all vars from .env, not just exports)
    //    Exports control what consumers can IMPORT, but the merged .env
    //    needs all vars for tools like hub-cli that read SERVER_URL etc.
    for (const node of sorted) {
      const stack = stacks.find(s => s.name === node.name);
      if (!stack) continue;

      const envAll = stack.env.getAll();
      for (const [k, v] of Object.entries(envAll)) {
        // Skip slot-level vars (already set, don't override with stack copies)
        if (k.startsWith('ZB_SLOT') || k === 'ZB_STACKS_DIR' || k === 'STACK_NAME') continue;
        merged.set(k, v);
      }
    }

    await this.writeSlotEnv(merged);
  }

  private async writeSlotEnv(env: Map<string, string>): Promise<void> {
    const { writeFile } = await import('node:fs/promises');
    const lines: string[] = [];
    for (const key of [...env.keys()].sort()) {
      lines.push(`${key}=${env.get(key)}`);
    }
    await writeFile(join(this.slot.path, '.env'), lines.join('\n') + '\n', 'utf-8');
  }

  /**
   * Save secrets and ports from a stack's .env to the slot cache.
   * Used to restore stable values when a stack is re-added.
   */
  private async cacheStackSecrets(name: string, stack: Stack): Promise<void> {
    const cacheDir = join(this.slot.path, 'state', 'secrets');
    await mkdir(cacheDir, { recursive: true });

    const envAll = stack.env.getAll();
    const manifest = stack.env.getManifest();

    // Cache only secrets and ports — not derived/inherited/imported vars
    const toCache: Record<string, string> = {};
    for (const [key, entry] of Object.entries(manifest)) {
      if ((entry.type === 'secret' || entry.type === 'port') && envAll[key]) {
        toCache[key] = envAll[key];
      }
    }

    if (Object.keys(toCache).length > 0) {
      await saveYaml(join(cacheDir, `${name}.yaml`), toCache);
    }
  }

  /**
   * Load cached secrets/ports for a stack (from a previous add).
   */
  private async loadCachedSecrets(stackName: string): Promise<Map<string, string>> {
    const cachePath = join(this.slot.path, 'state', 'secrets', `${stackName}.yaml`);
    const data = await loadYamlOrDefault<Record<string, string>>(cachePath, {});
    return new Map(Object.entries(data));
  }
}

/**
 * Check if a port is available on the host by attempting to bind a TCP socket.
 * Returns true if the port is free, false if already in use.
 */
function isPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => {
      server.close(() => resolve(true));
    });
    server.listen(port, '0.0.0.0');
  });
}
