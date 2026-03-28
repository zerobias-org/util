import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { SlotEnvironment } from './SlotEnvironment.js';
import { SlotWatcher } from './SlotWatcher.js';
import { loadYamlOrDefault, saveYaml } from '../yaml.js';
import { lookupDnsTxt as _lookupDnsTxt } from '../env/DnsTxtResolver.js';

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
   * Resolve DNS TXT provisioning records for this slot.
   *
   * Queries `_hub.<searchDomain>` TXT records and merges any KEY=value pairs
   * into the slot environment as defaults. User-set values (source: "user" or
   * "override") are never overwritten.
   *
   * Uses a disk-based TTL cache at `{slot.path}/dns-cache.yml` to avoid
   * redundant DNS queries. TTL defaults to 30 seconds.
   *
   * Never throws — DNS failures (timeout, NXDOMAIN) are silent no-ops.
   *
   * PROV-01: queries DNS and sets values with source "dns"
   * PROV-02: respects TTL cache on disk
   * PROV-03: never overwrites user/override values
   * PROV-04: idempotent across multiple calls with same DNS data
   * PROV-05: DNS failure is a silent no-op
   */
  async resolve(): Promise<void> {
    const cachePath = join(this.path, 'dns-cache.yml');

    // Check TTL cache — if valid, return immediately (PROV-02)
    const cache = await loadYamlOrDefault<DnsCache | null>(cachePath, null);
    if (cache && cache.expires_at) {
      if (Date.now() < new Date(cache.expires_at).getTime()) {
        return; // Cache is still valid
      }
    }

    // Query DNS — wrapped in try/catch for PROV-05
    let dnsValues: Record<string, string> | undefined;
    try {
      dnsValues = await _deps.lookupDnsTxt('_hub');
    } catch {
      return; // DNS failure is a silent no-op (PROV-05)
    }

    if (!dnsValues || Object.keys(dnsValues).length === 0) {
      return; // No DNS records, nothing to merge
    }

    // Merge DNS values into slot env, respecting source priority (PROV-03)
    for (const [key, value] of Object.entries(dnsValues)) {
      await this.env.setDeclared(key, value, 'dns');
    }

    // Write TTL cache to disk (PROV-02)
    const now = Date.now();
    const ttl = DEFAULT_DNS_TTL;
    const newCache: DnsCache = {
      prefix: '_hub',
      queried_at: new Date(now).toISOString(),
      expires_at: new Date(now + ttl * 1000).toISOString(),
      ttl,
      values: dnsValues,
    };
    await saveYaml(cachePath, newCache);
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
