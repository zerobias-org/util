import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { SlotEnvironment } from './SlotEnvironment.ts';
import { loadYamlOrDefault } from '../yaml.ts';

export interface SlotMeta {
  name: string;
  created: string;
  ephemeral?: boolean;
  ttl?: number;
  expires?: string;
  portRange?: [number, number];
}

/**
 * A loaded slot instance. Provides access to env, manifest, and slot metadata.
 */
export class Slot {
  public readonly name: string;
  public readonly path: string;
  public readonly env: SlotEnvironment;
  private _meta: SlotMeta | null = null;

  constructor(name: string, slotsDir: string) {
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
  }

  get meta(): SlotMeta {
    if (!this._meta) throw new Error(`Slot '${this.name}' not loaded. Call load() first.`);
    return this._meta;
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

  /** Slot directory sub-paths */
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
}
