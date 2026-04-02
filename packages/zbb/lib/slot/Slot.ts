import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { SlotEnvironment } from './SlotEnvironment.js';
import { SlotWatcher } from './SlotWatcher.js';
import { loadYamlOrDefault, saveYaml } from '../yaml.js';
import { lookupDnsTxt as _lookupDnsTxt } from '../env/DnsTxtResolver.js';
import { refreshVaultVars, type RefreshResult } from './refresh.js';
import { StackManager } from '../stack/StackManager.js';

/** Default DNS cache TTL in seconds when not available from DNS response */
const DEFAULT_DNS_TTL = 30;

/** Schema for dns-cache.yml written to the slot directory */
interface DnsCache {
  prefix: string;
  queried_at: string;
  expires_at: string;
  ttl: number;
  values: Record<string, string>;
}

/**
 * Internal dependencies — overridable for testing.
 * @internal
 */
export const _deps = {
  lookupDnsTxt: _lookupDnsTxt,
};

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
  public env: SlotEnvironment;

  private _meta: SlotMeta | null = null;
  private _watcher: SlotWatcher | null = null;
  private _stacks: StackManager | null = null;
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
  get stacksDir() { return join(this.path, 'stacks'); }

  /** Whether this slot has any stacks */
  get hasStacks(): boolean {
    return existsSync(this.stacksDir);
  }

  /** Stack manager for this slot (lazy-initialized) */
  get stacks(): StackManager {
    if (!this._stacks) {
      this._stacks = new StackManager(this);
    }
    return this._stacks;
  }

  /** Env vars that expose slot directories */
  getSlotEnvVars(): Record<string, string> {
    return {
      ZB_SLOT: this.name,
      ZB_SLOT_DIR: this.path,
      ZB_SLOT_CONFIG: this.configDir,
      ZB_SLOT_LOGS: this.logsDir,
      ZB_SLOT_STATE: this.stateDir,
      ZB_SLOT_TMP: this.tmpDir,
      ZB_STACKS_DIR: this.stacksDir,
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

    // Propagate watcher events through the Slot with absolute paths
    for (const event of ['env:change', 'state:change', 'deployment:change', 'command:change']) {
      this._watcher.on(event, (relPath: string) => {
        this.emit(event, join(this.path, relPath));
      });
    }

    this._watcher.on('error', (error: Error) => {
      this.emit('error', error);
    });

    this._watcher.on('ready', () => {
      this.emit('watcher:ready');
    });
  }

  // ── DNS Provisioning ───────────────────────────────────────

  /**
   * Resolve external env var sources for this slot.
   *
   * Runs in order:
   *   1. DNS TXT provisioning (declared values, silent on failure)
   *   2. Vault secret resolution (overrides, refresh:true always re-fetched)
   *
   * @param repoRoot - Repo root path (needed for vault var scanning)
   * @returns Vault refresh result (DNS is silent)
   */
  async resolve(repoRoot?: string): Promise<RefreshResult> {
    // ── DNS TXT provisioning ──
    await this.resolveDns();

    // ── Vault secret resolution ──
    if (repoRoot) {
      return refreshVaultVars(this, repoRoot);
    }
    return { refreshed: [], errors: [] };
  }

  /**
   * DNS TXT provisioning — queries `_hub.<searchDomain>` for KEY=value pairs.
   * Silent on failure. Uses disk-based TTL cache.
   */
  private async resolveDns(): Promise<void> {
    const cachePath = join(this.path, 'dns-cache.yml');

    // Check TTL cache — if valid, skip
    const cache = await loadYamlOrDefault<DnsCache | null>(cachePath, null);
    if (cache && cache.expires_at) {
      if (Date.now() < new Date(cache.expires_at).getTime()) {
        return;
      }
    }

    const resolveHost = this.env.get('SLOT_RESOLVE_HOST');
    if (!resolveHost) return;

    let dnsValues: Record<string, string> | undefined;
    try {
      dnsValues = await _deps.lookupDnsTxt(resolveHost);
    } catch {
      return;
    }

    if (!dnsValues || Object.keys(dnsValues).length === 0) return;

    for (const [key, value] of Object.entries(dnsValues)) {
      await this.env.setDeclared(key, value, 'dns');
    }

    const now = Date.now();
    const ttl = DEFAULT_DNS_TTL;
    await saveYaml(cachePath, {
      prefix: resolveHost,
      queried_at: new Date(now).toISOString(),
      expires_at: new Date(now + ttl * 1000).toISOString(),
      ttl,
      values: dnsValues,
    } satisfies DnsCache);
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
