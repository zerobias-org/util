/**
 * Type definitions for API client base
 * @module types
 */

import { UUID, URL } from '@zerobias-org/types-core-js';

/**
 * Connection profile for Platform API clients
 *
 * Configures how the client connects to a platform service.
 * Separate from HubConnectionProfile which is for Hub module connectors.
 */
export interface ConnectionProfile {
  /**
   * Service URL (full URL string including protocol, host, port, and path)
   *
   * Examples:
   * - 'http://localhost:8888'
   * - 'https://ci.zerobias.com/api/hub'
   * - 'http://localhost:3000/api'
   *
   * Can be a string or a URL object from @zerobias-org/types-core-js
   */
  url: string | URL;

  /**
   * JWT token for authentication
   * Will be sent as 'Authorization: Bearer <jwt>' header
   */
  jwt?: string;

  /**
   * API key for authentication
   * Will be sent as 'Authorization: APIKey <apiKey>' header
   */
  apiKey?: string;

  /**
   * Organization ID for multi-tenancy
   * Will be sent as 'dana-org-id' header
   */
  orgId?: string | UUID;
}
