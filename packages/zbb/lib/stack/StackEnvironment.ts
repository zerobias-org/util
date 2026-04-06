/**
 * Per-stack environment management — three-layer model.
 *
 * Layer 1 (Schema):   Declared in zbb.yaml — types, formulas, descriptions
 * Layer 2 (Manifest): Per-var provenance in manifest.yaml — source of truth
 * Layer 3 (.env):     Computed key=value output — never edited directly
 */

import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { extractRefs, interpolate } from '../env/Resolver.js';
import { loadYamlOrDefault, saveYaml } from '../yaml.js';
import type { EnvVarDeclaration, StackManifest } from '../config.js';
import type { StackManifestEntry, Resolution, ExplainResult, ImportSpec } from './types.js';

const SENSITIVE_PATTERNS = [
  /key$/i, /secret$/i, /token$/i, /password$/i,
  /pass$/i, /credential/i, /jwt$/i,
];

/**
 * Manages a single stack's environment within a slot.
 */
export class StackEnvironment extends EventEmitter {
  private manifest = new Map<string, StackManifestEntry>();
  private schema = new Map<string, EnvVarDeclaration>();
  private env = new Map<string, string>();
  readonly stackDir: string;

  constructor(stackDir: string) {
    super();
    this.stackDir = stackDir;
  }

  private get envPath() { return join(this.stackDir, '.env'); }
  private get manifestPath() { return join(this.stackDir, 'manifest.yaml'); }

  // ── Loading ─────────────────────────────────────────────────

  async load(): Promise<void> {
    if (existsSync(this.envPath)) {
      this.env = parseEnvFile(await readFile(this.envPath, 'utf-8'));
    }
    if (existsSync(this.manifestPath)) {
      const raw = await loadYamlOrDefault<Record<string, StackManifestEntry>>(this.manifestPath, {});
      this.manifest = new Map(Object.entries(raw));
    }

    // Load schema (Layer 1) from zbb.yaml.
    // Three-layer model: Schema (zbb.yaml) + Manifest (provenance) + .env (values).
    // Schema is authoritative for type, values, description, formulas.
    // stack.yaml source field tells us where zbb.yaml lives (packaged mode).
    const stackYamlPath = join(this.stackDir, 'stack.yaml');
    if (!existsSync(stackYamlPath)) {
      throw new Error(`stack.yaml not found at ${stackYamlPath} — StackEnvironment requires a stack context`);
    }
    const identity = await loadYamlOrDefault<{ source?: string }>(stackYamlPath, {});
    const schemaDir = identity.source ?? this.stackDir;
    const zbbYamlPath = join(schemaDir, 'zbb.yaml');
    if (!existsSync(zbbYamlPath)) {
      throw new Error(`zbb.yaml not found at ${zbbYamlPath} (source: ${schemaDir}) — Layer 1 schema is required`);
    }
    const config = await loadYamlOrDefault<{ env?: Record<string, EnvVarDeclaration> }>(zbbYamlPath, {});
    if (!config.env) {
      throw new Error(`zbb.yaml at ${zbbYamlPath} has no env declarations`);
    }
    this.schema = new Map(Object.entries(config.env));
  }

  // ── Getting ─────────────────────────────────────────────────

  get(key: string): string | undefined {
    return this.env.get(key);
  }

  getAll(): Record<string, string> {
    return Object.fromEntries(this.env);
  }

  getMasked(key: string): string | undefined {
    const value = this.env.get(key);
    if (value === undefined) return undefined;
    return this.shouldMask(key) ? '***MASKED***' : value;
  }

  getAllMasked(): Record<string, string> {
    const result: Record<string, string> = {};
    for (const [k, v] of this.env) {
      result[k] = this.shouldMask(k) ? '***MASKED***' : v;
    }
    return result;
  }

  list(): string[] {
    return [...this.env.keys()].sort();
  }

