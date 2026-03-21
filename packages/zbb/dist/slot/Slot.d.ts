import { SlotEnvironment } from './SlotEnvironment.ts';
export interface SlotMeta {
    name: string;
    created: string;
    ephemeral?: boolean;
    ttl?: number;
    expires?: string;
    portRange?: [number, number];
}
/**
 * A loaded slot instance. Provides access to env, manifest, and slot metadata.
 */
export declare class Slot {
    readonly name: string;
    readonly path: string;
    readonly env: SlotEnvironment;
    private _meta;
    constructor(name: string, slotsDir: string);
    /** Load slot metadata and environment from disk. */
    load(): Promise<void>;
    get meta(): SlotMeta;
    exists(): boolean;
    isEphemeral(): boolean;
    isExpired(): boolean;
    /** Slot directory sub-paths */
    get configDir(): string;
    get logsDir(): string;
    get stateDir(): string;
    get tmpDir(): string;
    /** Env vars that expose slot directories */
    getSlotEnvVars(): Record<string, string>;
}
