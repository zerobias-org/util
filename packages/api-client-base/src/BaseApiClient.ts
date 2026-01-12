/**
 * Base class for Platform API clients (direct HTTP calls)
 * @module BaseApiClient
 */

import { ConnectionMetadata, ConnectionStatus } from '@zerobias-org/types-core-js';
import { ConnectionProfile } from './types.js';
import { ApiInvoker } from '@zerobias-org/util-api-invoker-api';
import { ApiInvokerImpl } from '@zerobias-org/util-api-invoker-isomorphic';
import { AxiosInstance, AxiosRequestConfig } from 'axios';
import { RequestInspector } from './RequestInspector.js';

const DEFAULT_AXIOS_CONFIG: AxiosRequestConfig = { validateStatus: () => true };

/**
 * Abstract base class for Platform API clients
 *
 * Provides common functionality for API clients that make direct HTTP calls
 * to platform services (as opposed to Hub module connectors).
 *
 * Features:
 * - Connection profile management
 * - Authentication (JWT, API key)
 * - Org context handling (dana-org-id)
 * - HTTP client access for debugging
 * - Request inspection and observability
 *
 * @example
 * ```typescript
 * export class HubApiClient extends BaseApiClient {
 *   constructor(axiosConfig?: AxiosRequestConfig) {
 *     super(axiosConfig);
 *   }
 *
 *   async listNodes(): Promise<Node[]> {
 *     // Implementation uses this.apiInvoker
 *   }
 * }
 * ```
 */
export class BaseApiClient {
  /**
   * Current connection profile
   * @protected
   */
  protected _connectionProfile?: ConnectionProfile;

  /**
   * API invoker instance for making HTTP requests
   * @readonly
   */
  readonly apiInvoker: ApiInvoker;

  /**
   * Request inspector for observability (optional)
   * @protected
   */
  protected _requestInspector?: RequestInspector;

  /**
   * Debug mode flag
   * @protected
   */
  protected _debugEnabled: boolean = false;

  /**
   * Base path to append to connection profile URL
   * @protected
   */
  protected _basePath: string = '';

  /**
   * Creates instance of BaseApiClient
   *
   * @param axiosConfig - Axios configuration options
   *                      Defaults to accepting all status codes for custom error handling
   * @param basePath - Base path to append to connection profile URL (e.g., '/store', '/hub')
   *                   This is typically derived from the OpenAPI servers[0].url
   */
  constructor(axiosConfig: AxiosRequestConfig = DEFAULT_AXIOS_CONFIG, basePath: string = '') {
    this.apiInvoker = new ApiInvokerImpl(axiosConfig);
    this._basePath = basePath;
  }

  /**
   * Gets current connection profile
   *
   * @returns Connection profile or undefined if not connected
   */
  get connectionProfile(): ConnectionProfile | undefined {
    return this._connectionProfile;
  }

  /**
   * Gets the base path configured for this client
   *
   * @returns Base path string (e.g., '/store', '/hub') or empty string if not configured
   */
  get basePath(): string {
    return this._basePath;
  }

  /**
   * Establishes connection with given profile
   *
   * This method stores the connection profile and configures the HTTP client
   * with the base URL. Authentication credentials (jwt, apiKey) and org context (orgId)
   * should be applied by the extending class in subsequent requests.
   *
   * @param connectionProfile - Connection configuration including:
   *   - url: Full URL string (e.g., 'http://localhost:8888' or 'https://ci.zerobias.com/api/hub')
   *   - jwt: JWT token for authentication (optional)
   *   - apiKey: API key for authentication (optional)
   *   - orgId: Organization ID for multi-tenancy (optional)
   *
   * @returns Promise that resolves when connection is established
   *
   * @example
   * ```typescript
   * await client.connect({
   *   url: 'https://ci.zerobias.com/api/hub',
   *   jwt: 'eyJhbGciOiJIUzI1NiIs...',
   *   orgId: 'org-123'
   * });
   * ```
   */
  async connect(connectionProfile: ConnectionProfile): Promise<void> {
    this._connectionProfile = connectionProfile;

    // Configure axios instance with baseURL from connection profile + basePath
    const axiosClient = this.httpClient();
    if (axiosClient) {
      let baseURL = typeof connectionProfile.url === 'string'
        ? connectionProfile.url
        : connectionProfile.url.toString();

      // Append basePath if configured (e.g., '/store', '/hub')
      if (this._basePath) {
        // Remove trailing slash from URL and leading slash from basePath to avoid double slashes
        baseURL = baseURL.replace(/\/$/, '') + this._basePath;
      }

      axiosClient.defaults.baseURL = baseURL;

      // Set authentication headers
      if (connectionProfile.apiKey) {
        axiosClient.defaults.headers.common['Authorization'] = `APIKey ${connectionProfile.apiKey}`;
      }
      if (connectionProfile.jwt) {
        axiosClient.defaults.headers.common['Authorization'] = `Bearer ${connectionProfile.jwt}`;
      }

      // Set org context header
      if (connectionProfile.orgId) {
        const orgIdStr = typeof connectionProfile.orgId === 'string'
          ? connectionProfile.orgId
          : connectionProfile.orgId.toString();
        axiosClient.defaults.headers.common['dana-org-id'] = orgIdStr;
      }
    }
  }

