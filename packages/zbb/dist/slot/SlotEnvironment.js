import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
const SENSITIVE_PATTERNS = [
    /key$/i,
    /secret$/i,
    /token$/i,
    /password$/i,
    /pass$/i,
    /credential/i,
];
/**
 * Manages a slot's environment variables.
 * Reads from .env (declared) and overrides.env (user overrides).
 * Writes are only to overrides.env.
 */
export class SlotEnvironment extends EventEmitter {
    declared = new Map();
    overrides = new Map();
    manifest = new Map();
    /**
     * Global resolver map. Resolvers are registered once at process startup
     * and apply to all SlotEnvironment instances. They provide computed values
     * for env vars that cannot be expressed as simple ${VAR} references
     * (e.g., HUB_SERVER_URL derived from HUB_SERVER_PORT).
     */
    static resolvers = new Map();
    /**
     * Register a global resolver function for an environment variable key.
     * The resolver is called by get() when the key is not found in declared
     * or override values. Resolvers are static and global -- called once at
     * process startup, not per-slot.
     *
     * @param key - The environment variable name to resolve
     * @param fn - Resolver function receiving the SlotEnvironment instance
     */
    static registerResolver(key, fn) {
        SlotEnvironment.resolvers.set(key, fn);
    }
    /** Clear all registered resolvers. Used for test isolation. */
    static clearResolvers() {
        SlotEnvironment.resolvers.clear();
    }
    slotDir;
    constructor(slotDir) {
        super();
        this.slotDir = slotDir;
    }
    get envPath() { return join(this.slotDir, '.env'); }
    get overridesPath() { return join(this.slotDir, 'overrides.env'); }
    get manifestPath() { return join(this.slotDir, 'manifest.yaml'); }
    async load() {
        if (existsSync(this.envPath)) {
            this.declared = parseEnvFile(await readFile(this.envPath, 'utf-8'));
        }
        if (existsSync(this.overridesPath)) {
            this.overrides = parseEnvFile(await readFile(this.overridesPath, 'utf-8'));
        }
        if (existsSync(this.manifestPath)) {
            const { loadYaml } = await import('../yaml.js');
            this.manifest = new Map(Object.entries(await loadYaml(this.manifestPath)));
        }
    }
    /** Get var value. Overrides > declared > resolver. Masking applied unless unmask=true. */
    get(key, unmask = false) {
        const value = this.overrides.get(key) ?? this.declared.get(key) ?? SlotEnvironment.resolvers.get(key)?.(this);
        if (value === undefined)
            return undefined;
        if (!unmask && this.shouldMask(key))
            return '***MASKED***';
        return value;
    }
    /** Get all vars. Masking applied unless unmask=true. */
    getAll(unmask = false) {
        const result = {};
        for (const [k, v] of this.declared)
            result[k] = unmask ? v : (this.shouldMask(k) ? '***MASKED***' : v);
        for (const [k, v] of this.overrides)
            result[k] = unmask ? v : (this.shouldMask(k) ? '***MASKED***' : v);
        return result;
    }
    /** Get all vars with masking applied. */
    getAllMasked() {
        return this.getAll(false);
    }
    /** Get all vars unmasked. */
    getAllUnmasked() {
        return this.getAll(true);
    }
    /** Set a user override (persisted to overrides.env). Optional mask flag. */
    async set(key, value, mask) {
        this.overrides.set(key, value);
        if (mask !== undefined) {
            this.manifest.set(key, {
                ...(this.manifest.get(key) ?? { source: 'override', type: 'string' }),
                mask,
            });
        }
        await this.writeOverrides();
        this.emit('change', { key, value });
    }
    /** Alias for getManifestEntry — backward compat. */
    getMetadata(key) {
        return this.manifest.get(key);
    }
    /** Reload env from disk (alias for load when already initialized). */
    async reload() {
        await this.load();
        this.emit('change', {});
    }
    /** Remove a user override. */
    async unset(key) {
        this.overrides.delete(key);
        await this.writeOverrides();
        this.emit('change', { key, value: undefined });
    }
    /** Clear all overrides back to declared defaults. */
    async reset() {
        this.overrides.clear();
        await this.writeOverrides();
    }
    /** Get manifest entry for a var. */
    getManifestEntry(key) {
        return this.manifest.get(key);
    }
    /** Get full manifest. */
    getManifest() {
        return Object.fromEntries(this.manifest);
    }
    /** List all var names (sorted). */
    list() {
        const keys = new Set([...this.declared.keys(), ...this.overrides.keys()]);
        return [...keys].sort();
    }
    /** Check if var should be masked in output. */
    shouldMask(key) {
        const entry = this.manifest.get(key);
        if (entry?.mask)
            return true;
        if (entry?.type === 'secret')
            return true;
        return SENSITIVE_PATTERNS.some(p => p.test(key));
    }
    /** Is this an override vs declared value? */
    isOverride(key) {
        return this.overrides.has(key);
    }
    // ── Static: write declared env during slot create ──────────────────
    static async writeDeclaredEnv(slotDir, env, manifest) {
        const envPath = join(slotDir, '.env');
        const manifestPath = join(slotDir, 'manifest.yaml');
        await writeFile(envPath, serializeEnv(env), 'utf-8');
        const { saveYaml } = await import('../yaml.js');
        await saveYaml(manifestPath, Object.fromEntries(manifest));
    }
    // ── Static: append new vars to existing slot env ──────────────────
    /**
     * Merge new env vars and manifest entries into an existing slot.
     * Never overwrites existing keys — only adds new ones.
     */
    static async appendDeclaredEnv(slotDir, newEnv, newManifest) {
        const envPath = join(slotDir, '.env');
        const manifestPath = join(slotDir, 'manifest.yaml');
        // Read existing .env
        const existingEnv = existsSync(envPath)
            ? parseEnvFile(await readFile(envPath, 'utf-8'))
            : new Map();
        // Merge: existing wins (never overwrite)
        const merged = new Map(existingEnv);
        for (const [k, v] of newEnv) {
            if (!merged.has(k)) {
                merged.set(k, v);
            }
        }
        await writeFile(envPath, serializeEnv(merged), 'utf-8');
        // Read existing manifest
        const { loadYamlOrDefault, saveYaml } = await import('../yaml.js');
        const existingManifest = await loadYamlOrDefault(manifestPath, {});
        // Merge manifest: existing wins
        for (const [k, v] of newManifest) {
            if (!(k in existingManifest)) {
                existingManifest[k] = v;
            }
        }
        await saveYaml(manifestPath, existingManifest);
    }
    async writeOverrides() {
        await writeFile(this.overridesPath, serializeEnv(this.overrides), 'utf-8');
    }
}
// ── Env file parsing ─────────────────────────────────────────────────
function parseEnvFile(content) {
    const env = new Map();
    for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#'))
            continue;
        const idx = trimmed.indexOf('=');
        if (idx === -1)
            continue;
        const key = trimmed.slice(0, idx).trim();
        const value = trimmed.slice(idx + 1).trim();
        env.set(key, value);
    }
    return env;
}
function serializeEnv(env) {
    const lines = [];
    for (const key of [...env.keys()].sort()) {
        lines.push(`${key}=${env.get(key)}`);
    }
    return lines.join('\n') + '\n';
}
