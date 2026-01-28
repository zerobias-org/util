/**
 * ProfileResolver - Resolves secret paths in connection profiles
 *
 * Connection profiles can contain either literal values or secret paths.
 * Secret paths follow the format: {driver}.{path}.{key}
 *
 * Supported drivers:
 * - file: Reads from FILE_SECRET_ROOT/{path}.json or .yml
 * - env: Reads from environment variable
 *
 * Examples:
 *   tokenType: "Bearer"           -> literal value
 *   apiToken: "file.github.apiToken" -> resolved from file
 *   apiToken: "env.GITHUB_TOKEN"  -> resolved from env var
 */

import * as fs from 'node:fs';
import path from 'node:path';
import * as os from 'node:os';
import * as yaml from 'js-yaml';
import type { Logger } from '../types.js';

const DELIMITER = '.';
const SECRET_PREFIX = '{{';
const SECRET_SUFFIX = '}}';

export interface ProfileResolverConfig {
  /** Root directory for file secrets (default: ~/.zerobias/secrets) */
  fileSecretRoot?: string;
  /** Logger instance */
  logger?: Logger;
}

/**
 * Resolves secret paths in a connection profile
 */
export class ProfileResolver {
  private fileSecretRoot: string;
  private logger: Logger;
  private cache: Map<string, Record<string, unknown>> = new Map();

  constructor(config: ProfileResolverConfig = {}) {
    this.fileSecretRoot = config.fileSecretRoot
      ?? process.env.FILE_SECRET_ROOT
      ?? path.join(os.homedir(), '.zerobias', 'secrets');
    this.logger = config.logger ?? this.createDefaultLogger();
  }

  /**
   * Resolve all secret paths in a connection profile
   *
   * Secret paths use Mustache {{...}} syntax to differentiate from literal values:
   *   tokenType: Bearer                        -> literal value "Bearer"
   *   apiToken: {{file.github.apiToken}}       -> resolved from file
   *   apiToken: {{env.GITHUB_TOKEN}}           -> resolved from env var
   *
   * @param profile - Connection profile with potential secret paths
   * @returns Resolved profile with actual values
   */
  async resolve(profile: Record<string, unknown>): Promise<Record<string, unknown>> {
    const resolved: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(profile)) {
      if (typeof value === 'string') {
        const secretPath = this.extractSecretPath(value);
        if (secretPath) {
          this.logger.debug(`Resolving secret path: ${key} = ${value}`);
          resolved[key] = await this.getValue(secretPath);
        } else {
          resolved[key] = value;
        }
      } else {
        resolved[key] = value;
      }
    }

    return resolved;
  }

  /**
   * Extract secret path from ${...} syntax
   * Returns the path inside braces, or null if not a secret reference
   */
  private extractSecretPath(value: string): string | null {
    const trimmed = value.trim();
    if (trimmed.startsWith(SECRET_PREFIX) && trimmed.endsWith(SECRET_SUFFIX)) {
      return trimmed.slice(SECRET_PREFIX.length, -SECRET_SUFFIX.length);
    }
    return null;
  }

  /**
   * Check if a value is a secret path reference
   */
  private isSecretPath(value: string): boolean {
    return this.extractSecretPath(value) !== null;
  }

  /**
   * Get a secret value from a path
   */
  async getValue(secretPath: string): Promise<unknown> {
    const parts = secretPath.split(DELIMITER);
    if (parts.length < 2) {
      throw new Error(`Invalid secret path: ${secretPath}`);
    }

    const [driver, ...rest] = parts;

    switch (driver.toLowerCase()) {
      case 'file': {
        return this.getFileValue(rest);
      }
      case 'env': {
        return this.getEnvValue(rest);
      }
      default: {
        throw new Error(`Unknown secret driver: ${driver}`);
      }
    }
  }

  /**
   * Get value from file-based secret
   * Path format: file.{filename}.{key}.{subkey}...
   */
  private async getFileValue(pathParts: string[]): Promise<unknown> {
    if (pathParts.length < 2) {
      throw new Error(`Invalid file secret path: file.${pathParts.join('.')}`);
    }

    const [fileName, ...keyPath] = pathParts;

    // Try to find the file
    const filePath = await this.findSecretFile(fileName);
    if (!filePath) {
      throw new Error(`Secret file not found: ${fileName} in ${this.fileSecretRoot}`);
    }

    // Load and cache file contents
    let data = this.cache.get(filePath);
    if (!data) {
      data = await this.loadSecretFile(filePath);
      this.cache.set(filePath, data);
    }

    // Navigate to the value
    let current: unknown = data;
    for (const key of keyPath) {
      if (current === null || typeof current !== 'object') {
        throw new Error(`Cannot navigate to ${key} in ${fileName}: not an object`);
      }
      current = (current as Record<string, unknown>)[key];
      if (current === undefined) {
        throw new Error(`Key not found: ${key} in file.${pathParts.join('.')}`);
      }
    }

    return current;
  }

  /**
   * Get value from environment variable
   * Path format: env.{VAR_NAME} or env.{VAR_NAME}.{jsonKey}
   */
  private getEnvValue(pathParts: string[]): unknown {
    if (pathParts.length === 0) {
      throw new Error('Invalid env secret path: missing variable name');
    }

    const [varName, ...keyPath] = pathParts;
    const envValue = process.env[varName];

    if (envValue === undefined) {
      throw new Error(`Environment variable not found: ${varName}`);
    }

    // If no key path, return raw value
    if (keyPath.length === 0) {
      return envValue;
    }

    // Try to parse as JSON and navigate
    let data: unknown;
    try {
      data = JSON.parse(envValue);
    } catch {
      throw new Error(`Environment variable ${varName} is not valid JSON`);
    }

    let current: unknown = data;
    for (const key of keyPath) {
      if (current === null || typeof current !== 'object') {
        throw new Error(`Cannot navigate to ${key} in ${varName}: not an object`);
      }
      current = (current as Record<string, unknown>)[key];
      if (current === undefined) {
        throw new Error(`Key not found: ${key} in env.${pathParts.join('.')}`);
      }
    }

    return current;
  }

  /**
   * Find a secret file with supported extension
   */
  private async findSecretFile(fileName: string): Promise<string | null> {
    const extensions = ['json', 'yaml', 'yml'];

    for (const ext of extensions) {
      const filePath = path.join(this.fileSecretRoot, `${fileName}.${ext}`);
      if (fs.existsSync(filePath)) {
        return filePath;
      }
    }

    return null;
  }

  /**
   * Load and parse a secret file
   */
  private async loadSecretFile(filePath: string): Promise<Record<string, unknown>> {
    const content = fs.readFileSync(filePath, 'utf8');

    return filePath.endsWith('.json') ? JSON.parse(content) : yaml.load(content) as Record<string, unknown>;
  }

  /**
   * Clear the cache
   */
  clearCache(): void {
    this.cache.clear();
  }

  private createDefaultLogger(): Logger {
    return {
      debug: () => {},
      info: () => {},
      warn: console.warn.bind(console),
      error: console.error.bind(console)
    };
  }
}

/**
 * Create a profile resolver with default configuration
 */
export function createProfileResolver(config?: ProfileResolverConfig): ProfileResolver {
  return new ProfileResolver(config);
}
