import { AxiosInstance } from 'axios';
import {
  ConnectionMetadata,
  OauthConnectionDetails,
  OperationSupportStatusDef
} from '@zerobias-org/types-core-js';

/**
 * Interface for modules which require a connection to an external system
 */
export interface Connector<ProfileType, StateType> {
  /**
   * Connect to the service specified via the connection profile
   * @param connectionProfile The connection details necessary to connect
   * @param oauthConnectionDetails optional additional information to allow the node to refresh OAuth tokens
   * @param {ProfileType} the connection profile to use for connecting
   * @returns {StateType} any connection state returned by connecting. This could include
   * refresh tokens, etc.
   */
  connect(
    connectionProfile: ProfileType,
    oauthConnectionDetails?: OauthConnectionDetails
  ): Promise<StateType>;

  /**
   * @returns {boolean} indicates whether the connector is currently connected. This should be a
   * deep check to the underlying service
   */
  isConnected(): Promise<boolean>;

  /**
   * Cleanly disconnects from the target service
   */
  disconnect(): Promise<void>;

  /**
   * Refreshes the connection, assuming it has become stale
   * @param {ProfileType} the connection profile to use for connecting
   * @param {StateType} the connection state from the previous `connect()` call
   * @returns {StateType} new connection state from the refreshed connection
   */
  refresh?(
    connectionProfile: ProfileType,
    connectionState: StateType,
    oauthConnectionDetails?: OauthConnectionDetails
  ): Promise<StateType>;

  /**
   * @returns metadata about the underlying connection
   */
  metadata(): Promise<ConnectionMetadata>;

  /**
    * @param operationId the operation to check
    * @returns whether or not the given operation is supported by this module version
    */
  isSupported(operationId: string): Promise<OperationSupportStatusDef>;

  /**
   * @returns the HTTP client used by this connector, if available
   */
  httpClient?(): AxiosInstance | undefined;
}
