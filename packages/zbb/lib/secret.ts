/**
 * zbb secret — slot-scoped secret management
 *
 * Secrets are YAML files at ${ZB_SLOT_STATE}/secrets/<name>.yml
 * Each file is a complete connection profile with optional metadata.
 * Values can contain refs ({{env.VAR}}) resolved at read time by `get`.
 *
 * Commands: create, get, list, update, delete
 */

import { join } from 'node:path';
import { existsSync, mkdirSync, readdirSync, unlinkSync, readFileSync, writeFileSync } from 'node:fs';
import { parse as yamlParse, stringify } from 'yaml';
import type { Slot } from './slot/Slot.js';

const SUPPORTED_EXTENSIONS = ['yml', 'yaml', 'json'];
const METADATA_KEYS = ['_module', '_schema', '_id'];

/**
 * Get secrets directory for a slot
 */
function secretsDir(slot: Slot): string {
  return join(slot.stateDir, 'secrets');
}

/**
 * Ensure secrets directory exists
 */
function ensureSecretsDir(slot: Slot): string {
  const dir = secretsDir(slot);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  return dir;
}

/**
 * Find a secret file by name (tries all supported extensions)
 */
function findSecretFile(dir: string, name: string): string | null {
  for (const ext of SUPPORTED_EXTENSIONS) {
    const filePath = join(dir, `${name}.${ext}`);
    if (existsSync(filePath)) return filePath;
  }
  return null;
}

/**
 * Read and parse a secret file
 */
function readSecret(filePath: string): Record<string, unknown> {
  const content = readFileSync(filePath, 'utf-8');
  if (filePath.endsWith('.json')) {
    return JSON.parse(content);
  }
  return yamlParse(content) as Record<string, unknown>;
}

/**
 * Resolve {{env.VAR}} and {{file.name.key}} refs in secret values
 */
function resolveRefs(
  obj: Record<string, unknown>,
  dir: string
): Record<string, unknown> {
  const resolved: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (METADATA_KEYS.includes(key)) continue; // strip metadata
    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (trimmed.startsWith('{{') && trimmed.endsWith('}}')) {
        const ref = trimmed.slice(2, -2);
        resolved[key] = resolveRef(ref, dir);
      } else {
        resolved[key] = value;
      }
    } else {
      resolved[key] = value;
    }
  }
  return resolved;
}

/**
 * Resolve a single ref path like env.NPM_TOKEN or file.other.key
 */
function resolveRef(ref: string, dir: string): unknown {
  const parts = ref.split('.');
  const driver = parts[0];

  switch (driver) {
    case 'env': {
      const varName = parts[1];
      if (!varName) throw new Error(`Invalid env ref: {{${ref}}}`);
      const value = process.env[varName];
      if (value === undefined) throw new Error(`Environment variable not set: ${varName}`);
      return value;
    }
    case 'file': {
      const [, fileName, ...keyPath] = parts;
      if (!fileName || keyPath.length === 0) {
        throw new Error(`Invalid file ref: {{${ref}}}`);
      }
      const filePath = findSecretFile(dir, fileName);
      if (!filePath) throw new Error(`Secret file not found: ${fileName}`);
      const data = readSecret(filePath);
      let current: unknown = data;
      for (const key of keyPath) {
        if (current === null || typeof current !== 'object') {
          throw new Error(`Cannot navigate to ${key} in {{${ref}}}`);
        }
        current = (current as Record<string, unknown>)[key];
        if (current === undefined) {
          throw new Error(`Key not found: ${key} in {{${ref}}}`);
        }
      }
      return current;
    }
    default:
      throw new Error(`Unknown ref driver: ${driver} in {{${ref}}}`);
  }
}

/**
 * Handle `zbb secret` subcommands
 */
export async function handleSecret(args: string[], slot: Slot): Promise<void> {
  const sub = args[0];

  switch (sub) {
    case 'create':
      return secretCreate(args.slice(1), slot);
    case 'get':
      return secretGet(args.slice(1), slot);
    case 'list':
      return secretList(args.slice(1), slot);
    case 'update':
      return secretUpdate(args.slice(1), slot);
    case 'delete':
      return secretDelete(args.slice(1), slot);
    default:
      console.error(`Unknown secret command: ${sub}`);
      console.error('Usage: zbb secret <create|get|list|update|delete>');
      process.exit(1);
  }
}

/**
 * zbb secret create <name> [key=value ...] [@file.yml] [--type @connectionProfile.yml]
 */
