import axios, { AxiosInstance, AxiosError, InternalAxiosRequestConfig } from 'axios';
import { Agent } from 'node:https';
import process from 'node:process';

import { logger } from './common.js';

export interface VaultTokenAuth {
  method: 'token';
  url: string;
  accessToken: string;
  namespace?: string;
}

export interface VaultApproleAuth {
  method: 'approle';
  url: string;
  roleId: string;
  secretId: string;
  /** Auth backend mount path; defaults to `approle`. */
  path?: string;
  namespace?: string;
}

export type VaultAuth = VaultTokenAuth | VaultApproleAuth;

export interface VaultSecret {
  data: Record<string, string>;
}

export interface VaultMount {
  name: string;
}

/**
 * Parameters for the PKI secrets engine's `sign` endpoint.
 *
 * SECURITY: `commonName` and `altNames` are what the ISSUED certificate asserts. The Vault role
 * must be configured with `use_csr_common_name=false` and `use_csr_sans=false`, otherwise Vault
 * takes the subject and SANs from the CSR instead — i.e. from whoever supplied it. A caller
 * that authenticates a requester and then passes its verified identity here gets no protection
 * at all if the role is misconfigured.
 */
export interface VaultPkiSignParams {
  /** PEM-encoded PKCS#10 certificate signing request. */
  csr: string;
  /** Subject common name for the issued certificate. */
  commonName: string;
  /** Subject alternative names (DNS), comma-separated by Vault convention. */
  altNames?: string;
  /** Requested lifetime, in Vault duration format (e.g. `24h`, `3600s`). Capped by the role. */
  ttl?: string;
}

/** The certificate material returned by the PKI `sign` endpoint. */
export interface VaultPkiCert {
  /** The issued leaf, PEM. */
  certificate: string;
  /** The issuing CA certificate, PEM. */
  issuingCa: string;
  /** The CA chain above the issuer, if the mount has one. */
  caChain: string[];
  /** Vault's colon-delimited serial (e.g. `1b:ac:…`). */
  serialNumber: string;
  /** Expiry as a Unix timestamp in seconds. */
  expiration?: number;
}

const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * Whether Vault's TLS certificate must verify against the trust store.
 *
 * Verification is ON by default — an unverifiable certificate fails the connect rather
 * than silently downgrading the channel. Deployments fronted by a self-signed or
 * internal-CA certificate either add the CA (`NODE_EXTRA_CA_CERTS`, preferred) or opt out
 * with `SSL_STRICT=false`. Only the exact string `false` opts out; every other value,
 * including unset and empty, verifies.
 *
 * Read per connect, not at module load, so the env can be set after import.
 */
export function isSslStrict(): boolean {
  return (process.env.SSL_STRICT ?? '').trim().toLowerCase() !== 'false';
}

/** Agent applied to every Vault request. Inert for `http://` addresses. */
function createHttpsAgent(): Agent {
  return new Agent({ rejectUnauthorized: isSslStrict() });
}

/**
 * Minimal HashiCorp Vault HTTP client. Hardcoded to KV v2 — paths are
 * served from `/{mount}/data/{path}` and listed under `/{mount}/metadata/`.
 * Replaces the previous `@auditlogic/module-hashicorp-vault` dependency.
 */
export class VaultClient {
  private readonly http: AxiosInstance;

  private constructor(http: AxiosInstance) {
    this.http = http;
  }

  static async connect(auth: VaultAuth): Promise<VaultClient> {
    const baseURL = `${auth.url.replace(/\/$/, '')}/v1`;
    const baseHeaders: Record<string, string> = {};
    if (auth.namespace) baseHeaders['X-Vault-Namespace'] = auth.namespace;

    const httpsAgent = createHttpsAgent();
    if (!isSslStrict() && baseURL.startsWith('https://')) {
      logger.warn('SSL_STRICT=false — Vault TLS certificate is NOT verified. Prefer adding the CA via NODE_EXTRA_CA_CERTS');
    }

    const token = await VaultClient.authenticate(auth, baseURL, baseHeaders, httpsAgent);

    const http = axios.create({
      baseURL,
      timeout: DEFAULT_TIMEOUT_MS,
      headers: { ...baseHeaders, 'X-Vault-Token': token },
      httpsAgent,
    });

    // Approle tokens have a finite TTL (e.g. 24h). This client is long-lived, so once the
    // token lapses every request would otherwise fail with 403 until the process restarts.
    // Re-authenticate transparently on the first auth failure per request.
    VaultClient.installReauthInterceptor(http, auth, baseURL, baseHeaders, httpsAgent, token);

    return new VaultClient(http);
  }

  /**
   * Obtain a Vault client token: an approle login, or validation of a static token via
   * lookup-self. Factored out of {@link connect} so the re-auth interceptor can mint a fresh
   * token on expiry without rebuilding the client.
   */
  private static async authenticate(
    auth: VaultAuth,
    baseURL: string,
    baseHeaders: Record<string, string>,
    httpsAgent: Agent,
  ): Promise<string> {
    if (auth.method === 'token') {
      // Validate token with lookup-self before declaring success.
      await axios.get(`${baseURL}/auth/token/lookup-self`, {
        headers: { ...baseHeaders, 'X-Vault-Token': auth.accessToken },
        timeout: DEFAULT_TIMEOUT_MS,
        httpsAgent,
      });
      return auth.accessToken;
    }

    const path = auth.path ?? 'approle';
    const resp = await axios.post(
      `${baseURL}/auth/${encodeURIComponent(path)}/login`,
      { role_id: auth.roleId, secret_id: auth.secretId },
      { headers: baseHeaders, timeout: DEFAULT_TIMEOUT_MS, httpsAgent },
    );
    const token = resp.data?.auth?.client_token;
    if (!token) {
      throw new Error('Vault approle login did not return a client_token');
    }
    return token;
  }

