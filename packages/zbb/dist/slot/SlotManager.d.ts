import { Slot } from './Slot.js';
export interface CreateOptions {
    ephemeral?: boolean;
    ttl?: number;
    repoRoot?: string;
    portRange?: [number, number];
}
export declare class SlotManager {
    /**
     * Create a new slot.
     * Scans zbb.yaml files, allocates ports, generates secrets, resolves vars.
     */
    static create(name: string, options?: CreateOptions): Promise<Slot>;
    /** List all slots. */
    static list(): Promise<Slot[]>;
    /** Load an existing slot by name. */
    static load(name: string): Promise<Slot>;
    /** Delete a slot. Returns summary of what was cleaned up. */
    static delete(name: string): Promise<{
        containers: number;
        volumes: number;
    }>;
    /** Garbage collect expired ephemeral slots. Returns names of deleted slots. */
    static gc(): Promise<string[]>;
}
