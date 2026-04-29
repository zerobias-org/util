import { mkdir, readdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { Slot, type SlotMeta } from './Slot.js';
import { SlotEnvironment, type ManifestEntry } from './SlotEnvironment.js';
import { allocateSlotPortRange, validatePortRange } from './PortAllocator.js';
import { saveYaml, loadYamlOrDefault } from '../yaml.js';
import {
  findRepoRoot,
  getSlotsDir,
  loadUserConfig,
  type UserConfig,
} from '../config.js';

export interface CreateOptions {
  ephemeral?: boolean;
  ttl?: number;
  repoRoot?: string;
  portRange?: [number, number];
  /**
   * CI mode: snapshot process.env as the source-of-truth for ALL declared
   * vars (not just `source: env` ones). Vault-injected secrets exported by
   * `hashicorp/vault-action` are picked up directly without re-fetching from
   * Vault. Auto-detected from `CI=true` env var when not set explicitly.
   */
  ci?: boolean;
}

export class SlotManager {
  /**
   * Create a new slot.
   *
   * Phase 3 model: slot create is a pure infrastructure step. It creates
   * the directory structure, writes slot-framework env vars (ZB_SLOT,
   * ZB_SLOT_DIR, etc.), allocates a port range, and writes metadata.
   *
   * All application-level env processing (ports, secrets, derived vars,
   * ${VAR} resolution) happens later during `stack add`, when the stack
   * manifest is read and the stack short name is known.
   *
   * In CI mode, process.env is dumped to an inherited.env file so that
   * vault-action secrets are available when `stack add` runs.
   */
  static async create(name: string, options: CreateOptions = {}): Promise<Slot> {
    // Validate name
    if (!name && !options.ephemeral) {
      throw new Error('Slot name is required');
    }
    if (!name && options.ephemeral) {
      name = `e2e-${randomBytes(3).toString('hex')}`;
    }
    if (!/^[\w-]+$/.test(name)) {
      throw new Error(`Invalid slot name: ${name}`);
    }

    const userConfig = await loadUserConfig();
    const slotsDir = getSlotsDir(userConfig);
    const slotDir = join(slotsDir, name);

    if (existsSync(slotDir)) {
      throw new Error(`Slot '${name}' already exists at ${slotDir}`);
    }

    // 1. Allocate a non-overlapping port range for this slot
    const existingSlots = await SlotManager.list();
    const portRange = options.portRange ?? allocateSlotPortRange(existingSlots);
    validatePortRange(portRange, existingSlots);

    // 2. Create slot directories
    await mkdir(slotDir, { recursive: true });
    await mkdir(join(slotDir, 'config'), { recursive: true });
    await mkdir(join(slotDir, 'logs'), { recursive: true });
    await mkdir(join(slotDir, 'state'), { recursive: true });
    await mkdir(join(slotDir, 'state', 'tmp'), { recursive: true });
    await mkdir(join(slotDir, 'stacks'), { recursive: true });

    // 3. Build slot-framework env vars — these are ALWAYS present in any
    //    slot, regardless of what stack is loaded.
    const slot = new Slot(name, slotsDir);
    const slotVars = slot.getSlotEnvVars();

    const env = new Map<string, string>();
    const manifest = new Map<string, ManifestEntry>();
    for (const [k, v] of Object.entries(slotVars)) {
      env.set(k, v);
      manifest.set(k, { source: 'zbb', type: 'slot' });
    }

    // 4. Write .env (slot-framework vars only) and manifest.yaml
    //    CI-mode env inheritance is handled by `stack add` (StackEnvironment
    //    .initialize) which reads process.env for all declared vars when
    //    CI=true. No inherited.env file needed — the bootstrap step runs
    //    both `slot create` and `stack add` in the same CI step, so
    //    process.env is identical for both.
    await SlotEnvironment.writeDeclaredEnv(slotDir, env, manifest);

    // 6. Write slot.yaml metadata
    const meta: SlotMeta = {
      name,
      created: new Date().toISOString(),
      portRange,
    };
    if (options.ephemeral) {
      const ttl = options.ttl ?? 7200; // default 2 hours
      meta.ephemeral = true;
      meta.ttl = ttl;
      meta.expires = new Date(Date.now() + ttl * 1000).toISOString();
    }
    await saveYaml(join(slotDir, 'slot.yaml'), meta);

    // 7. Load and return
    await slot.load();
    return slot;
  }

  /** List all slots. */
  static async list(): Promise<Slot[]> {
    const userConfig = await loadUserConfig();
    const slotsDir = getSlotsDir(userConfig);

    if (!existsSync(slotsDir)) return [];

    const entries = await readdir(slotsDir, { withFileTypes: true });
    const slots: Slot[] = [];

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const slot = new Slot(entry.name, slotsDir);
      if (existsSync(join(slot.path, 'slot.yaml'))) {
        await slot.load();
        slots.push(slot);
      }
    }

    return slots;
  }

  /** Load an existing slot by name. */
  static async load(name: string): Promise<Slot> {
    const userConfig = await loadUserConfig();
    const slotsDir = getSlotsDir(userConfig);
    const slot = new Slot(name, slotsDir);

    if (!slot.exists()) {
      const available = await SlotManager.list();
      const names = available.map(s => s.name).join(', ');
      throw new Error(
        `Slot '${name}' does not exist.\n\n` +
        `Available slots: ${names || 'none'}\n` +
        `Create with: zbb slot create ${name}`
      );
    }

    await slot.load();
    return slot;
  }

  /** Delete a slot. Returns summary of what was cleaned up. */
  static async delete(name: string): Promise<{ containers: number; volumes: number }> {
    const userConfig = await loadUserConfig();
    const slotsDir = getSlotsDir(userConfig);
    const slotDir = join(slotsDir, name);

    if (!existsSync(slotDir)) {
      throw new Error(`Slot '${name}' does not exist.`);
    }

    let containerCount = 0;
    let volumeCount = 0;

    // Stop containers and remove volumes for this slot
    // Match by label OR by name prefix (compose project = slot name)
    const { execSync } = await import('node:child_process');
    try {
      // Find containers by label or name prefix
      const byLabel = execSync(
        `docker ps -a --filter "label=zerobias.slot=${name}" --format "{{.Names}}"`,
        { encoding: 'utf-8' },
      ).trim();
      const byName = execSync(
        `docker ps -a --filter "name=${name}-" --format "{{.Names}}"`,
        { encoding: 'utf-8' },
      ).trim();
      const allNames = new Set([
        ...byLabel.split('\n').filter(Boolean),
        ...byName.split('\n').filter(Boolean),
      ]);
      if (allNames.size > 0) {
        containerCount = allNames.size;
        execSync(`docker rm -f ${[...allNames].join(' ')}`, { stdio: 'pipe' });
      }

      const volumes = execSync(
        `docker volume ls -q --filter "name=${name}_"`,
        { encoding: 'utf-8' },
      ).trim();
      if (volumes) {
        const vols = volumes.split('\n').filter(Boolean);
        volumeCount = vols.length;
        execSync(`docker volume rm ${vols.join(' ')}`, { stdio: 'pipe' });
      }

      // Clean up networks
      const networks = execSync(
        `docker network ls --filter "name=${name}_" --format "{{.Name}}"`,
        { encoding: 'utf-8' },
      ).trim();
      if (networks) {
        for (const net of networks.split('\n').filter(Boolean)) {
          try { execSync(`docker network rm ${net}`, { stdio: 'pipe' }); } catch { /* may be in use */ }
        }
      }
    } catch {
      // docker not available or no containers/volumes — continue with delete
    }

    await rm(slotDir, { recursive: true, force: true });
    return { containers: containerCount, volumes: volumeCount };
  }

  /** Garbage collect expired ephemeral slots. Returns names of deleted slots. */
  static async gc(): Promise<string[]> {
    const slots = await SlotManager.list();
    const deleted: string[] = [];

    for (const slot of slots) {
      if (slot.isEphemeral() && slot.isExpired()) {
        await SlotManager.delete(slot.name);
        deleted.push(slot.name);
      }
    }

    return deleted;
  }
}
