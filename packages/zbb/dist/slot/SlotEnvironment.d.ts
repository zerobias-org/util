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
    derived?: boolean;
    generated?: string;
    allocated?: number;
    description?: string;
}
/**
 * Manages a slot's environment variables.
 * Reads from .env (declared) and overrides.env (user overrides).
 * Writes are only to overrides.env.
 */
export declare class SlotEnvironment extends EventEmitter {
    private declared;
    private overrides;
    private manifest;
    /**
     * Global resolver map. Resolvers are registered once at process startup
     * and apply to all SlotEnvironment instances. They provide computed values
     * for env vars that cannot be expressed as simple ${VAR} references
     * (e.g., HUB_SERVER_URL derived from HUB_SERVER_PORT).
     */
    private static resolvers;
    /**
     * Register a global resolver function for an environment variable key.
     * The resolver is called by get() when the key is not found in declared
     * or override values. Resolvers are static and global -- called once at
     * process startup, not per-slot.
     *
     * @param key - The environment variable name to resolve
     * @param fn - Resolver function receiving the SlotEnvironment instance
     */
    static registerResolver(key: string, fn: (env: SlotEnvironment) => string | undefined): void;
    /** Clear all registered resolvers. Used for test isolation. */
    static clearResolvers(): void;
    readonly slotDir: string;
    constructor(slotDir: string);
    private get envPath();
    private get overridesPath();
    private get manifestPath();
    load(): Promise<void>;
    /** Get var value. Overrides > declared > resolver. Returns real value. */
    get(key: string): string | undefined;
    /** Get var value masked for display. */
    getMasked(key: string): string | undefined;
    /** Get all vars. Returns real values. */
    getAll(): Record<string, string>;
    /** Get all vars masked for display. */
    getAllMasked(): Record<string, string>;
    /** Set a user override (persisted to overrides.env). Optional mask flag. */
    set(key: string, value: string, mask?: boolean): Promise<void>;
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
    setDeclared(key: string, value: string, source: string, mask?: boolean): Promise<void>;
    /** Alias for getManifestEntry — backward compat. */
    getMetadata(key: string): ManifestEntry | undefined;
    /** Reload env from disk (alias for load when already initialized). */
    reload(): Promise<void>;
    /** Remove a user override. */
    unset(key: string): Promise<void>;
    /** Clear all overrides back to declared defaults. */
    reset(): Promise<void>;
    /** Get manifest entry for a var. */
    getManifestEntry(key: string): ManifestEntry | undefined;
    /** Get full manifest. */
    getManifest(): Record<string, ManifestEntry>;
    /** List all var names (sorted). */
    list(): string[];
    /** Check if var should be masked in output. */
    shouldMask(key: string): boolean;
    /** Is this an override vs declared value? */
    isOverride(key: string): boolean;
    static writeDeclaredEnv(slotDir: string, env: Map<string, string>, manifest: Map<string, ManifestEntry>): Promise<void>;
    /**
     * Merge new env vars and manifest entries into an existing slot.
     * Never overwrites existing keys — only adds new ones.
     */
    static appendDeclaredEnv(slotDir: string, newEnv: Map<string, string>, newManifest: Map<string, ManifestEntry>): Promise<void>;
    private writeOverrides;
}
