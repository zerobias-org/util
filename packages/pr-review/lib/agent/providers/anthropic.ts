/**
 * Anthropic (Claude) model provider.
 *
 * Sends the static review context as a cached system block: the same repo
 * context is reused across calls for one PR, so prompt caching drops the
 * input cost to ~0.1x after the first request. The volatile diff goes in the
 * user message — after the cache breakpoint — so it never invalidates the
 * cached prefix.
 *
 * When tools are supplied, the provider runs an agentic loop: it streams a
 * turn, executes any tool_use blocks via the ToolRunner, feeds the results
 * back, and repeats until the model stops requesting tools or the tool-call
 * budget is spent (after which tools are withheld so the model must finalize).
 *
 * Streaming is used because a review (adaptive thinking + findings) can be
 * long enough to risk a non-streaming HTTP timeout.
 *
 * Built for Opus / Sonnet. Defaults: model claude-opus-4-7, effort high —
 * both valid together and a good fit for code review.
 */

import Anthropic from '@anthropic-ai/sdk';
import type { Effort } from '../../config.js';
import type {
  ModelProvider,
  ModelRequest,
  ModelResponse,
  ToolRunner,
  ToolSpec,
} from './types.js';

export interface AnthropicProviderConfig {
  /** Claude model ID, e.g. claude-opus-4-7. */
  model: string;
  /** Thinking effort. */
  effort: Effort;
  /** Max tool-use round-trips before the model is forced to finalize. */
  maxToolCalls: number;
  /** API key. When omitted, the SDK reads ANTHROPIC_API_KEY from the env. */
  apiKey?: string;
}

/** Output cap. Streaming is used, so this is generous without timeout risk. */
const MAX_TOKENS = 32_000;

export class AnthropicProvider implements ModelProvider {
  readonly name = 'anthropic';

  private readonly client: Anthropic;
  private readonly model: string;
  private readonly effort: Effort;
  private readonly maxToolCalls: number;

  constructor(config: AnthropicProviderConfig) {
    this.client = new Anthropic(config.apiKey ? { apiKey: config.apiKey } : undefined);
    this.model = config.model;
    this.effort = config.effort;
    this.maxToolCalls = config.maxToolCalls;
  }

  async review(
    req: ModelRequest,
    tools?: ToolSpec[],
    runTool?: ToolRunner,
  ): Promise<ModelResponse> {
    const system: Anthropic.TextBlockParam[] = [
      { type: 'text', text: req.system },
      {
        // The large, stable prefix — cached for reuse across calls.
        type: 'text',
        text: req.context,
        cache_control: { type: 'ephemeral' },
      },
    ];

    const anthropicTools: Anthropic.Tool[] | undefined =
      tools && tools.length > 0 && runTool
        ? tools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          input_schema: tool.input_schema,
        }))
        : undefined;

    const messages: Anthropic.MessageParam[] = [{ role: 'user', content: req.prompt }];

    let toolCalls = 0;
    let model = this.model;
    let inputTokens = 0;
    let outputTokens = 0;
    let cacheReadTokens = 0;

    for (;;) {
      // Once the budget is spent, withhold tools so the model must answer.
      const offerTools = anthropicTools !== undefined && toolCalls < this.maxToolCalls;

      const stream = this.client.messages.stream({
        model: this.model,
        max_tokens: MAX_TOKENS,
        thinking: { type: 'adaptive' },
        output_config: { effort: this.effort },
        system,
        messages,
        ...(offerTools ? { tools: anthropicTools } : {}),
      });

      const message = await stream.finalMessage();
      model = message.model;
      inputTokens += message.usage.input_tokens;
      outputTokens += message.usage.output_tokens;
      cacheReadTokens += message.usage.cache_read_input_tokens ?? 0;

      const toolUses = message.content.filter(
        (block): block is Anthropic.ToolUseBlock => block.type === 'tool_use',
      );

      if (!offerTools || message.stop_reason !== 'tool_use' || toolUses.length === 0) {
        const text = message.content
          .filter((block): block is Anthropic.TextBlock => block.type === 'text')
          .map((block) => block.text)
          .join('');
        return {
          text,
          model,
          usage: {
            inputTokens,
            outputTokens,
            cacheReadTokens: cacheReadTokens || undefined,
          },
        };
      }

      // Preserve the full assistant turn — thinking and tool_use blocks must be
      // sent back verbatim on the next request when extended thinking is on.
      messages.push({ role: 'assistant', content: message.content });

      const results: Anthropic.ToolResultBlockParam[] = [];
      for (const use of toolUses) {
        const output = await runTool!(use.name, (use.input ?? {}) as Record<string, unknown>);
        results.push({ type: 'tool_result', tool_use_id: use.id, content: output });
        toolCalls++;
      }
      messages.push({ role: 'user', content: results });
    }
  }
}
