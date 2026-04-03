import type { Slot } from './Slot.js';
export interface RefreshResult {
    refreshed: string[];
    errors: Array<{
        name: string;
        error: string;
    }>;
}
/**
 * Refresh vault-sourced env vars.
 *
 * - refresh: true vars are always re-fetched
 * - refresh: false (or omitted) vars are only fetched if not yet set
 * - Multiple vars sharing the same vault base path make one Vault call (cache)
 * - Values are written as overrides (ephemeral, not in .env)
 */
export declare function refreshVaultVars(slot: Slot, repoRoot: string): Promise<RefreshResult>;
