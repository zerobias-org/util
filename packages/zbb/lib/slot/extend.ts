import type { Slot } from './Slot.js';
import { SlotEnvironment, type ManifestEntry } from './SlotEnvironment.js';
import { scanEnvDeclarations, type ScannedVar } from '../env/Scanner.js';
import { allocatePorts } from './PortAllocator.js';
import { resolveAll } from '../env/Resolver.js';
import { generateSecret } from '../env/SecretGen.js';
import { loadRepoConfig } from '../config.js';

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
export async function extendSlot(slot: Slot, repoRoot: string): Promise<ExtendResult> {
  // 1. Scan all declared vars from zbb.yaml files in the repo
  const scanned = await scanEnvDeclarations(repoRoot);

  // 2. Load current slot state
  const currentEnv = slot.env.getAll();
  const currentManifest = slot.env.getManifest();

  // 3. Find vars that are declared but NOT already in the slot
  const missingVars = scanned.filter(v => !(v.name in currentEnv));

  if (missingVars.length === 0) {
    return { extended: false, addedVars: [] };
  }

  // 4. Build existing port allocations map from current manifest
  const existingPortAllocations = new Map<string, number>();
  for (const [name, entry] of Object.entries(currentManifest)) {
    if (entry.type === 'port' && entry.allocated) {
      existingPortAllocations.set(name, entry.allocated);
    }
  }

  // 5. Use slot's own port range (assigned at create time)
  const portRange: [number, number] = slot.meta.portRange ?? [15000, 16000];

  // 6. Separate missing vars by type
  const missingPortVars = missingVars.filter(v => v.declaration.type === 'port');
  const missingSecretVars = missingVars.filter(v => v.declaration.type === 'secret' && v.declaration.generate);
  const missingInheritedVars = missingVars.filter(v => v.declaration.source === 'env');

  // 7. Allocate ports for missing port vars
  //    Pass ALL port vars (existing + missing) so allocatePorts can skip existing
  const allPortVars = scanned.filter(v => v.declaration.type === 'port');
  const portAllocations = allocatePorts(allPortVars, portRange, existingPortAllocations);

  // 8. Generate secrets for missing secret vars
  //    Build existing secrets map from current env
  const existingSecrets = new Map<string, string>();
  for (const [name, entry] of Object.entries(currentManifest)) {
    if (entry.type === 'secret') {
      existingSecrets.set(name, currentEnv[name] ?? '');
    }
  }
  const newSecrets = new Map<string, string>();
  for (const v of missingSecretVars) {
    const value = generateSecret(v.declaration.generate!, existingSecrets);
    newSecrets.set(v.name, value);
    existingSecrets.set(v.name, value); // available for rsa_public derivation
  }

  // 9. Collect inherited vars from process.env
  const newInherited = new Map<string, string>();
  for (const v of missingInheritedVars) {
    const value = process.env[v.name];
    if (value) newInherited.set(v.name, value);
  }

  // 10. Build pre-resolved map: existing env + new ports + new secrets + new inherited
  const preResolved = new Map<string, string>();
  for (const [k, v] of Object.entries(currentEnv)) preResolved.set(k, v);
  for (const alloc of portAllocations) {
    if (!preResolved.has(alloc.name)) {
      preResolved.set(alloc.name, String(alloc.port));
    }
  }
  for (const [k, v] of newSecrets) preResolved.set(k, v);
  for (const [k, v] of newInherited) preResolved.set(k, v);

  // 11. Collect missing derived/string vars (those not yet in preResolved)
  const derivedVars = new Map<string, string>();
  for (const v of missingVars) {
    if (preResolved.has(v.name)) continue;
    if (v.declaration.deprecated) continue;
    const defaultVal = v.declaration.default;
    if (defaultVal !== undefined) {
      derivedVars.set(v.name, defaultVal);
    }
  }

  // 12. Resolve derived vars
  const resolved = resolveAll(derivedVars, preResolved);

  // 13. Build new env entries and manifest entries (ONLY for missing vars)
  const newEnv = new Map<string, string>();
  const newManifest = new Map<string, ManifestEntry>();
  const addedVars: string[] = [];

  // New ports
  for (const alloc of portAllocations) {
    if (alloc.name in currentEnv) continue; // skip existing
    newEnv.set(alloc.name, String(alloc.port));
    newManifest.set(alloc.name, {
      source: alloc.source,
      type: 'port',
      allocated: alloc.port,
    });
    addedVars.push(alloc.name);
  }

  // New secrets
  for (const v of missingSecretVars) {
    newEnv.set(v.name, newSecrets.get(v.name)!);
    newManifest.set(v.name, {
      source: v.source,
      type: 'secret',
      mask: true,
      generated: v.declaration.generate,
    });
    addedVars.push(v.name);
  }

  // New inherited
  for (const v of missingInheritedVars) {
    const value = newInherited.get(v.name);
    if (value) {
      newEnv.set(v.name, value);
      newManifest.set(v.name, {
        source: v.source,
        type: 'inherited',
        mask: v.declaration.mask ?? false,
      });
      addedVars.push(v.name);
    }
  }

  // New derived / string defaults
  for (const r of resolved) {
    if (r.name in currentEnv) continue; // safety: skip existing
    newEnv.set(r.name, r.value);
    const scanEntry = scanned.find(s => s.name === r.name);
    newManifest.set(r.name, {
      source: scanEntry?.source ?? 'unknown',
      type: scanEntry?.declaration.type ?? 'string',
      derived: r.derived,
      mask: scanEntry?.declaration.mask ?? false,
    });
    addedVars.push(r.name);
  }

  if (newEnv.size === 0) {
    return { extended: false, addedVars: [] };
  }

  // 14. Append to slot .env and manifest (never overwriting existing)
  await SlotEnvironment.appendDeclaredEnv(slot.path, newEnv, newManifest);

  // 15. Reload slot so caller sees updated env
  await slot.env.load();

  return { extended: true, addedVars };
}
