import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';

/**
 * Source values for ManifestEntry:
 *   "override"  — user set via `zbb env set`. Value lives in .env; manifest
 *                 marks it so `zbb env unset` / `reset` can revert it to the
 *                 canonical slot-derived value.
 *   "zbb"       — framework-default, computed from slot identity/path at create
 *   "resolver"  — computed by a registered resolver function
 *   "user"      — user-declared in .env directly
 *   "dns"       — provisioned from DNS TXT records by slot.resolve()
 *   "default"   — set by slot create as a default value
 *
 * Note: before Phase 4 slot overrides lived in a separate `overrides.env`
 * file with its own Map. That file is gone. Overrides now merge into the
 * single `.env` and are tagged in manifest.yaml — same pattern as
 * StackEnvironment.
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
 *
 * Single source of truth: `<slot>/.env` holds the current effective
 * value for every slot-level var. `<slot>/manifest.yaml` records
 * provenance per var (source: 'zbb' | 'override' | 'dns' | ...).
 *
 * User overrides written by `zbb env set` update .env in place AND
 * mark the manifest entry as `source: 'override'` so `zbb env unset`
 * and `zbb env reset` can revert to the canonical slot-derived value.
 */
export class SlotEnvironment extends EventEmitter {
  private declared: Map<string, string> = new Map();
  private manifest: Map<string, ManifestEntry> = new Map();

  readonly slotDir: string;

  constructor(slotDir: string) {
    super();
    this.slotDir = slotDir;
  }

  private get envPath() { return join(this.slotDir, '.env'); }
  private get manifestPath() { return join(this.slotDir, 'manifest.yaml'); }

  async load(): Promise<void> {
    if (existsSync(this.envPath)) {
      this.declared = parseEnvFile(await readFile(this.envPath, 'utf-8'));
    }
    if (existsSync(this.manifestPath)) {
      const { loadYaml } = await import('../yaml.js');
      this.manifest = new Map(
        Object.entries(await loadYaml<Record<string, ManifestEntry>>(this.manifestPath))
      );
    }
  }

