/**
 * OpenAI-compatible model provider.
 *
 * Talks to any endpoint exposing the OpenAI `/v1/chat/completions` API. That
 * covers local OSS models — qwen3-coder served by Ollama or vLLM — as well as
 * OpenAI, OpenRouter, and similar. The local-model path is the primary use
 * case: it is free, and the code never leaves the machine.
 *
 * Uses the native `fetch` (Node 22+) — no SDK dependency. Prompt caching is
 * left to the server (vLLM does automatic prefix caching; Ollama keeps a
 * context cache), so no per-request cache markers are needed here.
 */

import type { ModelProvider, ModelRequest, ModelResponse } from './types.js';

export interface OpenAICompatibleProviderConfig {
  /** Endpoint base URL including the /v1 path, e.g. http://localhost:11434/v1 */
  baseUrl: string;
  /** Model name, e.g. qwen3-coder. */
  model: string;
  /** Optional bearer token (Ollama needs none; vLLM / OpenAI / OpenRouter may). */
  apiKey?: string;
}

/** Minimal shape of an OpenAI chat-completions response. */
interface ChatCompletionResponse {
  model?: string;
  choices?: Array<{ message?: { content?: string } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

const MAX_TOKENS = 32_000;

export class OpenAICompatibleProvider implements ModelProvider {
  readonly name = 'local';

  private readonly baseUrl: string;
  private readonly model: string;
  private readonly apiKey?: string;

  constructor(config: OpenAICompatibleProviderConfig) {
    // Drop any trailing slash so the request path appends cleanly.
    this.baseUrl = config.baseUrl.replace(/\/+$/, '');
    this.model = config.model;
    this.apiKey = config.apiKey;
  }

  async review(req: ModelRequest): Promise<ModelResponse> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: this.model,
          max_tokens: MAX_TOKENS,
          messages: [
            // The instruction + static context go in the system message;
            // the volatile diff goes in the user message.
            { role: 'system', content: `${req.system}\n\n${req.context}` },
            { role: 'user', content: req.prompt },
          ],
        }),
      });
    } catch (err) {
      throw new Error(
        `Could not reach the model endpoint at ${this.baseUrl} — ` +
        `is the server running? (${err instanceof Error ? err.message : String(err)})`,
      );
    }

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(
        `Model endpoint ${this.baseUrl} returned ${response.status} ${response.statusText}` +
        (detail ? `: ${detail}` : ''),
      );
    }

    const json = (await response.json()) as ChatCompletionResponse;
    const text = json.choices?.[0]?.message?.content ?? '';
    if (!text) {
      throw new Error(`Model endpoint ${this.baseUrl} returned an empty response.`);
    }

    return {
      text,
      model: json.model ?? this.model,
      usage: json.usage
        ? {
          inputTokens: json.usage.prompt_tokens,
          outputTokens: json.usage.completion_tokens,
        }
        : undefined,
    };
  }
}