  /**
   * Keep this long-lived client usable past the token's TTL. Vault returns 403 (permission
   * denied) for an expired or revoked token; on the first such response per request, re-run the
   * approle login, swap in the fresh token, and retry the request once. Static-token auth cannot
   * be re-minted from credentials, so it is left untouched (the request fails as before).
   *
   * A monotonic token "generation" collapses the stampede when a 24h token expires and many
   * in-flight requests fail at once: each request carries the generation it was sent under, so a
   * 403 can tell "my token is merely stale, someone already refreshed it" (retry with the current
   * token, no login) from "the current token was rejected" (one shared re-login, then retry).
   * The result is exactly one login per expiry regardless of concurrency or timing.
   */
  private static installReauthInterceptor(
    http: AxiosInstance,
    auth: VaultAuth,
    baseURL: string,
    baseHeaders: Record<string, string>,
    httpsAgent: Agent,
    initialToken: string,
  ): void {
    if (auth.method === 'token') return;

    let currentToken = initialToken;
    let generation = 0;
    let reloginInFlight: Promise<void> | undefined;

    // Stamp every request with the live token + the generation it was sent under.
    http.interceptors.request.use((cfg) => {
      cfg.headers.set('X-Vault-Token', currentToken);
      (cfg as InternalAxiosRequestConfig & { __vaultGen?: number }).__vaultGen = generation;
      return cfg;
    });

    http.interceptors.response.use(
      (resp) => resp,
      async (error: AxiosError) => {
        const status = error.response?.status;
        const cfg = error.config as
          (InternalAxiosRequestConfig & { __vaultGen?: number; __vaultRetried?: boolean }) | undefined;

        // Only act on auth failures, and retry each request at most once.
        if (!cfg || cfg.__vaultRetried || (status !== 401 && status !== 403)) {
          return Promise.reject(error);
        }
        cfg.__vaultRetried = true;

        try {
          // Re-login only if nobody has already refreshed the token since this request was sent.
          if (cfg.__vaultGen === generation) {
            if (!reloginInFlight) {
              reloginInFlight = VaultClient.authenticate(auth, baseURL, baseHeaders, httpsAgent)
                .then((freshToken) => {
                  currentToken = freshToken;
                  generation += 1;
                  reloginInFlight = undefined;
                }, (reauthError) => {
                  reloginInFlight = undefined;
                  throw reauthError;
                });
            }
            await reloginInFlight;
          }

          logger.info(`Vault rejected token (${status}); re-authenticated and retrying request`);
          // The request interceptor re-stamps the fresh token on this retry.
          return http.request(cfg);
        } catch (reauthError) {
          logger.warn(`Vault re-authentication failed: ${(reauthError as Error).message}`);
          // Surface the original auth error, not the re-auth failure.
          return Promise.reject(error);
        }
      },
    );
  }

  /** GET `/{mount}/data/{path}` (KV v2). Throws if the secret does not exist. */
  async getSecret(mount: string, key: string): Promise<VaultSecret> {
    const resp = await this.http.get(`/${mount}/data/${key}`);
    const inner = resp.data?.data?.data;
    if (!inner) {
      throw new Error(`Vault secret not found: mount=${mount}, key=${key}`);
    }
    return { data: inner as Record<string, string> };
  }

  /** POST `/{mount}/data/{path}` (KV v2). */
  async upsertSecret(mount: string, key: string, data: Record<string, unknown>): Promise<void> {
    await this.http.post(`/${mount}/data/${key}`, { data });
  }

  /**
   * POST `/{mount}/sign/{role}` (PKI). Signs a CSR and returns the issued certificate.
   *
   * The CA private key never leaves Vault — only the CSR travels here and only a certificate
   * comes back. See {@link VaultPkiSignParams} for the role configuration this relies on.
   */
  async signPki(mount: string, role: string, params: VaultPkiSignParams): Promise<VaultPkiCert> {
    const resp = await this.http.post(`/${mount}/sign/${encodeURIComponent(role)}`, {
      csr: params.csr,
      common_name: params.commonName,
      alt_names: params.altNames,
      ttl: params.ttl,
    });
    const data = resp.data?.data;
    if (!data?.certificate) {
      throw new Error(`Vault PKI sign returned no certificate: mount=${mount}, role=${role}`);
    }
    return {
      certificate: data.certificate as string,
      issuingCa: data.issuing_ca as string,
      caChain: (data.ca_chain ?? []) as string[],
      serialNumber: data.serial_number as string,
      expiration: data.expiration as number | undefined,
    };
  }

  /** GET `/sys/mounts`. Names retain Vault's trailing slash. */
  async listMounts(): Promise<VaultMount[]> {
    const resp = await this.http.get('/sys/mounts');
    const mounts = (resp.data?.data ?? {}) as Record<string, unknown>;
    return Object.keys(mounts).map((name) => ({ name }));
  }

  /** GET `/{mount}/metadata[/path]?list=true` (KV v2). Empty paths return [] on 404. */
  async listSecrets(mount: string, path: string): Promise<string[]> {
    const url = path
      ? `/${mount}/metadata/${path}?list=true`
      : `/${mount}/metadata?list=true`;
    try {
      const resp = await this.http.get(url);
      return (resp.data?.data?.keys ?? []) as string[];
    } catch (err: any) {
      if (err.response?.status === 404) {
        logger.debug(`Vault listSecrets returned 404 for ${url} — treating as empty`);
        return [];
      }
      throw err;
    }
  }
}
