import { EventEmitter } from 'node:events';
import { SlotEnvironment } from './SlotEnvironment.js';
import { SlotWatcher } from './SlotWatcher.js';
import { lookupDnsTxt as _lookupDnsTxt } from '../env/DnsTxtResolver.js';
import { type RefreshResult } from './refresh.js';
/**
 * Internal dependencies — overridable for testing.
 * @internal
 */
export declare const _deps: {
    lookupDnsTxt: typeof _lookupDnsTxt;
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
export declare class Slot extends EventEmitter {
    readonly name: string;
    readonly path: string;
    env: SlotEnvironment;
    private _meta;
    private _watcher;
    private _initialized;
    constructor(name: string, slotsDir: string);
    /** Load slot metadata and environment from disk. */
    load(): Promise<void>;
    /** Slot config/metadata */
    get meta(): SlotMeta;
    /** Alias for meta — backward compat */
    get config(): SlotMeta;
    /** Check if slot has been loaded */
    isInitialized(): boolean;
    exists(): boolean;
    isEphemeral(): boolean;
    isExpired(): boolean;
    get configDir(): string;
    get logsDir(): string;
    get stateDir(): string;
    get tmpDir(): string;
    /** Env vars that expose slot directories */
    getSlotEnvVars(): Record<string, string>;
    /** Start file watching on the slot directory */
    enableWatchers(): void;
    /** Get the watcher (if enabled) */
    get watcher(): SlotWatcher | null;
    /** Wire watcher events through the Slot EventEmitter */
    private _wireWatcherEvents;
    /**
     * Resolve external env var sources for this slot.
     *
     * Runs in order:
     *   1. DNS TXT provisioning (declared values, silent on failure)
     *   2. Vault secret resolution (overrides, refresh:true always re-fetched)
     *
     * @param repoRoot - Repo root path (needed for vault var scanning)
     * @returns Vault refresh result (DNS is silent)
     */
    resolve(repoRoot?: string): Promise<RefreshResult>;
    /**
     * DNS TXT provisioning — queries `_hub.<searchDomain>` for KEY=value pairs.
     * Silent on failure. Uses disk-based TTL cache.
     */
    private resolveDns;
    /** Close slot — stop watchers, remove listeners */
    close(): Promise<void>;
    /** Alias for close */
    shutdown(): Promise<void>;
}
