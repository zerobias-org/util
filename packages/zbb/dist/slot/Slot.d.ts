import { EventEmitter } from 'node:events';
import { SlotEnvironment } from './SlotEnvironment.js';
import { SlotWatcher } from './SlotWatcher.js';
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
    readonly env: SlotEnvironment;
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
    /** Close slot — stop watchers, remove listeners */
    close(): Promise<void>;
    /** Alias for close */
    shutdown(): Promise<void>;
}
