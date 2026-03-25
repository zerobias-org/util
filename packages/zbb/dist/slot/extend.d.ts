import type { Slot } from './Slot.js';
export interface ExtendResult {
    extended: boolean;
    addedVars: string[];
}
/**
 * Lazy slot extension: scans the given repoRoot for env declarations,
 * finds vars missing from the slot, and appends them.
 *
 * - Port-type vars get allocated from the port range (skipping existing allocations)
 * - Secret-type vars get generated
 * - Inherited vars (source: env) are read from process.env
 * - Derived/string vars are resolved via ${VAR} interpolation
 * - Existing vars are NEVER overwritten
 * - Second call is a no-op (idempotent)
 */
export declare function extendSlot(slot: Slot, repoRoot: string): Promise<ExtendResult>;
