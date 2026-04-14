import type { Slot } from './Slot.js';
import type { Stack } from '../stack/Stack.js';
import { scanEnvDeclarations } from '../env/Scanner.js';
import { resolveVaultRef, clearVaultCache, verifyVaultConnection } from '../env/VaultResolver.js';
import { loadProjectConfig } from '../config.js';
import { isSlotLevelVar } from './SlotEnvironment.js';
import { join } from 'node:path';

export interface RefreshResult {
  refreshed: string[];
  errors: Array<{ name: string; error: string }>;
}

/**
 * Refresh vault-sourced env vars.
 *
 * Architecture:
 *   - Vault-sourced vars declared in a STACK's zbb.yaml are stack-owned.
 *     When a stack context is available, vault values are written to that
 *     stack's env, not to the slot. This is consistent with the rest of
 *     the new-architecture rule: slot holds identity, stacks hold the
 *     real values.
 *   - If no stack context is available (e.g. `zbb slot load` without a
 *     specific stack loaded), vault vars that aren't slot-level are
 *     silently skipped rather than throwing — they'll be refreshed later
 *     when a command dispatches with the relevant stack in scope.
 *   - Slot-level vars (the canonical ZBB_SLOT_VARS set) are always safe
 *     to write to `slot.env.set()`, so those go through the slot.
 *
 * - refresh: true vars are always re-fetched
 * - refresh: false (or omitted) vars are only fetched if not yet set
 * - Multiple vars sharing the same vault base path make one Vault call (cache)
 */
export async function refreshVaultVars(
  slot: Slot,
  repoRoot: string,
  stack?: Stack | null,
): Promise<RefreshResult> {
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
  } catch (e: any) {
    return {
      refreshed: [],
      errors: [{ name: 'vault-connection', error: e.message }],
    };
  }

  const refreshed: string[] = [];
  const errors: Array<{ name: string; error: string }> = [];

  for (const v of vaultVars) {
    // Determine the write target for this var:
    //   - ZBB_SLOT_VARS → slot.env
    //   - Anything else → stack.env if a stack is available, otherwise skip
    //     (not a fatal error — the var will be refreshed when a command
    //     dispatches with the owning stack in scope).
    const isSlotVar = isSlotLevelVar(v.name);
    if (!isSlotVar && !stack) {
      // Skip non-slot vault vars without a stack context. The stack will
      // handle them the next time a command runs in its scope.
      continue;
    }

    const currentValue = isSlotVar
      ? slot.env.get(v.name)
      : stack!.env.get(v.name);
    if (!v.declaration.refresh && currentValue !== undefined) continue;

    try {
      const value = await resolveVaultRef(v.declaration.vault!);
      if (isSlotVar) {
        await slot.env.set(v.name, value, v.declaration.mask ?? true);
      } else {
        await stack!.env.set(v.name, value);
      }
      refreshed.push(v.name);
    } catch (e: any) {
      errors.push({ name: v.name, error: e.message });
    }
  }

  return { refreshed, errors };
}
