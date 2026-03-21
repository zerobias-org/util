import { randomBytes, generateKeyPairSync, createPublicKey } from 'node:crypto';
import { randomUUID } from 'node:crypto';
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
export function generateSecret(spec, resolvedSecrets) {
    const [type, arg] = spec.split(':', 2);
    switch (type) {
        case 'rsa': {
            const bits = parseInt(arg || '2048', 10);
            const { privateKey } = generateKeyPairSync('rsa', {
                modulusLength: bits,
                publicKeyEncoding: { type: 'spki', format: 'pem' },
                privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
            });
            // Base64-encode PEM to single line for .env file compatibility
            return Buffer.from(privateKey).toString('base64');
        }
        case 'rsa_public': {
            const privateKeyName = arg;
            if (!privateKeyName) {
                throw new Error('rsa_public requires a variable name: rsa_public:VAR_NAME');
            }
            const privateKeyB64 = resolvedSecrets.get(privateKeyName);
            if (!privateKeyB64) {
                throw new Error(`rsa_public:${privateKeyName} — private key '${privateKeyName}' not yet generated. ` +
                    'Ensure it appears before this variable in zbb.yaml.');
            }
            // Decode base64 back to PEM for key derivation
            const privatePem = Buffer.from(privateKeyB64, 'base64').toString('utf-8');
            const publicKey = createPublicKey(privatePem);
            const publicPem = publicKey.export({ type: 'spki', format: 'pem' });
            return Buffer.from(publicPem).toString('base64');
        }
        case 'hex': {
            const bytes = parseInt(arg || '32', 10);
            return randomBytes(bytes).toString('hex');
        }
        case 'base64': {
            const bytes = parseInt(arg || '32', 10);
            return randomBytes(bytes).toString('base64');
        }
        case 'uuid':
            return randomUUID();
        default:
            throw new Error(`Unknown secret generation spec: ${spec}`);
    }
}
