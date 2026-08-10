import axios, { AxiosInstance } from 'axios';

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

    let token: string;
    if (auth.method === 'token') {
      token = auth.accessToken;
      // Validate token with lookup-self before declaring success.
      await axios.get(`${baseURL}/auth/token/lookup-self`, {
        headers: { ...baseHeaders, 'X-Vault-Token': token },
        timeout: DEFAULT_TIMEOUT_MS,
      });
    } else {
      const path = auth.path ?? 'approle';
      const resp = await axios.post(
        `${baseURL}/auth/${encodeURIComponent(path)}/login`,
        { role_id: auth.roleId, secret_id: auth.secretId },
        { headers: baseHeaders, timeout: DEFAULT_TIMEOUT_MS },
      );
      token = resp.data?.auth?.client_token;
      if (!token) {
        throw new Error('Vault approle login did not return a client_token');
      }
    }

    const http = axios.create({
      baseURL,
      timeout: DEFAULT_TIMEOUT_MS,
      headers: { ...baseHeaders, 'X-Vault-Token': token },
    });
    return new VaultClient(http);
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
