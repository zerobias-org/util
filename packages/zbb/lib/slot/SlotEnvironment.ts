import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const SENSITIVE_PATTERNS = [
  /key$/i,
  /secret$/i,
  /token$/i,
  /password$/i,
  /pass$/i,
  /credential/i,
];

export interface ManifestEntry {
  source: string;
  type: string;
  mask?: boolean;
  derived?: boolean;
  generated?: string;
  allocated?: number;
}

/**
 * Manages a slot's environment variables.
 * Reads from .env (declared) and overrides.env (user overrides).
 * Writes are only to overrides.env.
 */
export class SlotEnvironment {
  private declared: Map<string, string> = new Map();
  private overrides: Map<string, string> = new Map();
  private manifest: Map<string, ManifestEntry> = new Map();

  readonly slotDir: string;

  constructor(slotDir: string) {
    this.slotDir = slotDir;
  }

  private get envPath() { return join(this.slotDir, '.env'); }
  private get overridesPath() { return join(this.slotDir, 'overrides.env'); }
  private get manifestPath() { return join(this.slotDir, 'manifest.yaml'); }

  async load(): Promise<void> {
    if (existsSync(this.envPath)) {
      this.declared = parseEnvFile(await readFile(this.envPath, 'utf-8'));
    }
    if (existsSync(this.overridesPath)) {
      this.overrides = parseEnvFile(await readFile(this.overridesPath, 'utf-8'));
    }
    if (existsSync(this.manifestPath)) {
      const { loadYaml } = await import('../yaml.ts');
      this.manifest = new Map(
        Object.entries(await loadYaml<Record<string, ManifestEntry>>(this.manifestPath))
      );
    }
  }

  /** Get var value. Overrides take priority over declared. */
  get(key: string): string | undefined {
    return this.overrides.get(key) ?? this.declared.get(key);
  }

  /** Get all vars (overrides merged over declared). */
  getAll(): Record<string, string> {
    const result: Record<string, string> = {};
    for (const [k, v] of this.declared) result[k] = v;
    for (const [k, v] of this.overrides) result[k] = v;
    return result;
  }

  /** Get all vars with masking applied. */
  getAllMasked(): Record<string, string> {
    const all = this.getAll();
    const result: Record<string, string> = {};
    for (const [k, v] of Object.entries(all)) {
      result[k] = this.shouldMask(k) ? '***' : v;
    }
    return result;
  }

  /** Set a user override (persisted to overrides.env). */
  async set(key: string, value: string): Promise<void> {
    this.overrides.set(key, value);
    await this.writeOverrides();
  }

  /** Remove a user override. */
  async unset(key: string): Promise<void> {
    this.overrides.delete(key);
    await this.writeOverrides();
  }

  /** Clear all overrides back to declared defaults. */
  async reset(): Promise<void> {
    this.overrides.clear();
    await this.writeOverrides();
  }

  /** Get manifest entry for a var. */
  getManifestEntry(key: string): ManifestEntry | undefined {
    return this.manifest.get(key);
  }

  /** Get full manifest. */
  getManifest(): Record<string, ManifestEntry> {
    return Object.fromEntries(this.manifest);
  }

  /** List all var names (sorted). */
  list(): string[] {
    const keys = new Set([...this.declared.keys(), ...this.overrides.keys()]);
    return [...keys].sort();
  }

  /** Check if var should be masked in output. */
  shouldMask(key: string): boolean {
    const entry = this.manifest.get(key);
    if (entry?.mask) return true;
    if (entry?.type === 'secret') return true;
    return SENSITIVE_PATTERNS.some(p => p.test(key));
  }

  /** Is this an override vs declared value? */
  isOverride(key: string): boolean {
    return this.overrides.has(key);
  }

  // ── Static: write declared env during slot create ──────────────────

  static async writeDeclaredEnv(
    slotDir: string,
    env: Map<string, string>,
    manifest: Map<string, ManifestEntry>,
  ): Promise<void> {
    const envPath = join(slotDir, '.env');
    const manifestPath = join(slotDir, 'manifest.yaml');

    await writeFile(envPath, serializeEnv(env), 'utf-8');

    const { saveYaml } = await import('../yaml.ts');
    await saveYaml(manifestPath, Object.fromEntries(manifest));
  }

  // ── Static: append new vars to existing slot env ──────────────────

  /**
   * Merge new env vars and manifest entries into an existing slot.
   * Never overwrites existing keys — only adds new ones.
   */
  static async appendDeclaredEnv(
    slotDir: string,
    newEnv: Map<string, string>,
    newManifest: Map<string, ManifestEntry>,
  ): Promise<void> {
    const envPath = join(slotDir, '.env');
    const manifestPath = join(slotDir, 'manifest.yaml');

    // Read existing .env
    const existingEnv = existsSync(envPath)
      ? parseEnvFile(await readFile(envPath, 'utf-8'))
      : new Map<string, string>();

    // Merge: existing wins (never overwrite)
    const merged = new Map<string, string>(existingEnv);
    for (const [k, v] of newEnv) {
      if (!merged.has(k)) {
        merged.set(k, v);
      }
    }

    await writeFile(envPath, serializeEnv(merged), 'utf-8');

    // Read existing manifest
    const { loadYamlOrDefault, saveYaml } = await import('../yaml.ts');
    const existingManifest = await loadYamlOrDefault<Record<string, ManifestEntry>>(manifestPath, {});

    // Merge manifest: existing wins
    for (const [k, v] of newManifest) {
      if (!(k in existingManifest)) {
        existingManifest[k] = v;
      }
    }

    await saveYaml(manifestPath, existingManifest);
  }

  private async writeOverrides(): Promise<void> {
    await writeFile(this.overridesPath, serializeEnv(this.overrides), 'utf-8');
  }
}

// ── Env file parsing ─────────────────────────────────────────────────

function parseEnvFile(content: string): Map<string, string> {
  const env = new Map<string, string>();
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx === -1) continue;
    const key = trimmed.slice(0, idx).trim();
    const value = trimmed.slice(idx + 1).trim();
    env.set(key, value);
  }
  return env;
}

function serializeEnv(env: Map<string, string>): string {
  const lines: string[] = [];
  for (const key of [...env.keys()].sort()) {
    lines.push(`${key}=${env.get(key)}`);
  }
  return lines.join('\n') + '\n';
}
