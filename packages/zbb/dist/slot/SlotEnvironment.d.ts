import { EventEmitter } from 'node:events';
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
    /** Get var value. Overrides > declared > resolver. Masking applied unless unmask=true. */
    get(key: string, unmask?: boolean): string | undefined;
    /** Get all vars. Masking applied unless unmask=true. */
    getAll(unmask?: boolean): Record<string, string>;
    /** Get all vars with masking applied. */
    getAllMasked(): Record<string, string>;
    /** Get all vars unmasked. */
    getAllUnmasked(): Record<string, string>;
    /** Set a user override (persisted to overrides.env). Optional mask flag. */
    set(key: string, value: string, mask?: boolean): Promise<void>;
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