  /** Get var value from `<slot>/.env` (which carries any overrides). */
  get(key: string): string | undefined {
    return this.declared.get(key);
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
   * any non-zbb entries that happen to be in the on-disk .env (e.g. from
   * slots created by older zbb versions) are filtered out. Stack env
   * comes from the stack API — never through this method.
   */
  getAll(): Record<string, string> {
    const result: Record<string, string> = {};
    for (const [k, v] of this.declared) {
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
    return result;
  }

  /**
   * Set a slot-level override.
   *
   * Only keys in ZBB_SLOT_VARS are writable at the slot level. Everything
   * else (AWS_*, PG*, app vars, port allocations, etc.) belongs to a
   * stack — callers must route to the target stack's env.set() instead.
   * Attempting to set a non-slot-level var throws with a clear error
   * pointing at the correct API, so future code paths can't silently
   * pollute the slot like the old architecture did.
   *
   * Writes the new value directly into `<slot>/.env` (replacing the
   * existing declared value if any) and marks the manifest entry as
   * `source: 'override'`. Unlike the old dual-file model, there is no
   * separate overrides.env — .env is the single source of truth.
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
    this.declared.set(key, value);
    // Write .env first — before manifest write can trigger watcher
    await this.writeEnvFile();
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

  /**
   * Remove a user override. Throws if the caller tries to unset a non-slot
   * var (routing bug — those belong to a stack) or a key that isn't
   * currently an override (framework-default slot paths like ZB_SLOT_DIR
   * cannot be unset — they come from the slot itself, not the user).
   *
   * Reverts the .env value to the canonical slot-derived default and
   * drops the manifest entry so the next load sees the default source
   * ("zbb") again.
   */
  async unset(key: string): Promise<void> {
    if (!isSlotLevelVar(key)) {
      throw new Error(
        `Cannot unset '${key}' at the slot level — the slot only owns ` +
        `identity/path vars (${[...ZBB_SLOT_VARS].join(', ')}). ` +
        `Non-slot vars belong to a stack. Use stack.env.unset('${key}') ` +
        `on the appropriate stack instead.`,
      );
    }
    const entry = this.manifest.get(key);
    if (entry?.source !== 'override') {
      throw new Error(
        `Cannot unset '${key}' — it is not a user override. ` +
        `Slot-level path vars come from the slot itself and cannot be unset.`,
      );
    }
    const canonical = canonicalSlotVar(this.slotDir, key);
    if (canonical === undefined) {
      // Shouldn't happen: isSlotLevelVar already guarded the key set,
      // and canonicalSlotVar covers every ZBB_SLOT_VARS entry.
      throw new Error(`Cannot compute canonical value for slot var '${key}'`);
    }
    this.declared.set(key, canonical);
    await this.writeEnvFile();
    this.manifest.delete(key);
    const { saveYaml } = await import('../yaml.js');
    await saveYaml(this.manifestPath, Object.fromEntries(this.manifest));
    this.emit('change', { key, value: canonical });
  }

  /** Clear all user overrides, reverting every overridden var to its canonical value. */
  async reset(): Promise<void> {
    const toRevert: string[] = [];
    for (const [key, entry] of this.manifest) {
      if (entry.source === 'override') toRevert.push(key);
    }
    if (toRevert.length === 0) return;

    for (const key of toRevert) {
      const canonical = canonicalSlotVar(this.slotDir, key);
      if (canonical !== undefined) this.declared.set(key, canonical);
      this.manifest.delete(key);
    }
    await this.writeEnvFile();
    const { saveYaml } = await import('../yaml.js');
    await saveYaml(this.manifestPath, Object.fromEntries(this.manifest));
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
    return [...this.declared.keys()].sort();
  }

  /** Check if var should be masked in output. */
  shouldMask(key: string): boolean {
    const entry = this.manifest.get(key);
    // Explicit mask: true/false in zbb.yaml is canonical
    if (entry?.mask !== undefined) return entry.mask;
    // Compat fallback — will be removed when all zbb.yaml files declare mask explicitly
    return /(?:key|secret|token|password|pass|jwt)$/i.test(key) || /credential/i.test(key);
  }

  /** Is this an override vs framework default? Based on manifest provenance. */
  isOverride(key: string): boolean {
    return this.manifest.get(key)?.source === 'override';
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

  /**
   * Write the current declared map to `<slot>/.env`, filtering to
   * ZBB_SLOT_VARS. Even if the in-memory map somehow contains non-slot
   * vars (e.g. from loading a polluted legacy .env), only the canonical
   * set is persisted back — the file self-heals over time.
   */
  private async writeEnvFile(): Promise<void> {
    const filtered = new Map<string, string>();
    for (const [k, v] of this.declared) {
      if (isSlotLevelVar(k)) filtered.set(k, v);
    }
    await writeFile(this.envPath, serializeEnv(filtered), 'utf-8');
  }
}

/**
 * The canonical value for each slot-level var, derived from `slotDir`.
 * Used by `unset` / `reset` to revert an overridden value back to what
 * slot create would have produced. Kept in sync with Slot.getSlotEnvVars.
 */
function canonicalSlotVar(slotDir: string, key: string): string | undefined {
  const name = slotDir.split('/').filter(Boolean).pop() ?? '';
  switch (key) {
    case 'ZB_SLOT': return name;
    case 'ZB_SLOT_DIR': return slotDir;
    case 'ZB_SLOT_CONFIG': return join(slotDir, 'config');
    case 'ZB_SLOT_LOGS': return join(slotDir, 'logs');
    case 'ZB_SLOT_STATE': return join(slotDir, 'state');
    case 'ZB_SLOT_TMP': return join(slotDir, 'state', 'tmp');
    case 'ZB_STACKS_DIR': return join(slotDir, 'stacks');
    default: return undefined;
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
