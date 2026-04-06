/**
 * A single stack instance within a slot.
 * Provides access to identity, env, state, and lifecycle execution.
 */

import { join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, writeFile, rename, readdir, rm, copyFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { loadYamlOrDefault, saveYaml } from '../yaml.js';
import type { StackManifest, StackIdentity, HealthCheckConfig } from '../config.js';
import { StackEnvironment } from './StackEnvironment.js';
import type { StackStatus } from './types.js';

/**
 * Produce a canonical JSON string that is identical regardless of object key insertion order.
 * Recursively sorts all object keys, preserves array order.
 */
function stableStringify(obj: unknown): string {
  if (obj === null || obj === undefined) return JSON.stringify(obj);
  if (Array.isArray(obj)) return '[' + obj.map(stableStringify).join(',') + ']';
  if (typeof obj === 'object') {
    const sorted = Object.keys(obj as Record<string, unknown>).sort();
    return '{' + sorted.map(k => JSON.stringify(k) + ':' + stableStringify((obj as Record<string, unknown>)[k])).join(',') + '}';
  }
  return JSON.stringify(obj);
}

interface NpmrcSwap {
  files: Array<{ path: string; backup: string }>;
  registryUrl?: string;
}

/**
 * Represents one stack instance in a slot.
 */
export class Stack extends EventEmitter {
  public readonly name: string;
  public readonly path: string;
  public identity!: StackIdentity;
  public env: StackEnvironment;
  public manifest!: StackManifest;

  private _initialized = false;

  constructor(name: string, stacksDir: string) {
    super();
    this.name = name;
    this.path = join(stacksDir, name);
    this.env = new StackEnvironment(this.path);
  }

  // ── Directory paths ─────────────────────────────────────────

  get stateFile() { return join(this.path, 'state.yaml'); }
  get logsDir() { return join(this.path, 'logs'); }
  get secretsDir() { return join(this.path, 'state', 'secrets'); }
  get stackYamlPath() { return join(this.path, 'stack.yaml'); }

  /**
   * Returns the path to a substack directory within this stack.
   * Does not check whether the directory exists.
   */
  substackDir(name: string): string {
    return join(this.path, 'substacks', name);
  }

  // ── Loading ─────────────────────────────────────────────────

  async load(): Promise<void> {
    this.identity = await loadYamlOrDefault<StackIdentity>(
      this.stackYamlPath,
      { name: this.name, version: '0.0.0', mode: 'dev', source: '', added: '' },
    );

    // Load manifest from source zbb.yaml (both dev and packaged modes)
    if (this.identity.source) {
      const { loadStackManifest } = await import('../config.js');
      this.manifest = await loadStackManifest(this.identity.source) ?? {
        name: this.name,
        version: this.identity.version,
      };
    } else {
      this.manifest = { name: this.name, version: this.identity.version };
    }

    await this.env.load();
    this._initialized = true;
    this.emit('ready');
  }

  async close(): Promise<void> {
    this.removeAllListeners();
    this._initialized = false;
  }

  isInitialized(): boolean {
    return this._initialized;
  }

  exists(): boolean {
    return existsSync(this.path);
  }

  // ── State ───────────────────────────────────────────────────

  async getState(): Promise<Record<string, unknown>> {
    return loadYamlOrDefault<Record<string, unknown>>(this.stateFile, {});
  }

  async setState(partial: Record<string, unknown>): Promise<void> {
    const current = await this.getState();
    const merged = { ...current, ...partial };
    if (stableStringify(merged) === stableStringify(current)) return;
    await saveYaml(this.stateFile, merged);
    this.emit('state:change', merged);
  }

  /**
   * Evaluate ready_when conditions against current state.
   * Returns true if all conditions are met (or no conditions defined).
   */
  async isReady(): Promise<boolean> {
    const depSpec = this.manifest.depends;
    if (!depSpec) return true;

    const state = await this.getState();
    // Check the stack's own status
    if (state.status === 'healthy') return true;
    if (state.status === 'error') return false;
    return state.status === undefined; // no state = assume ready (no lifecycle)
  }

  /**
   * Check ready_when conditions for a specific dependency.
   */
  async checkReadyWhen(conditions: Record<string, unknown>): Promise<boolean> {
    const state = await this.getState();
    for (const [key, expected] of Object.entries(conditions)) {
      if (state[key] !== expected) return false;
    }
    return true;
  }

  // ── Lifecycle ───────────────────────────────────────────────

  /**
   * Run a lifecycle command (build, test, gate, start, stop, seed, cleanup).
   * Returns the exit code.
   */
  async runLifecycle(phase: string): Promise<number> {
    const lifecycle = this.manifest.lifecycle;
    if (!lifecycle) {
      console.log(`  Stack '${this.name}' has no lifecycle commands defined`);
      return 0;
    }

    const command = (lifecycle as Record<string, unknown>)[phase];
    if (!command) {
      console.log(`  Stack '${this.name}' has no '${phase}' command`);
      return 0;
    }

    // For build phase: inject registry .npmrc if registry stack is running
    let npmrcSwap: NpmrcSwap | null = null;
    if (phase === 'build') {
      npmrcSwap = await this.injectRegistryNpmrc();
    }

    try {
      // Handle cleanup as array
      if (phase === 'cleanup' && Array.isArray(command)) {
        for (const cmd of command) {
          const code = await this.execCommand(String(cmd));
          if (code !== 0) return code;
        }
        return 0;
      }

      if (typeof command === 'string') {
        // Must await so finally runs AFTER the command completes
        const code = await this.execCommand(command);
        return code;
      }

      // Structured command (e.g., health check)
      if (phase === 'health' && typeof command === 'object') {
        const code = await this.runHealthCheck(command as HealthCheckConfig);
        return code;
      }

      const code = await this.execCommand(String(command));
      return code;
    } finally {
      if (npmrcSwap) {
        await this.restoreNpmrc(npmrcSwap);
      }
    }
  }

  /**
   * Run a lifecycle command silently (no stdout/stderr, no health polling logs).
   * Used for quick liveness checks without cluttering output.
   */
  async runLifecycleQuiet(phase: string): Promise<number> {
    const lifecycle = this.manifest.lifecycle;
    if (!lifecycle) return 0;

    const command = (lifecycle as Record<string, unknown>)[phase];
    if (!command) return 0;

    if (phase === 'health' && typeof command === 'object') {
      // Single-shot health check — no polling, just one attempt
      const config = command as HealthCheckConfig;
      return this.execCommandQuiet(config.command);
    }

    if (typeof command === 'string') {
      return this.execCommandQuiet(command);
    }

    return this.execCommandQuiet(String(command));
  }

  /**
   * Run health check with polling.
   */
  async runHealthCheck(config: HealthCheckConfig): Promise<number> {
    const interval = (config.interval ?? 2) * 1000;
    const timeout = (config.timeout ?? 120) * 1000;
    const startTime = Date.now();
    let attempts = 0;

    console.log(`  Waiting for ${this.name} health (${timeout / 1000}s timeout)...`);

    while (Date.now() - startTime < timeout) {
      attempts += 1;
      const code = await this.execCommand(config.command);
      if (code === 0) {
        await this.setState({ status: 'healthy' });
        console.log(`  ${this.name} healthy (${attempts} attempt${attempts > 1 ? 's' : ''}).`);
        return 0;
      }
      await new Promise(r => setTimeout(r, interval));
    }

    console.error(`  ${this.name} health check timed out after ${timeout / 1000}s (${attempts} attempts)`);
    await this.setState({ status: 'error' });
    return 1;
  }

  // ── Status ──────────────────────────────────────────────────

  async getStatus(): Promise<StackStatus> {
    const state = await this.getState();
    const ports: Record<string, number> = {};
    const envAll = this.env.getAll();

    // Collect port vars
    for (const [key, entry] of Object.entries(this.env.getManifest())) {
      if (entry.type === 'port' && envAll[key]) {
        ports[key] = parseInt(envAll[key], 10);
      }
    }

    // Collect dependency names
    const deps = this.manifest.depends ? Object.keys(this.manifest.depends) : [];

    return {
      name: this.name,
      version: this.identity.version,
      mode: this.identity.mode,
      status: (state.status as string) ?? 'unknown',
      ports,
      deps,
    };
  }

  // ── Directory setup ─────────────────────────────────────────

  /**
   * Create the stack directory tree within a slot.
   */
  static async createDirectories(stackPath: string): Promise<void> {
    await mkdir(stackPath, { recursive: true });
    await mkdir(join(stackPath, 'logs'), { recursive: true });
    await mkdir(join(stackPath, 'state'), { recursive: true });
    await mkdir(join(stackPath, 'state', 'secrets'), { recursive: true });
  }

  /**
   * Create substack directories for substacks that declare a state field.
   * Both object substacks and collection substacks get an empty directory.
   * Substacks without a state declaration are skipped.
   * Called during stack add; state.yaml is created on first setState() call.
   */
  static async createSubstackDirectories(
    stackPath: string,
    manifest: StackManifest,
  ): Promise<void> {
    if (!manifest.substacks) return;
    for (const [name, config] of Object.entries(manifest.substacks)) {
      if (!config.state) continue;
      const substackDir = join(stackPath, 'substacks', name);
      await mkdir(substackDir, { recursive: true });
    }
  }

  /**
   * Execute a command in the stack's context (public, for substack use).
   */
  execSubstackCommand(command: string): Promise<number> {
    return this.execCommand(command);
  }

  // ── Registry .npmrc injection ───────────────────────────────

  /**
   * If the registry stack is running, swap all .npmrc files in the stack's
   * source tree with versions pointing at the local Verdaccio registry.
   * This ensures `npm install` during Docker builds uses locally published packages.
   * Returns swap info for restoration, or null if registry is not active.
   */
  private async injectRegistryNpmrc(): Promise<NpmrcSwap | null> {
    console.log('  [registry] Checking for local packages to inject...');
    // Check if registry stack exists and is healthy
    const stacksDir = join(this.path, '..');
    const registryEnvPath = join(stacksDir, 'registry', '.env');
    const registryStatePath = join(stacksDir, 'registry', 'state.yaml');

    if (!existsSync(registryEnvPath) || !existsSync(registryStatePath)) return null;

    const { loadYamlOrDefault } = await import('../yaml.js');
    const state = await loadYamlOrDefault<Record<string, unknown>>(registryStatePath, {});
    if (state.status !== 'healthy') return null;

    // Get registry URL
    const registryEnv = readFileSync(registryEnvPath, 'utf-8');
    let registryUrl = '';
    let registryPort = '';
    for (const line of registryEnv.split('\n')) {
      const urlMatch = line.match(/^REGISTRY_URL=(.+)$/);
      if (urlMatch) registryUrl = urlMatch[1];
      const portMatch = line.match(/^REGISTRY_PORT=(.+)$/);
      if (portMatch) registryPort = portMatch[1];
    }
    if (!registryUrl) return null;

    // Read the publish manifest to know which packages were locally published
    const publishManifestPath = join(stacksDir, 'registry', 'publishes.json');
    let publishes: Array<{ name: string; version: string }> = [];
    if (existsSync(publishManifestPath)) {
      try {
        publishes = JSON.parse(readFileSync(publishManifestPath, 'utf-8'));
      } catch { /* ignore */ }
    }

    if (publishes.length === 0) return null; // Nothing locally published — no injection needed

    const sourcePath = this.identity.source || this.path;
    const swappedFiles: Array<{ path: string; backup: string }> = [];

    // Back up package-lock.json — npm install (via Gradle workspaceInstall) will
    // rewrite resolved URLs to point at localhost (Verdaccio). Restore after build
    // to prevent accidentally committing localhost URLs that break CI.
    const lockfilePath = join(sourcePath, 'package-lock.json');
    const lockfileBackup = join(sourcePath, 'package-lock.json.zbb-backup');
    if (existsSync(lockfilePath)) {
      await copyFile(lockfilePath, lockfileBackup);
      swappedFiles.push({ path: lockfilePath, backup: lockfileBackup });
    }

    // Download tarballs of locally-published packages from Verdaccio.
    // These are passed to Gradle via ZBB_LOCAL_DEPS env var so the injectLocalDeps
    // task can copy them into the Docker context AFTER prepareDockerContext runs.
    const localDepsDir = join(sourcePath, '.zbb-local-deps');
    await mkdir(localDepsDir, { recursive: true });

    const localDeps: Array<{ name: string; version: string; tarball: string }> = [];
    const { execSync } = await import('node:child_process');
    for (const pkg of publishes) {
      const shortName = pkg.name.split('/').pop()!;
      const tarballName = `${shortName}-${pkg.version}.tgz`;
      const tarballPath = join(localDepsDir, tarballName);

      try {
        execSync(
          `curl -sf "${registryUrl}/${pkg.name}/-/${shortName}-${pkg.version}.tgz" -o "${tarballPath}"`,
          { stdio: 'pipe' },
        );
        localDeps.push({ name: pkg.name, version: pkg.version, tarball: tarballPath });
        console.log(`  [registry] Downloaded ${pkg.name}@${pkg.version} from Verdaccio`);
      } catch {
        console.log(`  [registry] Warning: could not download ${pkg.name}@${pkg.version} from Verdaccio`);
      }
    }

    // Write manifest file for Gradle's injectLocalDeps task to pick up
    if (localDeps.length > 0) {
      await writeFile(join(localDepsDir, 'manifest.json'), JSON.stringify(localDeps, null, 2));
    }

    // Taint host node_modules so workspaceInstall re-fetches from Verdaccio.
    // With the project .npmrc swapped to point at Verdaccio, npm install will
    // pull the locally published version. Then npm pack includes it naturally,
    // and the Docker build gets it without needing Gradle-side injection.
    let tainted = false;
    for (const pkg of publishes) {
      const modDir = join(sourcePath, 'node_modules', pkg.name);
      if (existsSync(modDir)) {
        await rm(modDir, { recursive: true, force: true });
        console.log(`  [registry] Tainted ${pkg.name} in node_modules (will reinstall from Verdaccio)`);
        tainted = true;
      }
    }

    // Invalidate Gradle build stamps so npm pack and docker build re-run.
    // Without this, Gradle thinks outputs are up-to-date and skips re-packing.
    if (tainted) {
      const glob = await import('node:fs/promises');
      const appDirs = await readdir(sourcePath, { withFileTypes: true });
      for (const entry of appDirs) {
        if (!entry.isDirectory()) continue;
        const buildDir = join(sourcePath, entry.name, 'build');
        if (!existsSync(buildDir)) continue;
        for (const stamp of ['npm-pack.stamp', 'docker-image.stamp']) {
          const stampPath = join(buildDir, stamp);
          if (existsSync(stampPath)) {
            await rm(stampPath);
            console.log(`  [registry] Invalidated ${entry.name}/build/${stamp}`);
          }
        }
      }
    }

    if (swappedFiles.length > 0) {
      console.log(`  [registry] Injected local registry into ${swappedFiles.length} .npmrc file(s)`);
    }

    return { files: swappedFiles };
  }

  private async restoreNpmrc(swap: NpmrcSwap): Promise<void> {
    for (const { path: filePath, backup } of swap.files) {
      try {
        await rename(backup, filePath);
      } catch { /* ignore */ }
    }
    // Clean up downloaded tarballs
    const localDepsDir = join(this.identity.source || this.path, '.zbb-local-deps');
    if (existsSync(localDepsDir)) {
      try { await rm(localDepsDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
    if (swap.files.length > 0) {
      console.log(`  [registry] Restored ${swap.files.length} .npmrc file(s)`);
    }
  }

  // ── Private ─────────────────────────────────────────────────

  private execCommandQuiet(command: string): Promise<number> {
    return new Promise((resolve) => {
      const cwd = this.identity.source || this.path;
      const envVars = { ...process.env, ...this.env.getAll() };

      const child = spawn('bash', ['-c', command], {
        cwd,
        env: envVars,
        stdio: ['ignore', 'ignore', 'ignore'],
        detached: false,
      });

      child.on('exit', (code) => {
        resolve(code ?? 1);
      });
    });
  }

  private execCommand(command: string): Promise<number> {
    return new Promise((resolve) => {
      const cwd = this.identity.source || this.path;
      const envVars = { ...process.env, ...this.env.getAll() };

      const child = spawn('bash', ['-c', command], {
        cwd,
        env: envVars,
        stdio: ['inherit', 'inherit', 'inherit'],
        detached: false,
      });

      child.on('exit', (code) => {
        resolve(code ?? 1);
      });
    });
  }
}
