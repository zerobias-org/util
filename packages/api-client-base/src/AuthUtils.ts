/**
 * Authentication utility functions for API clients
 * @module AuthUtils
 */

/**
 * Ensures JWT token has Bearer prefix
 * @param jwtStr - JWT token string
 * @returns JWT token with Bearer prefix
 * @example
 * ```typescript
 * const token = AuthUtils.jwt('eyJhbGciOiJIUzI1NiIs...');
 * // Returns: 'Bearer eyJhbGciOiJIUzI1NiIs...'
 * ```
 */
export function jwt(jwtStr: string): string {
  return jwtStr?.startsWith('Bearer ')
    ? jwtStr : `Bearer ${jwtStr}`;
}

/**
 * Ensures API key has APIKey prefix
 * @param apiKeyStr - API key string
 * @returns API key with APIKey prefix
 * @example
 * ```typescript
 * const key = AuthUtils.apiKey('abc123');
 * // Returns: 'APIKey abc123'
 * ```
 */
export function apiKey(apiKeyStr: string): string {
  return apiKeyStr?.startsWith('APIKey ')
    ? apiKeyStr : `APIKey ${apiKeyStr}`;
}
