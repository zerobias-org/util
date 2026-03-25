/**
 * Generate a secret value based on a spec string.
 *
 * Specs:
 *   rsa:2048       → PEM RSA private key, 2048 bits
 *   rsa_public:VAR → PEM RSA public key derived from named private key
 *   hex:32         → 32 random bytes as hex
 *   base64:32      → 32 random bytes as base64
 *   uuid           → random UUID v4
 */
export declare function generateSecret(spec: string, resolvedSecrets: Map<string, string>): string;
