/**
 * AuthManager - Module Authentication Protocol Implementation
 *
 * Manages deployment authentication for module testing.
 * Generates deployment IDs and auth keys, and provides
 * authenticated HTTP client instances.
 *
 * Supports both V1 (current) and V2 (future) auth protocols:
 * - V1: Single 'auditmation-auth' header
 * - V2: Two headers 'hub-deployment-id' + 'hub-module-auth'
 */

import https from 'node:https';
import axios, { type AxiosInstance, type AxiosRequestConfig } from 'axios';
import { v4 as uuidv4 } from 'uuid';
import type { Logger, TestDeployment, AuthProtocolVersion } from './types.js';
import { AUTH_HEADERS } from './types.js';

/**
 * Authentication session for a deployment
 */
export interface AuthSession {
  /** Deployment ID */
  deploymentId: string;
  /** Authentication key */
  authKey: string;
  /** When the session was created */
  createdAt: Date;
}

/**
 * AuthManager configuration
 */
export interface AuthManagerConfig {
  /** Request timeout in milliseconds */
  timeout?: number;
  /** Logger instance */
  logger?: Logger;
  /**
   * Auth protocol version.
   * - 'v1': Single 'auditmation-auth' header (current modules)
   * - 'v2': Two headers 'hub-deployment-id' + 'hub-module-auth' (future)
   * Default: 'v1'
   */
  authVersion?: AuthProtocolVersion;
}

/**
 * Default configuration values
 */
const DEFAULTS = {
  TIMEOUT: 30000 // 30 seconds
} as const;

/**
 * AuthManager handles module authentication for testing
 *
 * Supports two protocol versions:
 * - V1 (current): Single 'auditmation-auth' header
 * - V2 (future): Two headers 'hub-deployment-id' + 'hub-module-auth'
 *
 * In production, the auth key is mounted as a Docker secret.
 * In testing, we inject it via environment variable.
 */
export class AuthManager {
  private config: Required<AuthManagerConfig> & { authVersion: AuthProtocolVersion };
  private logger: Logger;
  private sessions: Map<string, AuthSession> = new Map();
  private clients: Map<string, AxiosInstance> = new Map();

  constructor(config: AuthManagerConfig = {}) {
    this.logger = config.logger ?? this.createDefaultLogger();
    this.config = {
      timeout: config.timeout ?? DEFAULTS.TIMEOUT,
      logger: this.logger,
      authVersion: config.authVersion ?? 'v1' // Default to V1 (current modules)
    };
  }

  /**
   * Create a new authentication session for a deployment
   */
  createSession(deploymentId?: string): AuthSession {
    const id = deploymentId ?? generateDeploymentId();
    const authKey = generateAuthKey();

    const session: AuthSession = {
      deploymentId: id,
      authKey,
      createdAt: new Date()
    };

    this.sessions.set(id, session);
    this.logger.debug(`Created auth session for deployment: ${id}`);

    return session;
  }

  /**
   * Get an existing session by deployment ID
   */
  getSession(deploymentId: string): AuthSession | undefined {
    return this.sessions.get(deploymentId);
  }

  /**
   * Remove a session
   */
  removeSession(deploymentId: string): void {
    this.sessions.delete(deploymentId);
    this.clients.delete(deploymentId);
    this.logger.debug(`Removed auth session for deployment: ${deploymentId}`);
  }

  /**
   * Remove all sessions
   */
  clearSessions(): void {
    this.sessions.clear();
    this.clients.clear();
    this.logger.debug('Cleared all auth sessions');
  }

  /**
   * Get authentication headers for a deployment
   * Returns headers based on configured protocol version
   */
  getAuthHeaders(deploymentId: string): Record<string, string> {
    const session = this.sessions.get(deploymentId);
    if (!session) {
      throw new Error(`No auth session found for deployment: ${deploymentId}`);
    }

    if (this.config.authVersion === 'v1') {
      return {
        [AUTH_HEADERS.V1_AUTH]: session.authKey
      };
    } else {
      return {
        [AUTH_HEADERS.V2_DEPLOYMENT_ID]: session.deploymentId,
        [AUTH_HEADERS.V2_MODULE_AUTH]: session.authKey
      };
    }
  }