  /**
   * Checks if client is currently connected
   *
   * Makes a test request to /me endpoint to verify connectivity.
   * Override this method to implement service-specific health checks.
   *
   * @returns Promise resolving to true if connected, false otherwise
   */
  async isConnected(): Promise<boolean> {
    try {
      const response = await this.apiInvoker.client.get('/me');
      return response.status === 200;
    } catch {
      return false;
    }
  }

  /**
   * Disconnects from service
   *
   * Clears connection profile. Override this method if service requires
   * explicit disconnect logic (e.g., token revocation).
   *
   * @returns Promise that resolves when disconnected
   */
  async disconnect(): Promise<void> {
    this._connectionProfile = undefined;
    return;
  }

  /**
   * Gets connection metadata
   *
   * Returns basic connection status. Override this method to provide
   * service-specific metadata (e.g., user info, permissions).
   *
   * @returns Promise resolving to connection metadata
   */
  async metadata(): Promise<ConnectionMetadata> {
    return new ConnectionMetadata(
      this._connectionProfile ? ConnectionStatus.On : ConnectionStatus.Initialized
    );
  }

  /**
   * Gets underlying Axios HTTP client
   *
   * Exposes raw Axios instance for advanced use cases:
   * - Custom interceptors
   * - Direct HTTP calls
   * - Request/response inspection
   *
   * @returns Axios instance or undefined if not initialized
   *
   * @example
   * ```typescript
   * const axiosClient = client.httpClient();
   * if (axiosClient) {
   *   axiosClient.interceptors.request.use(config => {
   *     console.log('Request:', config);
   *     return config;
   *   });
   * }
   * ```
   */
  httpClient(): AxiosInstance | undefined {
    return this.apiInvoker.client;
  }

  /**
   * Enables or disables debug mode
   *
   * When enabled, attaches RequestInspector to capture all HTTP traffic.
   * Use getRequestInspector() to access captured requests.
   *
   * @param enabled - True to enable debug mode, false to disable
   *
   * @example
   * ```typescript
   * client.enableDebug(true);
   * await client.someOperation();
   * const history = client.getRequestInspector()?.getRequestHistory();
   * console.log('Requests made:', history);
   * ```
   */
  enableDebug(enabled: boolean): void {
    this._debugEnabled = enabled;

    if (enabled && !this._requestInspector) {
      const axiosClient = this.httpClient();
      if (axiosClient) {
        this._requestInspector = new RequestInspector(axiosClient);
      }
    }

    if (!enabled && this._requestInspector) {
      this._requestInspector = undefined;
    }
  }

  /**
   * Gets request inspector instance
   *
   * Returns RequestInspector for accessing request history and adding callbacks.
   * Only available when debug mode is enabled.
   *
   * @returns RequestInspector instance or undefined if debug not enabled
   */
  getRequestInspector(): RequestInspector | undefined {
    return this._requestInspector;
  }

  /**
   * Updates organization ID in connection profile
   *
   * Changes the org context (dana-org-id header) for subsequent requests.
   * Useful for switching between organizations without reconnecting.
   *
   * @param orgId - New organization ID
   *
   * @example
   * ```typescript
   * await client.connect(profile);
   * await client.getResource('123'); // Uses initial orgId
   *
   * client.setOrgId('org-456');
   * await client.getResource('123'); // Uses new orgId
   * ```
   */
  setOrgId(orgId: string): void {
    if (this._connectionProfile) {
      this._connectionProfile.orgId = orgId;
    }
  }
}
