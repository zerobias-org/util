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
export declare function resolveVaultRef(vaultRef: string): Promise<string>;
/** Clear cache — forces fresh Vault calls. */
export declare function clearVaultCache(): void;
/**
 * Verify Vault connectivity: VAULT_ADDR is set, token exists,
 * and we can authenticate (sys/health or token lookup).
 * Throws with a clear message if anything is wrong.
 */
export declare function verifyVaultConnection(): Promise<void>;
