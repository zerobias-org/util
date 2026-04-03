import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

/**
 * Lightweight Vault client using native fetch (Node 22+).
 * Auto-detects engine type from response shape:
 *   - KV v2: response.data.data  (nested)
 *   - AWS/dynamic: response.data (flat)
 *
 * Address: VAULT_ADDR env var (required — set by `vault login` or slot env)
 * Token: VAULT_TOKEN env var or ~/.vault-token (written by `vault login`)
 */

// Cache per base path (everything before the last dot in the vault ref).
// Multiple env vars sharing the same base path hit Vault once.
const cache = new Map<string, Record<string, string>>();

/**
 * Resolve Vault token. Prefers ~/.vault-token (written by `vault login`)
 * over VAULT_TOKEN env var, since the env var may be stale from a previous
 * shell session while the file is always current.
 */
async function resolveToken(): Promise<string> {
  // 1. ~/.vault-token — freshest source (written by vault login)
  const tokenFile = join(homedir(), '.vault-token');
  if (existsSync(tokenFile)) {
    const token = (await readFile(tokenFile, 'utf-8')).trim();
    if (token) return token;
  }

  // 2. VAULT_TOKEN env var (CI, or manually set)
  const envToken = process.env.VAULT_TOKEN;
  if (envToken) return envToken;

  throw new Error('No Vault token found. Run: vault login');
}

function getVaultAddr(): string {
  const addr = process.env.VAULT_ADDR;
  if (!addr) {
    throw new Error('VAULT_ADDR not set. Run: vault login, or set VAULT_ADDR in your environment.');
  }
  return addr;
}

/**
 * Fetch secret data from a Vault path.
 * Tries KV v2 path first (/v1/mount/data/rest), falls back to direct path (/v1/path).
 * Caches by path — multiple fields from the same path share one call.
 */
async function fetchSecret(path: string): Promise<Record<string, string>> {
  if (cache.has(path)) return cache.get(path)!;

  const token = await resolveToken();
  const addr = getVaultAddr();

  // Build both possible URLs
  const firstSlash = path.indexOf('/');
  if (firstSlash === -1) {
    throw new Error(`Invalid vault path "${path}" — expected "mount/path"`);
  }
  const mount = path.slice(0, firstSlash);
  const secretPath = path.slice(firstSlash + 1);

  // Try KV v2 first (most common)
  const kvUrl = `${addr}/v1/${mount}/data/${secretPath}`;
  const directUrl = `${addr}/v1/${path}`;

  let data: Record<string, string> | undefined;
  let lastError: string = '';

  for (const url of [kvUrl, directUrl]) {
    try {
      const response = await fetch(url, {
        headers: { 'X-Vault-Token': token, 'Accept': 'application/json' },
      });

      if (!response.ok) {
        lastError = `${response.status} ${response.statusText}`;
        continue;
      }

      const json = await response.json() as Record<string, any>;

      // KV v2: data.data, Dynamic engines: data directly
      if (json?.data?.data && typeof json.data.data === 'object') {
        data = json.data.data;
      } else if (json?.data && typeof json.data === 'object') {
        data = json.data;
      }

      if (data) break;
    } catch (e: any) {
      lastError = e.message;
    }
  }

  if (!data) {
    throw new Error(`Vault: could not read "${path}" — ${lastError}`);
  }

  cache.set(path, data);
  return data;
}

/**
 * Resolve a vault reference: "mount/path.field"
 *
 * The base path (everything before last dot) is the Vault secret path.
 * The field (after last dot) is the key within the secret's data.
 *
 * Multiple refs with the same base path share a single Vault call.
 *
 * Examples:
 *   "operations-kv/ci/tokens.npm_token"              → KV v2 lookup
 *   "operations-aws/creds/development.access_key"    → AWS dynamic creds
 */
export async function resolveVaultRef(vaultRef: string): Promise<string> {
  const lastDot = vaultRef.lastIndexOf('.');
  if (lastDot === -1) {
    throw new Error(`Invalid vault ref "${vaultRef}" — expected "mount/path.field"`);
  }
  const path = vaultRef.slice(0, lastDot);
  const field = vaultRef.slice(lastDot + 1);

  const data = await fetchSecret(path);
  const value = data[field];
  if (value === undefined) {
    throw new Error(`Vault "${path}" has no field "${field}" — available: ${Object.keys(data).join(', ')}`);
  }
  return value;
}

/** Clear cache — forces fresh Vault calls. */
export function clearVaultCache(): void {
  cache.clear();
}

/**
 * Verify Vault connectivity: VAULT_ADDR is set, token exists,
 * and we can authenticate (sys/health or token lookup).
 * Throws with a clear message if anything is wrong.
 */
export async function verifyVaultConnection(): Promise<void> {
  const addr = getVaultAddr(); // throws if VAULT_ADDR not set
  const token = await resolveToken(); // throws if no token

  // Check token validity with a self-lookup
  const response = await fetch(`${addr}/v1/auth/token/lookup-self`, {
    headers: { 'X-Vault-Token': token, 'Accept': 'application/json' },
  });

  if (!response.ok) {
    if (response.status === 403) {
      throw new Error('Vault token is expired or revoked. Run: vault login');
    }
    throw new Error(`Vault connection failed (HTTP ${response.status}). Run: vault login`);
  }
}
