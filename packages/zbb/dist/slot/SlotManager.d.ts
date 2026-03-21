import { Slot } from './Slot.ts';
export interface CreateOptions {
    ephemeral?: boolean;
    ttl?: number;
    repoRoot?: string;
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
    /** Delete a slot. */
    static delete(name: string): Promise<void>;
    /** Garbage collect expired ephemeral slots. Returns names of deleted slots. */
    static gc(): Promise<string[]>;
}
