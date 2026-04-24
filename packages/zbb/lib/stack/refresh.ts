import type { Slot } from '../slot/Slot.js';
import type { Stack } from './Stack.js';
import { scanEnvDeclarations } from '../env/Scanner.js';
import { resolveVaultRef, clearVaultCache, verifyVaultConnection } from '../env/VaultResolver.js';
import { loadProjectConfig } from '../config.js';
import { join } from 'node:path';

export interface RefreshResult {
  refreshed: string[];
  errors: Array<{ name: string; error: string }>;
}

/**
 * Refresh environment variables from their declared external sources
 * for every stack in a slot.
 *
 * Lives under `lib/stack/` because every line of this function is
 * stack-management work — the slot is just the container. It's invoked
 * via `StackManager.refreshAll()`; direct callers should go through
 * that entry point.
 *
 * Three sources are covered:
 *   - `source: file` — re-read the file path (e.g. ~/.vault-token). Per-stack.
 *   - `source: env`  — re-read from process.env. Per-stack.
 *   - `source: vault` — re-fetch from Vault. Per-repo-root scan.
 *
 * User overrides (manifest entry with resolution === 'override') are
 * never clobbered; a refresh leaves them alone so an explicit
 * `zbb env set` wins over any external source.
 *
 * Iteration model:
 *   - File/env: walks every stack via `slot.stacks.list()`, calling
 *     `stack.env.refreshSourcedVars()` per stack. Each stack updates
 *     its own inherited manifest entry in place.
 *   - Vault: scans the repo-root zbb.yaml for vault-declared vars and
 *     writes them as overrides on the given stack. Without a stack
 *     context, vault vars are silently skipped — they'll refresh when
 *     a command dispatches with the owning stack in scope.
 */
export async function refreshStackEnv(
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

  // Without a stack context we have nowhere to write vault vars — skip
  // silently; they refresh when the owning stack comes into scope.
  if (!stack) {
    return { refreshed, errors };
  }

  // Filter to just the vault vars we actually need to fetch. A vault
  // var needs fetching if `refresh: true` is declared (always re-pull)
  // OR its current value is undefined. This lets us skip the vault
  // connection check entirely in CI, where vault-action pre-populates
  // process.env with all the secrets — the StackEnvironment CI snapshot
  // picks them up without ever touching vault from zbb.
  const toFetch = vaultVars.filter(v => {
    const currentValue = stack.env.get(v.name);
    return v.declaration.refresh === true || currentValue === undefined;
  });

  if (toFetch.length === 0) {
    return { refreshed, errors };
  }

  // Verify vault connection — only reached when we genuinely need to fetch.
  try {
    await verifyVaultConnection();
  } catch (e: unknown) {
    errors.push({
      name: 'vault-connection',
      error: e instanceof Error ? e.message : String(e),
    });
    return { refreshed, errors };
  }

  for (const v of toFetch) {
    try {
      const value = await resolveVaultRef(v.declaration.vault!);
      // setFromSource records `resolution: 'inherited'` + `source:
      // 'vault:<path>'` so subsequent `zbb env list` shows the vault
      // provenance and the entry isn't treated as a sticky user
      // override. The prior call here was `stack.env.set()`, which
      // hardcoded `resolution: 'override'` + `set_by: 'user'` —
      // making every vault refresh look like a manual user override.
      await stack.env.setFromSource(v.name, value, `vault:${v.declaration.vault!}`);
      refreshed.push(v.name);
    } catch (e: unknown) {
      errors.push({ name: v.name, error: e instanceof Error ? e.message : String(e) });
    }
  }

  return { refreshed, errors };
}
