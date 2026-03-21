import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { SlotEnvironment } from './SlotEnvironment.ts';
import { SlotWatcher } from './SlotWatcher.ts';
import { loadYamlOrDefault } from '../yaml.ts';

export interface SlotMeta {
  name: string;
  created: string;
  ephemeral?: boolean;
  ttl?: number;
  expires?: string;
  portRange?: [number, number];
  [key: string]: any;
}

/**
 * A loaded slot instance. Provides access to env, manifest, slot metadata,
 * file watching, and event propagation.
 *
 * Extends EventEmitter — emits:
 *   'env:change'        — env file modified
 *   'state:change'      — state file modified
 *   'deployment:change'  — deployment file modified (with filePath)
 *   'command:change'     — command file modified (with filePath)
 *   'ready'             — slot fully initialized
 *   'error'             — watcher error
 */
export class Slot extends EventEmitter {
  public readonly name: string;
  public readonly path: string;
  public readonly env: SlotEnvironment;

  private _meta: SlotMeta | null = null;
  private _watcher: SlotWatcher | null = null;
  private _initialized = false;

  constructor(name: string, slotsDir: string) {
    super();
    this.name = name;
    this.path = join(slotsDir, name);
    this.env = new SlotEnvironment(this.path);
  }

  /** Load slot metadata and environment from disk. */
  async load(): Promise<void> {
    this._meta = await loadYamlOrDefault<SlotMeta>(
      join(this.path, 'slot.yaml'),
      { name: this.name, created: new Date().toISOString() },
    );
    await this.env.load();
    this._initialized = true;
    this.emit('ready');
  }

  /** Slot config/metadata */
  get meta(): SlotMeta {
    if (!this._meta) throw new Error(`Slot '${this.name}' not loaded. Call load() first.`);
    return this._meta;
  }

  /** Alias for meta — backward compat */
  get config(): SlotMeta {
    return this.meta;
  }

  /** Check if slot has been loaded */
  isInitialized(): boolean {
    return this._initialized;
  }

  exists(): boolean {
    return existsSync(this.path);
  }

  isEphemeral(): boolean {
    return this._meta?.ephemeral ?? false;
  }

  isExpired(): boolean {
    if (!this._meta?.expires) return false;
    return new Date(this._meta.expires) < new Date();
  }

  // ── Directory paths ────────────────────────────────────────

  get configDir() { return join(this.path, 'config'); }
  get logsDir() { return join(this.path, 'logs'); }
  get stateDir() { return join(this.path, 'state'); }
  get tmpDir() { return join(this.path, 'state', 'tmp'); }

  /** Env vars that expose slot directories */
  getSlotEnvVars(): Record<string, string> {
    return {
      ZB_SLOT: this.name,
      ZB_SLOT_DIR: this.path,
      ZB_SLOT_CONFIG: this.configDir,
      ZB_SLOT_LOGS: this.logsDir,
      ZB_SLOT_STATE: this.stateDir,
      ZB_SLOT_TMP: this.tmpDir,
      STACK_NAME: this.name,
    };
  }

  // ── Watchers ───────────────────────────────────────────────

  /** Start file watching on the slot directory */
  enableWatchers(): void {
    if (this._watcher) return;
    this._watcher = new SlotWatcher(this.path, this.name);
    this._wireWatcherEvents();
    this._watcher.start();
  }

  /** Get the watcher (if enabled) */
  get watcher(): SlotWatcher | null {
    return this._watcher;
  }

  /** Wire watcher events through the Slot EventEmitter */
  private _wireWatcherEvents(): void {
    if (!this._watcher) return;

    // Propagate all watcher events through the Slot
    for (const event of ['env:change', 'state:change', 'deployment:change', 'command:change']) {
      this._watcher.on(event, (...args: any[]) => {
        this.emit(event, ...args);
      });
    }

    this._watcher.on('error', (error: Error) => {
      this.emit('error', error);
    });

    this._watcher.on('ready', () => {
      this.emit('watcher:ready');
    });
  }

  // ── Lifecycle ──────────────────────────────────────────────

  /** Close slot — stop watchers, remove listeners */
  async close(): Promise<void> {
    if (this._watcher) {
      await this._watcher.close();
      this._watcher = null;
    }
    this.removeAllListeners();
    this._initialized = false;
  }

  /** Alias for close */
  async shutdown(): Promise<void> {
    return this.close();
  }
}