  shouldMask(key: string): boolean {
    const entry = this.manifest.get(key);
    if (entry?.mask) return true;
    if (entry?.type === 'secret') return true;
    return SENSITIVE_PATTERNS.some(p => p.test(key));
  }

  getManifestEntry(key: string): StackManifestEntry | undefined {
    const entry = this.manifest.get(key);
    if (!entry) return undefined;
    // Enrich with schema data — schema is authoritative for type, values, description
    const decl = this.schema.get(key);
    if (decl) {
      return {
        ...entry,
        type: decl.type ?? entry.type,
        values: decl.values ?? entry.values,
        description: decl.description ?? entry.description,
      };
    }
    return entry;
  }

  getManifest(): Record<string, StackManifestEntry> {
    const result: Record<string, StackManifestEntry> = {};
    for (const key of this.manifest.keys()) {
      result[key] = this.getManifestEntry(key)!;
    }
    return result;
  }

  // ── Setting (overrides) ─────────────────────────────────────

  async set(key: string, value: string): Promise<void> {
    const existing = this.manifest.get(key);
    this.manifest.set(key, {
      ...existing,
      resolution: 'override',
      value,
      set_by: 'user',
      set_at: new Date().toISOString(),
      default_formula: existing?.formula ?? existing?.default_formula,
    } as StackManifestEntry);
    await this.saveManifest();
    await this.recalculate();
    this.emit('change', { key, value });
  }

  async unset(key: string): Promise<void> {
    const entry = this.manifest.get(key);
    if (!entry) return;
    if (entry.resolution === 'override' && entry.default_formula) {
      // Revert to derived
      this.manifest.set(key, {
        ...entry,
        resolution: 'derived',
        formula: entry.default_formula,
        value: undefined,
        set_by: undefined,
        set_at: undefined,
      } as StackManifestEntry);
    } else if (entry.resolution === 'override') {
      this.manifest.delete(key);
    }
    await this.saveManifest();
    await this.recalculate();
    this.emit('change', { key, value: undefined });
  }

  // ── Recalculate .env from manifest ──────────────────────────

  /**
   * Recompute .env from manifest entries.
   * Reads imported values from dependency stacks' .env files.
   *
   * @param slotStacksDir - Path to the slot's stacks/ directory (for reading dep .env files)
   */
  async recalculate(slotStacksDir?: string): Promise<void> {
    const preResolved = new Map<string, string>();
    const derivedVars = new Map<string, string>();

    for (const [key, entry] of this.manifest) {
      switch (entry.resolution) {
        case 'override':
          preResolved.set(key, entry.value!);
          break;

        case 'imported': {
          // Read from dependency stack's .env
          if (slotStacksDir && entry.from) {
            const depEnvPath = join(slotStacksDir, entry.from, '.env');
            if (existsSync(depEnvPath)) {
              const depEnv = parseEnvFile(await readFile(depEnvPath, 'utf-8'));
              const srcKey = entry.original_name ?? key;
              const val = depEnv.get(srcKey);
              if (val !== undefined) preResolved.set(key, val);
            }
          }
          break;
        }

        case 'allocated':
        case 'generated':
        case 'inherited':
          if (entry.value !== undefined) preResolved.set(key, entry.value);
          break;

        case 'derived':
          if (entry.formula) {
            derivedVars.set(key, entry.formula);
          } else if (entry.value !== undefined) {
            preResolved.set(key, entry.value);
          }
          break;

        case 'default':
          if (entry.value !== undefined) preResolved.set(key, entry.value);
          break;
      }
    }

    // Resolve derived vars using topo-sort
    if (derivedVars.size > 0) {
      const { resolveAll } = await import('../env/Resolver.js');
      const resolved = resolveAll(derivedVars, preResolved);
      for (const r of resolved) {
        preResolved.set(r.name, r.value);
        // Update manifest inputs
        const entry = this.manifest.get(r.name);
        if (entry?.formula) {
          const refs = extractRefs(entry.formula);
          const inputs: Record<string, string> = {};
          for (const ref of refs) {
            if (preResolved.has(ref)) inputs[ref] = preResolved.get(ref)!;
          }
          entry.inputs = inputs;
        }
      }
    }

    // Write .env
    this.env = preResolved;
    await writeFile(this.envPath, serializeEnv(this.env), 'utf-8');
  }