  /**
   * Create an authenticated HTTP client for a deployment
   */
  createClient(deployment: TestDeployment, baseURL: string): AxiosInstance {
    const { id: deploymentId } = deployment;

    // Check if we have an existing client
    const existingClient = this.clients.get(deploymentId);
    if (existingClient) {
      return existingClient;
    }

    // Get or create session
    let session = this.sessions.get(deploymentId);
    if (!session) {
      session = this.createSession(deploymentId);
      // Update deployment with auth key
      deployment.authKey = session.authKey;
    }

    // Build auth headers based on protocol version
    const headers: Record<string, string> = {
      'Content-Type': 'application/json'
    };

    if (this.config.authVersion === 'v1') {
      // V1: Single 'auditmation-auth' header
      headers[AUTH_HEADERS.V1_AUTH] = session.authKey;
    } else {
      // V2: Two headers (future)
      headers[AUTH_HEADERS.V2_DEPLOYMENT_ID] = session.deploymentId;
      headers[AUTH_HEADERS.V2_MODULE_AUTH] = session.authKey;
    }

    // Create Axios instance with auth headers
    // Note: httpsAgent is configured even for HTTP URLs (ignored by axios for HTTP)
    const client = axios.create({
      baseURL,
      timeout: this.config.timeout,
      headers,
      httpsAgent: new https.Agent({
        rejectUnauthorized: false // Modules use self-signed certificates
      })
    });

    // Add request interceptor for logging
    client.interceptors.request.use(
      (config) => {
        this.logger.debug(`Request: ${config.method?.toUpperCase()} ${config.url}`);
        return config;
      },
      (error) => {
        this.logger.error(`Request error: ${error.message}`);
        return Promise.reject(error);
      }
    );

    // Add response interceptor for logging
    client.interceptors.response.use(
      (response) => {
        this.logger.debug(`Response: ${response.status} from ${response.config.url}`);
        return response;
      },
      (error) => {
        if (error.response) {
          this.logger.error(
            `Response error: ${error.response.status} from ${error.config?.url}`
          );
        } else {
          this.logger.error(`Network error: ${error.message}`);
        }
        return Promise.reject(error);
      }
    );

    this.clients.set(deploymentId, client);
    return client;
  }

  /**
   * Get an existing client for a deployment
   */
  getClient(deploymentId: string): AxiosInstance | undefined {
    return this.clients.get(deploymentId);
  }

  /**
   * Create a new deployment with authentication
   */
  createDeployment(
    module: string,
    version: string,
    image: string
  ): TestDeployment {
    const session = this.createSession();

    return {
      id: session.deploymentId,
      type: 'container',
      module,
      version,
      image,
      authKey: session.authKey,
      status: 'pending'
    };
  }

  /**
   * Create default console logger
   */
  private createDefaultLogger(): Logger {
    return {
      debug: (msg: string, ...args: unknown[]) => console.debug(`[AuthManager] ${msg}`, ...args),
      info: (msg: string, ...args: unknown[]) => console.info(`[AuthManager] ${msg}`, ...args),
      warn: (msg: string, ...args: unknown[]) => console.warn(`[AuthManager] ${msg}`, ...args),
      error: (msg: string, ...args: unknown[]) => console.error(`[AuthManager] ${msg}`, ...args)
    };
  }
}

/**
 * Generate a unique deployment ID for testing
 */
export function generateDeploymentId(): string {
  return `test-dep-${uuidv4()}`;
}

/**
 * Generate a unique authentication key
 */
export function generateAuthKey(): string {
  return uuidv4();
}

/**
 * Parse auth headers from an incoming request (for mock modules)
 * Supports both V1 (auditmation-auth) and V2 (hub-deployment-id + hub-module-auth) protocols
 */
export function parseAuthHeaders(
  headers: Record<string, string | string[] | undefined>
): { deploymentId: string | null; authKey: string } | null {
  // Try V1 first (single header)
  const v1AuthKey = headers[AUTH_HEADERS.V1_AUTH];
  if (v1AuthKey) {
    return {
      deploymentId: null, // V1 doesn't have deployment ID in headers
      authKey: Array.isArray(v1AuthKey) ? v1AuthKey[0] : v1AuthKey
    };
  }

  // Try V2 (two headers)
  const v2DeploymentId = headers[AUTH_HEADERS.V2_DEPLOYMENT_ID];
  const v2AuthKey = headers[AUTH_HEADERS.V2_MODULE_AUTH];

  if (!v2DeploymentId || !v2AuthKey) {
    return null;
  }

  return {
    deploymentId: Array.isArray(v2DeploymentId) ? v2DeploymentId[0] : v2DeploymentId,
    authKey: Array.isArray(v2AuthKey) ? v2AuthKey[0] : v2AuthKey
  };
}
