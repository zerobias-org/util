/**
 * EnvSecretsProvider - Environment variable based secrets
 *
 * Reads secrets from environment variables with configurable prefixes.
 * Useful for CI environments where secrets are injected as env vars.
 *
 * Naming Convention:
 * - Path: "aws/test-credentials"
 * - Env var prefix: MODULE_TEST_SECRET_
 * - Full env var: MODULE_TEST_SECRET_AWS_TEST_CREDENTIALS_ACCESS_KEY
 *
 * Alternative: JSON-encoded secrets
 * - MODULE_TEST_SECRET_AWS_TEST_CREDENTIALS='{"accessKey":"...","secretKey":"..."}'
 */

import type { Logger } from '../types.js';
import type { SecretsProvider } from './SecretsProvider.js';

/**
 * EnvSecretsProvider configuration
 */
export interface EnvSecretsProviderConfig {
  /** Environment variable prefix (default: MODULE_TEST_SECRET_) */
  prefix?: string;
  /** Whether to parse JSON values (default: true) */
  parseJson?: boolean;
}

/**
 * Default configuration
 */
const DEFAULTS = {
  PREFIX: 'MODULE_TEST_SECRET_',
  PARSE_JSON: true
} as const;

/**
 * Environment variable based secrets provider
 */
export class EnvSecretsProvider implements SecretsProvider {
  readonly name = 'EnvSecretsProvider';
  private config: Required<EnvSecretsProviderConfig>;
  private logger: Logger;

  constructor(config: EnvSecretsProviderConfig = {}, logger?: Logger) {
    this.config = {
      prefix: config.prefix ?? DEFAULTS.PREFIX,
      parseJson: config.parseJson ?? DEFAULTS.PARSE_JSON
    };
    this.logger = logger ?? this.createDefaultLogger();
  }

  /**
   * Get secret from environment variables
   *
   * Supports two formats:
   * 1. JSON: MODULE_TEST_SECRET_PATH='{"key":"value"}'
   * 2. Individual: MODULE_TEST_SECRET_PATH_KEY=value
   */
  async getSecret(path: string): Promise<Record<string, unknown>> {
    const envKey = this.pathToEnvKey(path);

    // First, check for JSON-encoded secret
    const jsonValue = process.env[envKey];
    if (jsonValue) {
      if (this.config.parseJson) {
        try {
          const parsed = JSON.parse(jsonValue);
          this.logger.debug(`Loaded JSON secret from ${envKey}`);
          return parsed;
        } catch {
          // Not JSON, treat as single value
          this.logger.debug(`Loaded string secret from ${envKey}`);
          return { value: jsonValue };
        }
      }
      return { value: jsonValue };
    }

    // Second, collect all env vars with this prefix
    const prefix = `${envKey}_`;
    const result: Record<string, unknown> = {};
    let found = false;

    for (const [key, value] of Object.entries(process.env)) {
      if (key.startsWith(prefix) && value !== undefined) {
        const subKey = this.envKeyToProperty(key.slice(prefix.length));
        result[subKey] = this.parseValue(value);
        found = true;
      }
    }

    if (!found) {
      throw new Error(`No environment variables found for secret path: ${path} (looked for ${envKey} or ${prefix}*)`);
    }

    this.logger.debug(`Loaded ${Object.keys(result).length} values from ${prefix}*`);
    return result;
  }

  /**
   * Check if environment variables exist for this path
   */
  supports(path: string): boolean {
    const envKey = this.pathToEnvKey(path);

    // Check for exact match
    if (process.env[envKey]) {
      return true;
    }

    // Check for prefixed matches
    const prefix = `${envKey}_`;
    return Object.keys(process.env).some(key => key.startsWith(prefix));
  }

  /**
   * Convert a path to an environment variable key
   * Example: "aws/test-credentials" -> "MODULE_TEST_SECRET_AWS_TEST_CREDENTIALS"
   */
  private pathToEnvKey(path: string): string {
    const normalized = path
      .toUpperCase()
      .replaceAll(/[/\\]/g, '_')  // Replace path separators
      .replaceAll('-', '_')       // Replace hyphens
      .replaceAll(/[^\dA-Z_]/g, ''); // Remove invalid chars

    return `${this.config.prefix}${normalized}`;
  }

  /**
   * Convert an environment key suffix to a property name
   * Example: "ACCESS_KEY" -> "accessKey"
   */
  private envKeyToProperty(envKey: string): string {
    return envKey
      .toLowerCase()
      .replaceAll(/_([a-z])/g, (_, char) => char.toUpperCase());
  }

  /**
   * Parse a string value to appropriate type
   */
  private parseValue(value: string): unknown {
    // Try to parse as JSON
    if (this.config.parseJson) {
      try {
        return JSON.parse(value);
      } catch {
        // Not JSON, return as string
      }
    }

    // Try common type conversions
    if (value === 'true') return true;
    if (value === 'false') return false;
    if (/^\d+$/.test(value)) return Number.parseInt(value, 10);
    if (/^\d+\.\d+$/.test(value)) return Number.parseFloat(value);

    return value;
  }

  /**
   * Create default console logger
   */
  private createDefaultLogger(): Logger {
    return {
      debug: (msg: string, ...args: unknown[]) => console.debug(`[EnvSecrets] ${msg}`, ...args),
      info: (msg: string, ...args: unknown[]) => console.info(`[EnvSecrets] ${msg}`, ...args),
      warn: (msg: string, ...args: unknown[]) => console.warn(`[EnvSecrets] ${msg}`, ...args),
      error: (msg: string, ...args: unknown[]) => console.error(`[EnvSecrets] ${msg}`, ...args)
    };
  }
}

/**
 * Set a secret in environment variables (for testing)
 */
export function setEnvSecret(path: string, value: Record<string, unknown>, prefix = DEFAULTS.PREFIX): void {
  const envKey = `${prefix}${path.toUpperCase().replaceAll(/[/\\-]/g, '_')}`;
  process.env[envKey] = JSON.stringify(value);
}

/**
 * Clear a secret from environment variables (for testing)
 */
export function clearEnvSecret(path: string, prefix = DEFAULTS.PREFIX): void {
  const envKey = `${prefix}${path.toUpperCase().replaceAll(/[/\\-]/g, '_')}`;
  delete process.env[envKey];

  // Also clear any prefixed vars
  const fullPrefix = `${envKey}_`;
  for (const key of Object.keys(process.env)) {
    if (key.startsWith(fullPrefix)) {
      delete process.env[key];
    }
  }
}