async function secretCreate(args: string[], slot: Slot): Promise<void> {
  const name = args[0];
  if (!name || name.startsWith('-') || name.startsWith('@')) {
    console.error('Usage: zbb secret create <name> [key=value ...] [@file.yml] [--type @schema.yml]');
    process.exit(1);
  }

  const dir = ensureSecretsDir(slot);
  const targetPath = join(dir, `${name}.yml`);

  if (existsSync(targetPath)) {
    console.error(`Secret '${name}' already exists. Use 'zbb secret update ${name}' to modify.`);
    process.exit(1);
  }

  const remaining = args.slice(1);
  let data: Record<string, unknown> = {};

  // Check for @file import — must have a file extension to distinguish
  // from npm scoped package names like @auditlogic/module-github-github
  const fileArg = remaining.find(a =>
    a.startsWith('@') && !a.startsWith('@auto') &&
    SUPPORTED_EXTENSIONS.some(ext => a.endsWith(`.${ext}`))
  );
  if (fileArg) {
    const filePath = fileArg.slice(1);
    if (!existsSync(filePath)) {
      console.error(`File not found: ${filePath}`);
      process.exit(1);
    }
    data = readSecret(filePath);
  }

  // Parse key=value pairs (override file values)
  for (const arg of remaining) {
    if (arg.startsWith('-') || arg.startsWith('@')) continue;
    const eqIdx = arg.indexOf('=');
    if (eqIdx === -1) continue;
    const key = arg.slice(0, eqIdx);
    const value = arg.slice(eqIdx + 1);
    data[key] = value;
  }

  // Check for --type @connectionProfile.yml
  const typeIdx = remaining.indexOf('--type');
  if (typeIdx !== -1 && remaining[typeIdx + 1]) {
    const schemaPath = remaining[typeIdx + 1].replace(/^@/, '');
    if (schemaPath === 'auto') {
      // Auto-detect from cwd module
      const cpPath = findConnectionProfile();
      if (cpPath) {
        data._schema = 'connectionProfile.yml';
        await promptForSchema(cpPath, data);
      }
    } else if (existsSync(schemaPath)) {
      data._schema = schemaPath;
      await promptForSchema(schemaPath, data);
    } else {
      console.error(`Schema file not found: ${schemaPath}`);
      process.exit(1);
    }
  }

  // --module flag overrides auto-detection
  const moduleIdx = remaining.indexOf('--module');
  if (moduleIdx !== -1 && remaining[moduleIdx + 1]) {
    data._module = remaining[moduleIdx + 1];
  } else if (!data._module) {
    // Auto-detect module from cwd
    const moduleKey = detectModuleKey();
    if (moduleKey) data._module = moduleKey;
  }

  if (Object.keys(data).filter(k => !METADATA_KEYS.includes(k)).length === 0) {
    console.error('No secret data provided. Use key=value pairs, @file.yml, or --type @schema.yml');
    process.exit(1);
  }

  writeFileSync(targetPath, stringify(data, { lineWidth: -1 }));
  const keyCount = Object.keys(data).filter(k => !METADATA_KEYS.includes(k)).length;
  console.log(`✓ Secret '${name}' created (${keyCount} keys)`);
  console.log(`  ${targetPath}`);
}

/**
 * zbb secret get <name> [key] [--json]
 */
async function secretGet(args: string[], slot: Slot): Promise<void> {
  const name = args[0];
  if (!name) {
    console.error('Usage: zbb secret get <name> [key] [--json] [--id]');
    process.exit(1);
  }

  const dir = secretsDir(slot);
  const filePath = findSecretFile(dir, name);
  if (!filePath) {
    console.error(`Secret not found: ${name}`);
    process.exit(1);
  }

  const raw = readSecret(filePath);

  // --id: return Hub server secret UUID (stored as _id metadata)
  if (args.includes('--id')) {
    const hubId = raw._id as string | undefined;
    if (!hubId) {
      console.error(`Secret '${name}' has no Hub server ID (_id). Create one with: hub-node server secrets create`);
      process.exit(1);
    }
    console.log(hubId);
    return;
  }

  const resolved = resolveRefs(raw, dir);

  const key = args[1] && !args[1].startsWith('-') ? args[1] : null;

  if (key) {
    const value = resolved[key];
    if (value === undefined) {
      console.error(`Key '${key}' not found in secret '${name}'`);
      process.exit(1);
    }
    console.log(typeof value === 'string' ? value : JSON.stringify(value));
  } else {
    console.log(JSON.stringify(resolved, null, 2));
  }
}

/**
 * zbb secret list [--module <key>]
 */
