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
 * Refresh environment variables from their declared external sources.
 *
 * Three sources are covered:
 *   - `source: file` — re-read the file path (e.g. ~/.vault-token). Per-stack.
 *   - `source: env`  — re-read from process.env. Per-stack.
 *   - `source: vault` — re-fetch from Vault. Per-repo-root scan (current
 *      behavior preserved for back-compat).
 *
 * User overrides (manifest entry with resolution === 'override') are never
 * clobbered; a refresh leaves them alone so that an explicit `zbb env set`
 * wins over any external source.
 *
 * Iteration model:
 *   - File/env: walks every stack added to the slot via slot.stacks.list(),
 *     calling stack.env.refreshSourcedVars() per stack. Each stack updates
 *     its own inherited manifest entry in place, preserving resolution type.
 *     This matches where the initial read happens (StackEnvironment.initialize).
 *   - Vault: scans the repo-root zbb.yaml for vault-declared vars. Slot-level
 *     vars (ZBB_SLOT_VARS) write to slot.env; the rest write to stack.env as
 *     overrides when a stack context is provided. Without a stack, non-slot
 *     vault vars are silently skipped — they'll be refreshed on the next
 *     command dispatched in the owning stack's scope.
 */
export async function refreshVaultVars(
  slot: Slot,
  repoRoot: string,
  stack?: Stack | null,
): Promise<RefreshResult> {
  const refreshed: string[] = [];
  const errors: Array<{ name: string; error: string }> = [];

  // ── 1. Per-stack file/env refresh ──
  // Walks every added stack so a var declared in (e.g.) hub's stack/zbb.yaml
  // with `source: file, file: ~/.vault-token` is picked up independently of
  // which cwd the user ran `zbb env refresh` from.
  try {
    const stacks = await slot.stacks.list();
    for (const s of stacks) {
      try {
        const result = await s.env.refreshSourcedVars();
        for (const name of result.refreshed) {
          refreshed.push(`${s.name}.${name}`);
        }
        for (const err of result.errors) {
          errors.push({ name: `${s.name}.${err.name}`, error: err.error });
        }
      } catch (e: unknown) {
        // If a single stack fails to refresh (e.g. missing zbb.yaml source),
        // record the error and keep going for the others.
        errors.push({
          name: `${s.name}`,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }
  } catch (e: unknown) {
    errors.push({
      name: 'stacks-list',
      error: e instanceof Error ? e.message : String(e),
    });
  }

  // ── 2. Vault refresh (repo-root scan) ──
  clearVaultCache();

  const projectConfig = await loadProjectConfig(process.cwd());
  const inherit = projectConfig.inherit !== false;
  const scanned = inherit
    ? await scanEnvDeclarations(repoRoot)
    : await scanEnvDeclarations(process.cwd(), join(process.cwd(), 'zbb.yaml'));

  const vaultVars = scanned.filter(v => v.declaration.source === 'vault' && v.declaration.vault);

  if (vaultVars.length === 0) {
    return { refreshed, errors };
  }

  // Verify vault connection before attempting any secret fetches
  try {
    await verifyVaultConnection();
  } catch (e: unknown) {
    errors.push({
      name: 'vault-connection',
      error: e instanceof Error ? e.message : String(e),
    });
    return { refreshed, errors };
  }

  for (const v of vaultVars) {
    // Determine the write target for this var:
    //   - ZBB_SLOT_VARS → slot.env
    //   - Anything else → stack.env if a stack is available, otherwise skip
    //     (not a fatal error — the var will be refreshed when a command
    //     dispatches with the owning stack in scope).
    const isSlotVar = isSlotLevelVar(v.name);
    if (!isSlotVar && !stack) {
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
    } catch (e: unknown) {
      errors.push({ name: v.name, error: e instanceof Error ? e.message : String(e) });
    }
  }

  return { refreshed, errors };
}
