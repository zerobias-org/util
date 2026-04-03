import { scanEnvDeclarations } from '../env/Scanner.js';
import { resolveVaultRef, clearVaultCache, verifyVaultConnection } from '../env/VaultResolver.js';
import { loadProjectConfig } from '../config.js';
import { join } from 'node:path';
/**
 * Refresh vault-sourced env vars.
 *
 * - refresh: true vars are always re-fetched
 * - refresh: false (or omitted) vars are only fetched if not yet set
 * - Multiple vars sharing the same vault base path make one Vault call (cache)
 * - Values are written as overrides (ephemeral, not in .env)
 */
export async function refreshVaultVars(slot, repoRoot) {
    clearVaultCache();
    const projectConfig = await loadProjectConfig(process.cwd());
    const inherit = projectConfig.inherit !== false;
    const scanned = inherit
        ? await scanEnvDeclarations(repoRoot)
        : await scanEnvDeclarations(process.cwd(), join(process.cwd(), 'zbb.yaml'));
    const vaultVars = scanned.filter(v => v.declaration.source === 'vault' && v.declaration.vault);
    if (vaultVars.length === 0) {
        return { refreshed: [], errors: [] };
    }
    // Verify vault connection before attempting any secret fetches
    try {
        await verifyVaultConnection();
    }
    catch (e) {
        return {
            refreshed: [],
            errors: [{ name: 'vault-connection', error: e.message }],
        };
    }
    const refreshed = [];
    const errors = [];
    for (const v of vaultVars) {
        const currentValue = slot.env.get(v.name);
        if (!v.declaration.refresh && currentValue !== undefined)
            continue;
        try {
            const value = await resolveVaultRef(v.declaration.vault);
            await slot.env.set(v.name, value, v.declaration.mask ?? true);
            refreshed.push(v.name);
        }
        catch (e) {
            errors.push({ name: v.name, error: e.message });
        }
    }
    return { refreshed, errors };
}
