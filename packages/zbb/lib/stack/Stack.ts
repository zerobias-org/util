/**
 * A single stack instance within a slot.
 * Provides access to identity, env, state, and lifecycle execution.
 */

import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { loadYamlOrDefault, saveYaml } from '../yaml.js';
import type { StackManifest, StackIdentity, HealthCheckConfig } from '../config.js';
import { StackEnvironment } from './StackEnvironment.js';
import type { StackStatus } from './types.js';

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

    // Handle cleanup as array
    if (phase === 'cleanup' && Array.isArray(command)) {
      for (const cmd of command) {
        const code = await this.execCommand(String(cmd));
        if (code !== 0) return code;
      }
      return 0;
    }

    if (typeof command === 'string') {
      return this.execCommand(command);
    }

    // Structured command (e.g., health check)
    if (phase === 'health' && typeof command === 'object') {
      return this.runHealthCheck(command as HealthCheckConfig);
    }

    return this.execCommand(String(command));
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
   * Execute a command in the stack's context (public, for substack use).
   */
  execSubstackCommand(command: string): Promise<number> {
    return this.execCommand(command);
  }

  // ── Private ─────────────────────────────────────────────────

  private execCommandQuiet(command: string): Promise<number> {
    return new Promise((resolve) => {
      const cwd = this.identity.mode === 'dev' ? this.identity.source : this.path;
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
      const cwd = this.identity.mode === 'dev' ? this.identity.source : this.path;
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
