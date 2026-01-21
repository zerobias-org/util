/**
 * DataProducerClient - Framework-agnostic DataProducer client wrapper
 *
 * This client provides a unified interface for interacting with DataProducer APIs.
 * It wraps the underlying DataProducer client from @zerobias-org/module-interface-dataproducer-client-ts
 * and provides strongly-typed, validated access to all API modules.
 */

import { DataproducerClient, newDataproducer } from '@zerobias-org/module-interface-dataproducer-client-ts';
import { UUID } from '@zerobias-org/types-core-js';
import { DataProducerConfig, ConnectionResult, DataProducerError, DataProducerErrorType } from './types/common.types';
import { ObjectsApi } from './apis/ObjectsApi';
import { CollectionsApi } from './apis/CollectionsApi';
import { SchemasApi } from './apis/SchemasApi';
import { DocumentsApi } from './apis/DocumentsApi';
import { FunctionsApi } from './apis/FunctionsApi';
import { BinaryApi } from './apis/BinaryApi';

/**
 * DataProducerClient - Main client class for DataProducer interactions
 *
 * This class is 100% framework-agnostic and can be used in:
 * - Node.js backends
 * - Browser frontends (React, Vue, Angular, etc.)
 * - Deno, Bun, or other JavaScript runtimes
 *
 * Usage:
 * ```typescript
 * const client = new DataProducerClient(config);
 * await client.connect();
 * const root = await client.objects.getRoot();
 * const collections = await client.collections.getCollections();
 * await client.disconnect();
 * ```
 */
export class DataProducerClient {
  private _dataProducer: DataproducerClient;
  private _config: DataProducerConfig | null = null;
  private _connected: boolean = false;

  // API module instances
  public readonly objects: ObjectsApi;
  public readonly collections: CollectionsApi;
  public readonly schemas: SchemasApi;
  public readonly documents: DocumentsApi;
  public readonly functions: FunctionsApi;
  public readonly binary: BinaryApi;

  /**
   * Create a new DataProducerClient
   *
   * @param config - Optional initial configuration
   */
  constructor(config?: DataProducerConfig) {
    this._dataProducer = newDataproducer();
    if (config) {
      this._config = config;
    }

    // Initialize API modules
    this.objects = new ObjectsApi(this);
    this.collections = new CollectionsApi(this);
    this.schemas = new SchemasApi(this);
    this.documents = new DocumentsApi(this);
    this.functions = new FunctionsApi(this);
    this.binary = new BinaryApi(this);
  }

  /**
   * Get the underlying DataProducer client instance
   * This is exposed for advanced use cases and API modules
   *
   * @internal
   */
  public getDataProducer(): DataproducerClient & any {
    return this._dataProducer;
  }

  /**
   * Get the current configuration
   */
  public getConfig(): DataProducerConfig | null {
    return this._config;
  }

  /**
   * Check if the client is connected
   */
  public get connected(): boolean {
    return this._connected;
  }

  /**
   * Connect to the DataProducer
   *
   * @param config - Connection configuration (uses constructor config if not provided)
   * @returns Connection result with success status and optional error
   */
  public async connect(config?: DataProducerConfig): Promise<ConnectionResult> {
    try {
      // Use provided config or stored config
      const connectionConfig = config || this._config;
      if (!connectionConfig) {
        throw new DataProducerError(
          'No configuration provided. Pass config to connect() or constructor.',
          DataProducerErrorType.ConnectionError
        );
      }

      // Store config for future use
      if (config) {
        this._config = config;
      }

      // Prepare connection profile - convert targetId to UUID if string
      const targetId = typeof connectionConfig.targetId === 'string'
        ? new UUID(connectionConfig.targetId)
        : connectionConfig.targetId;

      const connectionProfile = {
        server: connectionConfig.server,
        targetId: targetId,
        scopeId: connectionConfig.scopeId,
        ...(connectionConfig.headers && { headers: connectionConfig.headers }),
        ...(connectionConfig.timeout && { timeout: connectionConfig.timeout })
      };

      // Connect using underlying client
      await this._dataProducer.connect(connectionProfile);
      this._connected = true;

      return {
        success: true
      };
    } catch (error) {
      this._connected = false;
      const errorMessage = (error as any)?.message || String(error);

      return {
        success: false,
        error: errorMessage
      };
    }
  }