  // ── Explain ─────────────────────────────────────────────────

  explain(key: string, schema?: Record<string, EnvVarDeclaration>): ExplainResult {
    const entry = this.manifest.get(key);
    const decl = schema?.[key];
    return {
      name: key,
      type: entry?.type ?? decl?.type,
      description: entry?.description ?? decl?.description,
      resolution: entry?.resolution ?? 'default',
      formula: entry?.formula,
      inputs: entry?.inputs,
      current: this.env.get(key),
      source: entry?.source,
      from: entry?.from,
      original_name: entry?.original_name,
      overridable: entry?.resolution !== 'imported',
    };
  }

  // ── Static: Initialize during stack add ─────────────────────

  /**
   * Build initial manifest and .env for a newly added stack.
   *
   * @param stackDir - Stack directory in slot
   * @param schema - Env var declarations from zbb.yaml
   * @param ports - Allocated ports (name → port number)
   * @param secrets - Generated secrets (name → value)
   * @param imports - Resolved import specs
   * @param slotVars - Slot-level vars (ZB_SLOT, etc.)
   * @param slotStacksDir - Path to slot's stacks/ dir
   */
  static async initialize(
    stackDir: string,
    schema: Record<string, EnvVarDeclaration>,
    ports: Map<string, number>,
    secrets: Map<string, string>,
    imports: ImportSpec[],
    slotVars: Record<string, string>,
    slotStacksDir: string,
    sourcePath?: string,
  ): Promise<StackEnvironment> {
    const manifest = new Map<string, StackManifestEntry>();

    // Slot vars as inherited
    for (const [key, value] of Object.entries(slotVars)) {
      manifest.set(key, {
        resolution: 'inherited',
        value,
        source: 'slot',
        type: 'string',
      });
    }

    // Ports
    for (const [name, port] of ports) {
      manifest.set(name, {
        resolution: 'allocated',
        value: String(port),
        source: schema[name] ? 'schema' : 'allocated',
        type: 'port',
        description: schema[name]?.description,
      });
    }

    // Secrets
    for (const [name, value] of secrets) {
      manifest.set(name, {
        resolution: 'generated',
        value,
        generator: schema[name]?.generate,
        source: 'schema',
        type: 'secret',
        mask: true,
        description: schema[name]?.description,
      });
    }

    // Inherited from parent env
    for (const [name, decl] of Object.entries(schema)) {
      if (decl.source === 'env') {
        const value = process.env[name];
        if (value !== undefined) {
          manifest.set(name, {
            resolution: 'inherited',
            value,
            source: 'env',
            type: decl.type,
            values: decl.values,
            mask: decl.mask,
            description: decl.description,
          });
        } else if (decl.required) {
          throw new Error(`Required env var '${name}' not found in environment`);
        }
      }
    }

    // CWD-resolved vars — resolve to the stack source directory
    for (const [name, decl] of Object.entries(schema)) {
      if (manifest.has(name)) continue;
      if (decl.source === 'cwd') {
        const value = sourcePath ?? process.cwd();
        manifest.set(name, {
          resolution: 'inherited',
          value,
          source: 'cwd',
          type: decl.type,
          values: decl.values,
          description: decl.description,
        });
      }
    }

    // File-sourced vars — read value from a file, fall back to env var then default
    for (const [name, decl] of Object.entries(schema)) {
      if (manifest.has(name)) continue;
      if (decl.source === 'file' && decl.file) {
        const { homedir } = await import('node:os');
        const filePath = decl.file.replace(/^~/, homedir());
        let value: string | undefined;
        try {
          value = (await readFile(filePath, 'utf-8')).trim();
        } catch {
          // File not found — fall back to env var
          value = process.env[name];
        }
        if (value) {
          manifest.set(name, {
            resolution: 'inherited',
            value,
            source: `file:${decl.file}`,
            type: decl.type,
            values: decl.values,
            mask: decl.mask,
            description: decl.description,
          });
        } else if (decl.required) {
          throw new Error(`Required var '${name}' not found in file '${decl.file}' or environment`);
        }
      }
    }

    // Imports from dependency stacks
    for (const imp of imports) {
      const depEnvPath = join(slotStacksDir, imp.fromStack, '.env');
      let value: string | undefined;
      if (existsSync(depEnvPath)) {
        const depEnv = parseEnvFile(await readFile(depEnvPath, 'utf-8'));
        value = depEnv.get(imp.varName);
      }
      const localName = imp.alias ?? imp.varName;
      manifest.set(localName, {
        resolution: 'imported',
        value,
        from: imp.fromStack,
        original_name: imp.alias ? imp.varName : undefined,
        type: 'string',
      });
    }

    // Defaults (frozen at add time — resolve refs immediately and store final value)
    for (const [name, decl] of Object.entries(schema)) {
      if (manifest.has(name)) continue; // already handled
      if (decl.default !== undefined && !decl.value) {
        const refs = extractRefs(decl.default);
        if (refs.length === 0) {
          // No refs — literal value
          manifest.set(name, {
            resolution: 'default',
            value: decl.default,
            source: 'schema',
            type: decl.type,
            values: decl.values,
            description: decl.description,
            mask: decl.mask,
          });
        } else {
          // Default with refs — compute once now, freeze the result
          // Collect all currently known values for interpolation
          const knownValues = new Map<string, string>();
          for (const [k, entry] of manifest) {
            if (entry.value !== undefined) knownValues.set(k, entry.value);
          }
          try {
            const frozen = interpolate(decl.default, knownValues);
            manifest.set(name, {
              resolution: 'default',
              value: frozen,
              default_formula: decl.default,
              source: 'schema',
              type: decl.type,
            values: decl.values,
              description: decl.description,
              mask: decl.mask,
            });
          } catch {
            // If interpolation fails (ref not yet available), store as derived instead
            // so recalculate() can resolve it
            manifest.set(name, {
              resolution: 'derived',
              formula: decl.default,
              source: 'schema',
              type: decl.type,
            values: decl.values,
              description: decl.description,
              mask: decl.mask,
            });
          }
        }
      }
    }

    // Derived (live formulas)
    for (const [name, decl] of Object.entries(schema)) {
      if (manifest.has(name)) continue;
      if (decl.value) {
        manifest.set(name, {
          resolution: 'derived',
          formula: decl.value,
          source: 'schema',
          type: decl.type,
          values: decl.values,
          description: decl.description,
          mask: decl.mask,
        });
      }
    }

    // Write manifest
    await saveYaml(join(stackDir, 'manifest.yaml'), Object.fromEntries(manifest));

    // Create env instance, set manifest, recalculate
    const env = new StackEnvironment(stackDir);
    env.manifest = manifest;
    await env.recalculate(slotStacksDir);

    return env;
  }

  // ── Private helpers ─────────────────────────────────────────

  private async saveManifest(): Promise<void> {
    await saveYaml(this.manifestPath, Object.fromEntries(this.manifest));
  }
}

// ── Env file parsing (same format as SlotEnvironment) ───────

function parseEnvFile(content: string): Map<string, string> {
  const env = new Map<string, string>();
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx === -1) continue;
    env.set(trimmed.slice(0, idx).trim(), trimmed.slice(idx + 1).trim());
  }
  return env;
}

function serializeEnv(env: Map<string, string>): string {
  const lines: string[] = [];
  for (const key of [...env.keys()].sort()) {
    lines.push(`${key}=${env.get(key)}`);
  }
  return lines.join('\n') + '\n';
}
