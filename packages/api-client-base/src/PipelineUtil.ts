/**
 * Request pipeline utilities for API clients
 * @module PipelineUtil
 */

import { RequestPrototype } from '@zerobias-org/util-api-invoker-api';
import { ConnectionProfile } from './types.js';
import { apiKey, jwt } from './AuthUtils.js';

/**
 * Prepares request prototype with connection profile settings
 *
 * This function applies connection profile configuration to the request:
 * - Sets hostname, protocol, and port from connection profile URL
 * - Constructs full path including base path and API path
 * - Adds authentication headers (JWT or API key)
 * - Adds org context header (dana-org-id) if specified
 *
 * @param input - Request prototype to modify
 * @param originalRequestPrototype - Original request for reference
 * @param params - Request parameters
 * @param connectionProfile - Connection configuration
 * @returns Modified request prototype
 *
 * @example
 * ```typescript
 * const request = await ensureRequestPrototype(
 *   input,
 *   original,
 *   params,
 *   {
 *     url: {
 *       hostname: 'api.example.com',
 *       protocol: 'https',
 *       port: 443,
 *       path: '/v1'
 *     },
 *     jwt: 'eyJhbGciOiJIUzI1NiIs...',
 *     orgId: 'org-123'
 *   }
 * );
 * ```
 */
export async function ensureRequestPrototype(
  input: RequestPrototype,
  originalRequestPrototype: RequestPrototype,
  params: any,
  connectionProfile?: ConnectionProfile,
  apiPath?: string
): Promise<RequestPrototype> {
  // Parse URL from connection profile
  let connectionProfileBasePath = '';
  if (connectionProfile && connectionProfile.url) {
    const urlStr = typeof connectionProfile.url === 'string'
      ? connectionProfile.url
      : connectionProfile.url.toString();
    const urlObj = new URL(urlStr);
    input.location.hostname = urlObj.hostname;
    input.location.protocol = urlObj.protocol.replace(':', '') as 'http' | 'https';
    input.location.port = urlObj.port || (urlObj.protocol === 'https:' ? '443' : '80');

    // Extract base path from URL (e.g., '/api/hub' from 'http://localhost:8888/api/hub')
    if (urlObj.pathname && urlObj.pathname !== '/' && urlObj.pathname !== '') {
      connectionProfileBasePath = urlObj.pathname;
    }
  } else {
    // Default protocol if no connection profile
    input.location.protocol = 'https';
  }

  // Construct full path: <base>/<api-path>/<operation-path>
  const fullApiPath = apiPath || '';
  input.location.path = `${connectionProfileBasePath}${fullApiPath}${input.location.path}`;

  // Normalize double slashes
  if (input.location.path.startsWith('//')) {
    input.location.path = input.location.path.replace('//', '/');
  }

  // Initialize headers
  input.headers = {};

  // Add authentication header
  let auth: string | undefined;
  if (connectionProfile?.apiKey) {
    auth = apiKey(connectionProfile?.apiKey);
    input.headers['Authorization'] = auth;
  } else if (connectionProfile?.jwt) {
    auth = jwt(connectionProfile?.jwt);
    input.headers['Authorization'] = auth;
  }

  // Add org context header
  if (connectionProfile?.orgId) {
    input.headers['dana-org-id'] = connectionProfile?.orgId;
  }

  return input;
}
