/**
 * SecretsProvider - Abstract interface for secret retrieval
 *
 * Enables pluggable secret backends for different environments:
 * - Environment variables (CI)
 * - Local files (development)
 * - AWS Secrets Manager (production CI)
 * - HashiCorp Vault (enterprise)
 */

import type { Logger } from '../types.js';
import { EnvSecretsProvider } from './EnvSecretsProvider.js';
import { FileSecretsProvider } from './FileSecretsProvider.js';

/**
 * Base interface for all secrets providers
 */
export interface SecretsProvider {
  /**
   * Get secret values at the given path
   * @param path Secret path or key identifier
   * @returns Secret values as key-value pairs
   */
  getSecret(path: string): Promise<Record<string, unknown>>;

  /**
   * Check if this provider supports the given path
   * @param path Secret path or key identifier
   * @returns Whether this provider can handle the path
   */
  supports(path: string): boolean;

  /**
   * Get the provider name for logging
   */
  readonly name: string;
}

/**
 * Composite provider that tries multiple providers in order
 */
export class CompositeSecretsProvider implements SecretsProvider {
  readonly name = 'CompositeSecretsProvider';
  private providers: SecretsProvider[] = [];
  private logger: Logger;

  constructor(providers: SecretsProvider[], logger?: Logger) {
    this.providers = providers;
    this.logger = logger ?? this.createDefaultLogger();
  }

  /**
   * Add a provider to the chain
   */
  addProvider(provider: SecretsProvider): void {
    this.providers.push(provider);
  }

  /**
   * Get secret by trying each provider in order
   */
  async getSecret(path: string): Promise<Record<string, unknown>> {
    for (const provider of this.providers) {
      if (provider.supports(path)) {
        try {
          this.logger.debug(`Trying provider ${provider.name} for path: ${path}`);
          const secret = await provider.getSecret(path);
          this.logger.debug(`Provider ${provider.name} returned secret for: ${path}`);
          return secret;
        } catch (error) {
          this.logger.debug(`Provider ${provider.name} failed for ${path}: ${error}`);
          // Continue to next provider
        }
      }
    }

    throw new Error(`No provider could resolve secret at path: ${path}`);
  }

  /**
   * Check if any provider supports the path
   */
  supports(path: string): boolean {
    return this.providers.some(p => p.supports(path));
  }

  private createDefaultLogger(): Logger {
    return {
      debug: (msg: string, ...args: unknown[]) => console.debug(`[CompositeSecrets] ${msg}`, ...args),
      info: (msg: string, ...args: unknown[]) => console.info(`[CompositeSecrets] ${msg}`, ...args),
      warn: (msg: string, ...args: unknown[]) => console.warn(`[CompositeSecrets] ${msg}`, ...args),
      error: (msg: string, ...args: unknown[]) => console.error(`[CompositeSecrets] ${msg}`, ...args)
    };
  }
}

/**
 * Create a secrets provider based on environment detection
 */
export function createAutoSecretsProvider(logger?: Logger): SecretsProvider {
  const providers: SecretsProvider[] = [
    new EnvSecretsProvider(undefined, logger),
    new FileSecretsProvider(undefined, logger)
  ];

  return new CompositeSecretsProvider(providers, logger);
}
