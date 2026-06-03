/**
 * The pluggable model layer.
 *
 * The review agent depends only on `ModelProvider` — it never imports a
 * vendor SDK or hard-codes an endpoint. Two implementations exist:
 *
 *   AnthropicProvider          — Claude, via @anthropic-ai/sdk
 *   OpenAICompatibleProvider   — any OpenAI-compatible /v1 endpoint, which
 *                                covers local OSS models (qwen3-coder served
 *                                by Ollama or vLLM) as well as OpenAI itself.
 *
 * Which one runs is a config choice (see config.ts), resolved by the factory.
 */

/** A single review request handed to a provider. */
export interface ModelRequest {
  /** Instruction prompt — defines the reviewer's role and required output. */
  system: string;
  /**
   * Large, static review context: changed-file contents plus repo docs.
   * Stable across calls for the same PR — providers cache it where they can
   * (Anthropic via `cache_control`; vLLM / Ollama via their own prefix caches).
   */
  context: string;
  /** The volatile part — the diff and the specific ask. Varies per call. */
  prompt: string;
}

/** Token usage, when a provider reports it. */
export interface ModelUsage {
  inputTokens?: number;
  outputTokens?: number;
  /** Tokens served from the prompt cache (Anthropic only). */
  cacheReadTokens?: number;
}

/** A provider's response to a `ModelRequest`. */
export interface ModelResponse {
  /** Raw model output text. The reviewer parses this into findings. */
  text: string;
  /** The model that actually produced the response, for logging. */
  model: string;
  usage?: ModelUsage;
}

/**
 * A tool the review model may call, in Anthropic tool-spec shape. Produced by
 * the knowledge layer (from the zb-knowledge MCP server) and handed to the
 * provider; the provider never constructs these itself.
 */
export interface ToolSpec {
  name: string;
  description: string;
  input_schema: {
    type: 'object';
    properties?: Record<string, unknown>;
    required?: string[];
  };
}

/**
 * Executes one tool call on the model's behalf and returns text to feed back
 * as a tool_result. Implementations MUST NOT throw — a failed call returns the
 * error as a string so the model can adapt rather than crash the review.
 */
export type ToolRunner = (
  name: string,
  input: Record<string, unknown>,
) => Promise<string>;

/** A pluggable model backend. */
export interface ModelProvider {
  /** Short identifier for logs — 'anthropic' or 'local'. */
  readonly name: string;
  /**
   * Run one review. When `tools` and `runTool` are supplied, a tool-capable
   * provider (Anthropic) runs an agentic loop, calling `runTool` until it has
   * gathered enough context; providers without tool support ignore them and
   * answer in a single shot.
   */
  review(
    req: ModelRequest,
    tools?: ToolSpec[],
    runTool?: ToolRunner,
  ): Promise<ModelResponse>;
}
