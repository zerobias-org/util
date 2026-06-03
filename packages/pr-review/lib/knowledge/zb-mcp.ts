/**
 * zb-knowledge MCP client and ToolRunner.
 *
 * This module is the only place that speaks MCP. It connects to the
 * zb-knowledge server (stdio or streamable-HTTP), exposes a curated subset of
 * its tools as `ToolSpec`s for the review model, and routes the model's tool
 * calls to the server. The provider depends only on the `ToolRunner` contract
 * and never imports anything here.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { KnowledgeTransport } from '../config.js';
import type { ToolRunner, ToolSpec } from '../agent/providers/types.js';

/**
 * zb-knowledge tools exposed to the review model. `health_check` and
 * `list_repos` are deliberately omitted — they are operator diagnostics, not
 * review signal, and only add noise to the model's tool menu.
 */
const TOOL_ALLOWLIST: ReadonlySet<string> = new Set([
  'search_code',
  'get_file',
  'get_affected_files',
  'get_dependency_chain',
  'check_package_versions',
]);

export interface ZbKnowledgeClientConfig {
  transport: KnowledgeTransport;
  /** stdio: a command line (e.g. "npx -y @zerobias-org/zb-knowledge-mcp"); http: a URL. */
  endpoint: string;
  /** Extra HTTP headers (auth) for the http transport. */
  headers?: Record<string, string>;
  /** Per-tool-result char cap fed back to the model. */
  resultBudget: number;
}

/** A text content block as returned by an MCP tool call. */
interface TextBlock {
  type: string;
  text: string;
}

function isTextBlock(block: unknown): block is TextBlock {
  return (
    typeof block === 'object' &&
    block !== null &&
    (block as { type?: unknown }).type === 'text' &&
    typeof (block as { text?: unknown }).text === 'string'
  );
}

function isObjectSchema(schema: unknown): schema is ToolSpec['input_schema'] {
  return (
    typeof schema === 'object' &&
    schema !== null &&
    (schema as { type?: unknown }).type === 'object'
  );
}

export class ZbKnowledgeClient {
  private readonly client: Client;
  private readonly config: ZbKnowledgeClientConfig;
  private specs: ToolSpec[] = [];

  constructor(config: ZbKnowledgeClientConfig) {
    this.config = config;
    this.client = new Client({ name: 'pr-review', version: '0.0.1' });
  }

  /** Connect to the server and cache the curated tool specs. */
  async connect(): Promise<void> {
    await this.client.connect(this.makeTransport());
    const { tools } = await this.client.listTools();
    this.specs = tools
      .filter((tool) => TOOL_ALLOWLIST.has(tool.name))
      .flatMap((tool) =>
        isObjectSchema(tool.inputSchema)
          ? [{
            name: tool.name,
            description: tool.description ?? '',
            input_schema: tool.inputSchema,
          }]
          : [],
      );
  }

  /** The curated tools the model may call. */
  toolSpecs(): ToolSpec[] {
    return this.specs;
  }

  /**
   * Invoke a tool and return its text content, clamped to the result budget.
   * Throws on transport/server errors — callers wrap this (see createToolRunner
   * and the seed) so a failure never crashes the review.
   */
  async call(name: string, input: Record<string, unknown>): Promise<string> {
    const result = await this.client.callTool({ name, arguments: input });
    const blocks = Array.isArray(result.content) ? result.content : [];
    const text = blocks.filter(isTextBlock).map((block) => block.text).join('\n');
    return this.clamp(text);
  }

  async close(): Promise<void> {
    await this.client.close();
  }

  private makeTransport(): Transport {
    if (this.config.transport === 'http') {
      return new StreamableHTTPClientTransport(new URL(this.config.endpoint), {
        requestInit: this.config.headers ? { headers: this.config.headers } : undefined,
      });
    }
    const [command, ...args] = this.config.endpoint.split(/\s+/).filter(Boolean);
    return new StdioClientTransport({ command, args });
  }

  private clamp(text: string): string {
    if (text.length <= this.config.resultBudget) return text;
    return `${text.slice(0, this.config.resultBudget)}\n... [truncated]`;
  }
}

/**
 * Wrap a client as a `ToolRunner` for the provider's tool-use loop. Errors are
 * returned as text — never thrown — so the model reacts to a failed lookup
 * instead of aborting the whole review.
 */
export function createToolRunner(client: ZbKnowledgeClient): ToolRunner {
  return async (name, input) => {
    try {
      return await client.call(name, input);
    } catch (err) {
      return `Tool ${name} failed: ${err instanceof Error ? err.message : String(err)}`;
    }
  };
}
