/**
 * Knowledge-layer factory.
 *
 * Brings up the zb-knowledge client when configured, and degrades gracefully:
 * if the layer is disabled, has no endpoint, or the server is unreachable, it
 * returns undefined and the reviewer runs a no-knowledge review. A missing
 * knowledge server must never fail a review (important for CI bootstrapping).
 */

import type { KnowledgeConfig } from '../config.js';
import { ZbKnowledgeClient } from './zb-mcp.js';

/**
 * Open a connected knowledge client, or undefined when knowledge is off or
 * unreachable. The caller owns the returned client's lifecycle (`close()`).
 */
export async function openKnowledgeClient(
  config: KnowledgeConfig,
): Promise<ZbKnowledgeClient | undefined> {
  if (!config.enabled || !config.endpoint) return undefined;

  const client = new ZbKnowledgeClient({
    transport: config.transport,
    endpoint: config.endpoint,
    headers: config.headers,
    resultBudget: config.resultBudget,
  });

  try {
    await client.connect();
    return client;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    console.warn(
      `pr-review: cross-repo knowledge disabled — could not reach the ` +
      `zb-knowledge server at "${config.endpoint}" (${detail}). ` +
      `Continuing with a repo-local review.`,
    );
    return undefined;
  }
}
