import { mkdir, readdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { Slot, type SlotMeta } from './Slot.js';
import { SlotEnvironment, type ManifestEntry } from './SlotEnvironment.js';
import { allocatePorts, allocateSlotPortRange, validatePortRange } from './PortAllocator.js';
import { scanEnvDeclarations } from '../env/Scanner.js';
import { resolveAll } from '../env/Resolver.js';
import { generateSecret } from '../env/SecretGen.js';
import { saveYaml, loadYamlOrDefault } from '../yaml.js';
import {
  findRepoRoot,
  getSlotsDir,
  loadUserConfig,
  loadRepoConfig,
  loadProjectConfig,
  type RepoConfig,
  type UserConfig,
} from '../config.js';

export interface CreateOptions {
  ephemeral?: boolean;
  ttl?: number;
  repoRoot?: string;
  portRange?: [number, number];
}

export class SlotManager {
  /**
   * Create a new slot.
   * Scans zbb.yaml files, allocates ports, generates secrets, resolves vars.
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

    // Find repo root (optional — slot can be created outside a project)
    const repoRoot = options.repoRoot ?? findRepoRoot(process.cwd());

    // Check if current project opts out of repo-wide inheritance
    const projectConfig = await loadProjectConfig(process.cwd());
    const inherit = projectConfig.inherit !== false;

    let scanned: Awaited<ReturnType<typeof scanEnvDeclarations>> = [];
    if (!inherit) {
      // Standalone project — scan only this project's zbb.yaml
      const { join } = await import('node:path');
      scanned = await scanEnvDeclarations(process.cwd(), join(process.cwd(), 'zbb.yaml'));
    } else if (repoRoot) {
      const repoConfig = await loadRepoConfig(repoRoot);
      // Scan all zbb.yaml files across repo
      scanned = await scanEnvDeclarations(repoRoot);
    }

    // 2. Allocate a non-overlapping port range for this slot
    //    Scans existing slots and picks the next available block
    const existingSlots = await SlotManager.list();
    const portRange = options.portRange ?? allocateSlotPortRange(existingSlots);
    validatePortRange(portRange, existingSlots);

    // 3. Create slot directories
    await mkdir(slotDir, { recursive: true });
    await mkdir(join(slotDir, 'config'), { recursive: true });
    await mkdir(join(slotDir, 'logs'), { recursive: true });
    await mkdir(join(slotDir, 'state'), { recursive: true });
    await mkdir(join(slotDir, 'state', 'tmp'), { recursive: true });
    await mkdir(join(slotDir, 'stacks'), { recursive: true });

    // 4. Build slot env vars (available for ${VAR} resolution)
    const slot = new Slot(name, slotsDir);
    const slotVars = slot.getSlotEnvVars();

    // 5. Allocate ports within this slot's range
    const portAllocations = allocatePorts(scanned, portRange);

    // 5. Generate secrets
    const secrets = new Map<string, string>();
    const secretVars = scanned.filter(v => v.declaration.type === 'secret' && v.declaration.generate);
    for (const v of secretVars) {
      const value = generateSecret(v.declaration.generate!, secrets);
      secrets.set(v.name, value);
    }

    // 6. Collect inherited vars (source: env)
    const inherited = new Map<string, string>();
    const inheritedVars = scanned.filter(v => v.declaration.source === 'env');
    for (const v of inheritedVars) {
      const value = process.env[v.name];
      if (!value && v.declaration.required) {
        throw new Error(
          `Required environment variable '${v.name}' not found in parent shell. ` +
          `(declared in ${v.source})`
        );
      }
      if (value) inherited.set(v.name, value);
    }

    // 6b. Resolve cwd vars (source: cwd → absolute path of declaring project)
    const { dirname, resolve } = await import('node:path');
    const cwdVars = new Map<string, string>();
    if (repoRoot) {
      for (const v of scanned.filter(v => v.declaration.source === 'cwd')) {
        cwdVars.set(v.name, resolve(repoRoot, dirname(v.source)));
      }
    }

    // 7. Build pre-resolved map (ports + secrets + inherited + cwd + slot vars)
    const preResolved = new Map<string, string>();
    for (const [k, v] of Object.entries(slotVars)) preResolved.set(k, v);
    for (const alloc of portAllocations) preResolved.set(alloc.name, String(alloc.port));
    for (const [k, v] of secrets) preResolved.set(k, v);
    for (const [k, v] of inherited) preResolved.set(k, v);
    for (const [k, v] of cwdVars) preResolved.set(k, v);

    // 8. Collect derived vars (string type with ${VAR} refs in default)
    const derivedVars = new Map<string, string>();
    for (const v of scanned) {
      if (preResolved.has(v.name)) continue; // already resolved
      if (v.declaration.deprecated) continue;
      const defaultVal = v.declaration.default;
      if (defaultVal !== undefined) {
        derivedVars.set(v.name, defaultVal);
      }
    }

    // 9. Resolve derived vars
    const resolved = resolveAll(derivedVars, preResolved);

    // 10. Build final env and manifest
    const env = new Map<string, string>();
    const manifest = new Map<string, ManifestEntry>();

    // Slot vars
    for (const [k, v] of Object.entries(slotVars)) {
      env.set(k, v);
      manifest.set(k, { source: 'zbb', type: 'slot' });
    }

    // Ports
    for (const alloc of portAllocations) {
      env.set(alloc.name, String(alloc.port));
      manifest.set(alloc.name, {
        source: alloc.source,
        type: 'port',
        allocated: alloc.port,
      });
    }

    // Secrets
    for (const v of secretVars) {
      env.set(v.name, secrets.get(v.name)!);
      manifest.set(v.name, {
        source: v.source,
        type: 'secret',
        mask: true,
        generated: v.declaration.generate,
      });
    }

    // Inherited
    for (const v of inheritedVars) {
      const value = inherited.get(v.name);
      if (value) {
        env.set(v.name, value);
        manifest.set(v.name, {
          source: v.source,
          type: 'inherited',
          mask: v.declaration.mask ?? false,
        });
      }
    }

    // Derived / string defaults
    for (const r of resolved) {
      env.set(r.name, r.value);
      const scanEntry = scanned.find(s => s.name === r.name);
      manifest.set(r.name, {
        source: scanEntry?.source ?? 'unknown',
        type: scanEntry?.declaration.type ?? 'string',
        derived: r.derived,
        mask: scanEntry?.declaration.mask ?? false,
      });
    }

    // 11. Write .env and manifest.yaml
    await SlotEnvironment.writeDeclaredEnv(slotDir, env, manifest);

    // 12. Write slot.yaml metadata
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

    // 13. Load and return
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
    // Match by label OR by name prefix (STACK_NAME = slot name)
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
