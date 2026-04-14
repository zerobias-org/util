import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';

/**
 * Source values for ManifestEntry:
 *   "override"  — user set via `zbb env set` (written to overrides.env)
 *   "resolver"  — computed by a registered resolver function
 *   "user"      — user-declared in .env directly
 *   "dns"       — provisioned from DNS TXT records by slot.resolve()
 *   "default"   — set by slot create as a default value
 */
export interface ManifestEntry {
  source: string;
  type: string;
  mask?: boolean;
  hidden?: boolean;
  derived?: boolean;
  generated?: string;
  allocated?: number;
  description?: string;
  examples?: string[];
}

/**
 * The canonical set of variables allowed at the slot level.
 *
 * All other env vars belong to stacks, not the slot. A stack contributes
 * its own env (and any imports it explicitly declares) when loaded. The
 * slot itself only carries identity + filesystem-path vars.
 *
 * Writing any var outside this set into slot.env will throw — callers
 * must route to the appropriate stack's env instead. Reading polluted
 * existing .env files (e.g. from slots created by older zbb versions)
 * silently filters — non-zbb entries are ignored, not deleted.
 *
 * Notably absent: `ZB_STACK`. The current stack's short name is
 * stack-scoped (each stack's .env sets its own `ZB_STACK`) and must
 * never be written to the slot's .env or overrides.env. The legacy
 * `STACK_NAME` alias has been removed entirely.
 */
export const ZBB_SLOT_VARS = new Set([
  'ZB_SLOT',
  'ZB_SLOT_DIR',
  'ZB_SLOT_CONFIG',
  'ZB_SLOT_LOGS',
  'ZB_SLOT_STATE',
  'ZB_SLOT_TMP',
  'ZB_STACKS_DIR',
]);

export function isSlotLevelVar(key: string): boolean {
  return ZBB_SLOT_VARS.has(key);
}

/**
 * Manages a slot's environment variables.
 * Reads from .env (declared) and overrides.env (user overrides).
 * Writes are only to overrides.env.
 */
export class SlotEnvironment extends EventEmitter {
  private declared: Map<string, string> = new Map();
  private overrides: Map<string, string> = new Map();
  private manifest: Map<string, ManifestEntry> = new Map();

  /**
   * Global resolver map. Resolvers are registered once at process startup
   * and apply to all SlotEnvironment instances. They provide computed values
   * for env vars that cannot be expressed as simple ${VAR} references
   * (e.g., HUB_SERVER_URL derived from HUB_SERVER_PORT).
   */
  private static resolvers: Map<string, (env: SlotEnvironment) => string | undefined> = new Map();

  /**
   * Register a global resolver function for an environment variable key.
   * The resolver is called by get() when the key is not found in declared
   * or override values. Resolvers are static and global -- called once at
   * process startup, not per-slot.
   *
   * @param key - The environment variable name to resolve
   * @param fn - Resolver function receiving the SlotEnvironment instance
   */
  static registerResolver(key: string, fn: (env: SlotEnvironment) => string | undefined): void {
    SlotEnvironment.resolvers.set(key, fn);
  }

  /** Clear all registered resolvers. Used for test isolation. */
  static clearResolvers(): void {
    SlotEnvironment.resolvers.clear();
  }

  readonly slotDir: string;