  /**
   * Disconnect from the DataProducer
   *
   * @returns True if disconnected successfully, false otherwise
   */
  public async disconnect(): Promise<boolean> {
    try {
      const isConnected = await this._dataProducer.isConnected();
      if (isConnected) {
        await this._dataProducer.disconnect();
      }
      this._connected = false;
      return true;
    } catch (error) {
      console.error('Failed to disconnect from DataProducer:', error);
      return false;
    }
  }

  /**
   * Check if connected to the DataProducer
   *
   * @returns True if connected, false otherwise
   */
  public async isConnected(): Promise<boolean> {
    try {
      // First check our wrapper's connection state
      if (!this._connected) {
        return false;
      }

      // Then verify with the underlying dataProducer
      const connected = await this._dataProducer.isConnected();
      this._connected = connected;
      return connected;
    } catch (error) {
      this._connected = false;
      return false;
    }
  }

  /**
   * Ping the DataProducer to check connectivity
   *
   * @returns True if ping successful, false otherwise
   */
  public async ping(): Promise<boolean> {
    try {
      // Most DataProducer clients implement a health check or ping method
      // If not available, we can use isConnected as a proxy
      if (typeof (this._dataProducer as any).ping === 'function') {
        await (this._dataProducer as any).ping();
        return true;
      } else {
        return await this.isConnected();
      }
    } catch (error) {
      return false;
    }
  }

  /**
   * Initialize connection with auto-reconnect logic
   *
   * This method handles switching between different connections:
   * - If targetId is null and client is connected, disconnects
   * - If targetId changes, disconnects from old and connects to new
   * - If targetId is same, does nothing
   *
   * @param targetId - Target UUID to connect to (null to disconnect)
   * @param scopeId - Scope ID for the connection
   * @param server - Optional server URL (uses config if not provided)
   */
  public async init(targetId: UUID | string | null, scopeId: string, server?: string): Promise<ConnectionResult> {
    const currentConfig = this._config;
    const currentTargetId = currentConfig?.targetId;

    // Case 1: Disconnect if targetId is null and currently connected
    if (targetId === null && this._connected) {
      await this.disconnect();
      return { success: false, error: 'Disconnected due to null targetId' };
    }

    // Case 2: Return error if targetId is null and not connected
    if (targetId === null && !this._connected) {
      return { success: false, error: 'Cannot initialize with null targetId' };
    }

    // Case 3: Connect if not currently connected
    if (targetId !== null && !this._connected) {
      return await this.connect({
        server: server || currentConfig?.server || '',
        targetId,
        scopeId
      });
    }

    // Case 4: Reconnect if targetId changed
    if (targetId !== null && currentTargetId !== null) {
      const currentIdStr = typeof currentTargetId === 'string' ? currentTargetId : currentTargetId.toString();
      const newIdStr = typeof targetId === 'string' ? targetId : targetId.toString();

      if (currentIdStr !== newIdStr) {
        const disconnected = await this.disconnect();
        if (disconnected) {
          return await this.connect({
            server: server || currentConfig?.server || '',
            targetId,
            scopeId
          });
        } else {
          return {
            success: false,
            error: 'Failed to disconnect from previous connection'
          };
        }
      }
    }

    // Case 5: Already connected to same target
    return { success: true };
  }

  /**
   * Handle errors consistently across all API methods
   *
   * @param error - Error object
   * @param context - Context string for error message
   * @internal
   */
  public handleError(error: any, context: string): never {
    const errorMessage = error?.message || String(error);
    const errorType = this._classifyError(error);

    throw new DataProducerError(
      `${context}: ${errorMessage}`,
      errorType,
      error
    );
  }

  /**
   * Classify error type based on error object
   *
   * @param error - Error object
   * @returns DataProducerErrorType
   * @private
   */
  private _classifyError(error: any): DataProducerErrorType {
    const errorMessage = error?.message?.toLowerCase() || String(error).toLowerCase();

    if (errorMessage.includes('connect') || errorMessage.includes('network')) {
      return DataProducerErrorType.ConnectionError;
    } else if (errorMessage.includes('auth') || errorMessage.includes('unauthorized')) {
      return DataProducerErrorType.AuthenticationError;
    } else if (errorMessage.includes('validat')) {
      return DataProducerErrorType.ValidationError;
    } else if (errorMessage.includes('not found') || errorMessage.includes('404')) {
      return DataProducerErrorType.NotFoundError;
    } else if (errorMessage.includes('timeout')) {
      return DataProducerErrorType.TimeoutError;
    } else {
      return DataProducerErrorType.UnknownError;
    }
  }
}
