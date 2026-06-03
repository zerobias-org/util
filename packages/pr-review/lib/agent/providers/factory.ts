/**
 * Model-provider factory.
 *
 * Builds the `ModelProvider` selected by config. This is the only module
 * that references concrete provider classes — the reviewer asks the factory
 * for a provider and depends solely on the `ModelProvider` interface.
 */

import type { ModelConfig } from '../../config.js';
import { AnthropicProvider } from './anthropic.js';
import { OpenAICompatibleProvider } from './openai-compat.js';
import type { ModelProvider } from './types.js';

/**
 * Construct the provider for the given config.
 *
 * Secrets are read from the environment here, not threaded through config:
 *   ANTHROPIC_API_KEY        — Anthropic provider (CI: vault-action; local: shell/zbb)
 *   PR_REVIEW_LOCAL_API_KEY  — optional bearer token for the local endpoint
 */
export function createProvider(config: ModelConfig): ModelProvider {
  switch (config.provider) {
    case 'anthropic':
      return new AnthropicProvider({
        model: config.anthropic.model,
        effort: config.anthropic.effort,
        maxToolCalls: config.anthropic.maxToolCalls,
        apiKey: process.env.ANTHROPIC_API_KEY,
      });

    case 'local':
      return new OpenAICompatibleProvider({
        baseUrl: config.local.baseUrl,
        model: config.local.model,
        apiKey: process.env.PR_REVIEW_LOCAL_API_KEY,
      });

    default: {
      // Exhaustiveness check — adding a ProviderKind without a case here
      // becomes a compile error.
      const unreachable: never = config.provider;
      throw new Error(`Unknown model provider: ${String(unreachable)}`);
    }
  }
}