  constructor(slotDir: string) {
    super();
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
      const { loadYaml } = await import('../yaml.js');
      this.manifest = new Map(
        Object.entries(await loadYaml<Record<string, ManifestEntry>>(this.manifestPath))
      );
    }
  }

  /** Get var value. Overrides > declared > resolver. Returns real value. */
  get(key: string): string | undefined {
    return this.overrides.get(key) ?? this.declared.get(key) ?? SlotEnvironment.resolvers.get(key)?.(this);
  }

  /** Get var value masked for display. */
  getMasked(key: string): string | undefined {
    const value = this.get(key);
    if (value === undefined) return undefined;
    if (this.shouldMask(key)) return '***MASKED***';
    return value;
  }

  /**
   * Get all slot-level vars. Returns ONLY the canonical ZBB_SLOT_VARS set;
   * any non-zbb entries that happen to be in the on-disk .env/overrides.env
   * (e.g. from slots created by older zbb versions) are filtered out.
   * Stack env comes from the stack API — never through this method.
   */
  getAll(): Record<string, string> {
    const result: Record<string, string> = {};
    for (const [k, v] of this.declared) {
      if (isSlotLevelVar(k)) result[k] = v;
    }
    for (const [k, v] of this.overrides) {
      if (isSlotLevelVar(k)) result[k] = v;
    }
    return result;
  }

  /** Get all slot-level vars masked for display (same filter as getAll). */
  getAllMasked(): Record<string, string> {
    const result: Record<string, string> = {};
    for (const [k, v] of this.declared) {
      if (!isSlotLevelVar(k)) continue;
      result[k] = this.shouldMask(k) ? '***MASKED***' : v;
    }
    for (const [k, v] of this.overrides) {
      if (!isSlotLevelVar(k)) continue;
      result[k] = this.shouldMask(k) ? '***MASKED***' : v;
    }
    return result;
  }

  /**
   * Set a slot-level override (persisted to overrides.env).
   *
   * Only keys in ZBB_SLOT_VARS are writable at the slot level. Everything
   * else (AWS_*, PG*, app vars, port allocations, etc.) belongs to a
   * stack — callers must route to the target stack's env.set() instead.
   * Attempting to set a non-slot-level var throws with a clear error
   * pointing at the correct API, so future code paths can't silently
   * pollute the slot like the old architecture did.
   */
  async set(key: string, value: string, mask?: boolean): Promise<void> {
    if (!isSlotLevelVar(key)) {
      throw new Error(
        `Cannot set '${key}' at the slot level — the slot only owns ` +
        `identity/path vars (${[...ZBB_SLOT_VARS].join(', ')}). ` +
        `Non-slot vars belong to a stack. Use stack.env.set('${key}', ...) ` +
        `on the appropriate stack instead.`,
      );
    }
    this.overrides.set(key, value);
    // Write value to disk FIRST — before manifest write can trigger watcher
    await this.writeOverrides();
    // Always update manifest source to 'override' so UI/consumers see correct provenance
    const existing = this.manifest.get(key);
    this.manifest.set(key, {
      ...(existing ?? { source: 'override', type: 'string' }),
      source: 'override',
      ...(mask !== undefined ? { mask } : {}),
    });
    const { saveYaml } = await import('../yaml.js');
    await saveYaml(this.manifestPath, Object.fromEntries(this.manifest));
    this.emit('change', { key, value });
  }

  /**
   * Set a value in the declared env (.env file) with explicit source tracking in manifest.
   * Used by slot.resolve() to record DNS-provisioned values.
   *
   * - If the key already has a manifest entry with source "user" or "override": no-op.
   * - Otherwise: sets value in declared env and records manifest with given source.
   *
   * @param key - Environment variable name
   * @param value - Value to set
   * @param source - Source label (e.g. "dns")
   * @param mask - Optional: force mask for display
   */
  async setDeclared(key: string, value: string, source: string, mask?: boolean): Promise<void> {
    const existing = this.manifest.get(key);
    if (existing?.source === 'user' || existing?.source === 'override') {
      return; // Never overwrite user or override values
    }

    this.declared.set(key, value);
    this.manifest.set(key, {
      ...existing,
      source,
      type: existing?.type ?? 'string',
      ...(mask !== undefined ? { mask } : {}),
    });

    const { saveYaml } = await import('../yaml.js');
    await saveYaml(this.manifestPath, Object.fromEntries(this.manifest));
    await writeFile(this.envPath, serializeEnv(this.declared), 'utf-8');
    this.emit('change', { key, value });
  }

  /** Alias for getManifestEntry — backward compat. */
  getMetadata(key: string): ManifestEntry | undefined {
    return this.manifest.get(key);
  }

  /** Reload env from disk (alias for load when already initialized). */
  async reload(): Promise<void> {
    await this.load();
    this.emit('change', {});
  }

  /** Remove a user override. */
  async unset(key: string): Promise<void> {
    this.overrides.delete(key);
    // Remove from manifest if it was an override-sourced entry (user-added)
    const entry = this.manifest.get(key);
    if (entry?.source === 'override') {
      this.manifest.delete(key);
      const { saveYaml } = await import('../yaml.js');
      await saveYaml(this.manifestPath, Object.fromEntries(this.manifest));
    }
    await this.writeOverrides();
    this.emit('change', { key, value: undefined });
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
    // Explicit mask: true/false in zbb.yaml is canonical
    if (entry?.mask !== undefined) return entry.mask;
    // Compat fallback — will be removed when all zbb.yaml files declare mask explicitly
    return /(?:key|secret|token|password|pass|jwt)$/i.test(key) || /credential/i.test(key);
  }

  /** Is this an override vs declared value? */
  isOverride(key: string): boolean {
    return this.overrides.has(key);
  }

  // ── Static: write declared env during slot create ──────────────────

  /**
   * Write the slot-level .env + manifest files. Filters input down to
   * ZBB_SLOT_VARS — any stack-owned vars that sneak into the env map
   * (e.g. from a legacy caller rebuilding a merged projection) are
   * silently dropped. This is a defensive backstop for the architecture
   * rule: slot .env holds only identity/path vars. Stack env lives in
   * `<slot>/stacks/<name>/.env` and is composed on demand.
   */
  static async writeDeclaredEnv(
    slotDir: string,
    env: Map<string, string>,
    manifest: Map<string, ManifestEntry>,
  ): Promise<void> {
    const envPath = join(slotDir, '.env');
    const manifestPath = join(slotDir, 'manifest.yaml');

    // Defensive filter: only persist ZBB_SLOT_VARS
    const filteredEnv = new Map<string, string>();
    for (const [k, v] of env) {
      if (isSlotLevelVar(k)) filteredEnv.set(k, v);
    }
    const filteredManifest: Record<string, ManifestEntry> = {};
    for (const [k, v] of manifest) {
      if (isSlotLevelVar(k)) filteredManifest[k] = v;
    }

    await writeFile(envPath, serializeEnv(filteredEnv), 'utf-8');
    const { saveYaml } = await import('../yaml.js');
    await saveYaml(manifestPath, filteredManifest);
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

    // Read existing .env and strip any non-slot-level entries that may
    // have leaked in from a legacy writer. This self-heals polluted
    // legacy slot .env files over time.
    const existingRaw = existsSync(envPath)
      ? parseEnvFile(await readFile(envPath, 'utf-8'))
      : new Map<string, string>();
    const existingEnv = new Map<string, string>();
    for (const [k, v] of existingRaw) {
      if (isSlotLevelVar(k)) existingEnv.set(k, v);
    }

    // Merge: existing wins (never overwrite). Only accept new slot-level
    // vars — anything else is silently dropped.
    const merged = new Map<string, string>(existingEnv);
    for (const [k, v] of newEnv) {
      if (!isSlotLevelVar(k)) continue;
      if (!merged.has(k)) {
        merged.set(k, v);
      }
    }

    await writeFile(envPath, serializeEnv(merged), 'utf-8');

    // Read existing manifest and strip non-slot-level entries too
    const { loadYamlOrDefault, saveYaml } = await import('../yaml.js');
    const existingManifestRaw = await loadYamlOrDefault<Record<string, ManifestEntry>>(manifestPath, {});
    const existingManifest: Record<string, ManifestEntry> = {};
    for (const [k, v] of Object.entries(existingManifestRaw)) {
      if (isSlotLevelVar(k)) existingManifest[k] = v;
    }

    // Merge manifest: existing wins, filtered
    for (const [k, v] of newManifest) {
      if (!isSlotLevelVar(k)) continue;
      if (!(k in existingManifest)) {
        existingManifest[k] = v;
      }
    }

    await saveYaml(manifestPath, existingManifest);
  }

  /**
   * Write the overrides map to disk, filtering to zbb-slot-level vars only.
   * Even if the in-memory map somehow contains non-slot vars (e.g. from
   * loading a polluted legacy overrides.env), only the canonical set is
   * persisted back. This lets an old polluted file eventually clean
   * itself up the next time any legitimate slot-level var is set.
   */
  private async writeOverrides(): Promise<void> {
    const filtered = new Map<string, string>();
    for (const [k, v] of this.overrides) {
      if (isSlotLevelVar(k)) filtered.set(k, v);
    }
    await writeFile(this.overridesPath, serializeEnv(filtered), 'utf-8');
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