async function secretList(args: string[], slot: Slot): Promise<void> {
  const dir = secretsDir(slot);
  if (!existsSync(dir)) {
    if (args.includes('--json')) {
      console.log('[]');
    } else {
      console.log('No secrets.');
    }
    return;
  }

  const moduleFilter = args.indexOf('--module') !== -1
    ? args[args.indexOf('--module') + 1]
    : null;

  const jsonMode = args.includes('--json');

  const files = readdirSync(dir).filter(f =>
    SUPPORTED_EXTENSIONS.some(ext => f.endsWith(`.${ext}`))
  );

  if (files.length === 0) {
    if (jsonMode) {
      console.log('[]');
    } else {
      console.log('No secrets.');
    }
    return;
  }

  const results: { name: string; module: string; _id?: string }[] = [];
  for (const f of files) {
    const name = f.replace(/\.(yml|yaml|json)$/, '');
    const filePath = join(dir, f);
    const data = readSecret(filePath);
    const module = (data._module as string) ?? '';
    const _id = (data._id as string) ?? undefined;

    if (moduleFilter && module !== moduleFilter) continue;
    results.push({ name, module, _id });
  }

  if (jsonMode) {
    console.log(JSON.stringify(results));
    return;
  }

  console.log('  NAME              MODULE');
  for (const { name, module } of results) {
    console.log(`  ${name.padEnd(18)}${module}`);
  }
}

/**
 * zbb secret update <name> [key=value ...]
 */
async function secretUpdate(args: string[], slot: Slot): Promise<void> {
  const name = args[0];
  if (!name) {
    console.error('Usage: zbb secret update <name> [key=value ...]');
    process.exit(1);
  }

  const dir = secretsDir(slot);
  const filePath = findSecretFile(dir, name);
  if (!filePath) {
    console.error(`Secret not found: ${name}`);
    process.exit(1);
  }

  const data = readSecret(filePath);
  const remaining = args.slice(1);
  let changed = 0;

  for (const arg of remaining) {
    if (arg.startsWith('-')) continue;
    const eqIdx = arg.indexOf('=');
    if (eqIdx === -1) continue;
    const key = arg.slice(0, eqIdx);
    const value = arg.slice(eqIdx + 1);
    if (value === '') {
      delete data[key];
    } else {
      data[key] = value;
    }
    changed += 1;
  }

  if (changed === 0) {
    console.error('No key=value pairs provided.');
    process.exit(1);
  }

  writeFileSync(filePath, stringify(data, { lineWidth: -1 }));
  console.log(`✓ Secret '${name}' updated (${changed} key(s))`);

  // Sync to Hub DB if this secret is linked to a Hub secret (_id)
  const hubId = data._id as string | undefined;
  if (hubId) {
    try {
      const { execSync } = await import('node:child_process');
      const resolved = resolveRefs(data, dir);
      const profileJson = JSON.stringify(resolved);
      execSync(
        `hub-node --json server secrets update ${hubId} --profile '${profileJson.replace(/'/g, "'\\''")}'  --draft false`,
        { stdio: ['pipe', 'pipe', 'pipe'] }
      );
      console.log(`✓ Synced to Hub secret ${hubId}`);
    } catch (err: any) {
      console.warn(`⚠ Failed to sync to Hub: ${err.message}`);
    }
  }
}

/**
 * zbb secret delete <name>
 */
async function secretDelete(args: string[], slot: Slot): Promise<void> {
  const name = args[0];
  if (!name) {
    console.error('Usage: zbb secret delete <name>');
    process.exit(1);
  }

  const dir = secretsDir(slot);
  const filePath = findSecretFile(dir, name);
  if (!filePath) {
    console.error(`Secret not found: ${name}`);
    process.exit(1);
  }

  unlinkSync(filePath);
  console.log(`✓ Secret '${name}' deleted`);
}

// ── Helpers ──────────────────────────────────────────────────

/**
 * Find connectionProfile.yml walking up from cwd
 */
function findConnectionProfile(): string | null {
  let dir = process.cwd();
  while (dir !== '/') {
    const cp = join(dir, 'connectionProfile.yml');
    if (existsSync(cp)) return cp;
    dir = join(dir, '..');
  }
  return null;
}

/**
 * Detect module key from package.json in cwd or ancestors
 */
function detectModuleKey(): string | null {
  let dir = process.cwd();
  while (dir !== '/') {
    const pkg = join(dir, 'package.json');
    if (existsSync(pkg)) {
      try {
        const data = JSON.parse(readFileSync(pkg, 'utf-8'));
        return data.name ?? null;
      } catch { /* ignore */ }
    }
    dir = join(dir, '..');
  }
  return null;
}

/**
 * Prompt for connection profile fields from schema
 * For now: reads schema, adds field names as empty values for user to fill
 * TODO: interactive prompts via readline
 */
async function promptForSchema(
  schemaPath: string,
  data: Record<string, unknown>
): Promise<void> {
  try {
    const content = readFileSync(schemaPath, 'utf-8');
    const schema = yamlParse(content) as Record<string, unknown>;

    // Walk properties and add missing keys
    const properties = (schema as any).properties ?? schema;
    for (const key of Object.keys(properties)) {
      if (key.startsWith('_')) continue;
      if (!(key in data)) {
        // Add placeholder — user must fill via key=value or interactive
        data[key] = '';
      }
    }
  } catch (err: any) {
    console.warn(`Warning: could not read schema: ${err.message}`);
  }
}
