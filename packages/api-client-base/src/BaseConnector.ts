/**
 * Base class for Hub Module connectors (via Hub targets)
 * @module BaseConnector
 */

import { ConnectionMetadata, ConnectionStatus, ConnectionStatusDef } from '@zerobias-org/types-core-js';

/**
 * Abstract base class for Hub Module connectors
 *
 * Provides common functionality for connectors that invoke operations
 * through Hub Server (as opposed to direct HTTP calls).
 *
 * Features:
 * - Target ID management
 * - Connection lifecycle hooks
 * - Connection metadata
 *
 * @abstract
 * @example
 * ```typescript
 * export class AwsConnector extends BaseConnector {
 *   constructor() {
 *     super();
 *   }
 *
 *   async listBuckets(): Promise<Bucket[]> {
 *     // Implementation uses Hub target invocation
 *   }
 * }
 * ```
 */
export abstract class BaseConnector {
  /**
   * Current target ID (Hub connection/deployment)
   * @protected
   */
  protected targetId?: string;

  /**
   * Connection status
   * @protected
   */
  protected status: ConnectionStatusDef = ConnectionStatus.Initialized;

  /**
   * Establishes connection to Hub target
   *
   * Stores target ID for use in subsequent operations.
   * Target ID can be either:
   * - Connection ID: For external system connections
   * - Deployment ID: For agent modules (direct node access)
   *
   * @param targetId - Hub target identifier
   * @returns Promise that resolves when connection is established
   *
   * @example
   * ```typescript
   * await connector.connect('conn-abc123');
   * await connector.listBuckets(); // Uses target conn-abc123
   * ```
   */
  async connect(targetId: string): Promise<void> {
    this.targetId = targetId;
    this.status = ConnectionStatus.On;
  }

  /**
   * Disconnects from Hub target
   *
   * Clears target ID. Override this method if module requires
   * explicit disconnect logic on the remote system.
   *
   * @returns Promise that resolves when disconnected
   */
  async disconnect(): Promise<void> {
    this.targetId = undefined;
    this.status = ConnectionStatus.Off;
    return;
  }

  /**
   * Checks if connector is currently connected
   *
   * Returns true if target ID is set and status is connected.
   * Override this method to implement module-specific health checks.
   *
   * @returns Promise resolving to true if connected, false otherwise
   */
  async isConnected(): Promise<boolean> {
    return this.targetId !== undefined && this.status === ConnectionStatus.On;
  }

  /**
   * Gets connection metadata
   *
   * Returns basic connection status and target ID.
   * Override this method to provide module-specific metadata.
   *
   * @returns Promise resolving to connection metadata
   */
  async metadata(): Promise<ConnectionMetadata> {
    return new ConnectionMetadata(this.status);
  }

  /**
   * Gets current target ID
   *
   * @returns Target ID or undefined if not connected
   */
  getTargetId(): string | undefined {
    return this.targetId;
  }
}
