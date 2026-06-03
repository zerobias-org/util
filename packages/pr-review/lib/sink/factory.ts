/**
 * Sink factory — picks where the review goes.
 *
 * ci mode posts to the PR; local prints. `--post` forces posting from local
 * (useful for testing the GitHub path). When posting is wanted but the PR
 * context can't be resolved, it degrades to the terminal rather than failing.
 */

import { resolvePrContext } from '../github.js';
import type { Mode } from '../mode.js';
import { GitHubSink } from './github.js';
import { TerminalSink } from './terminal.js';
import type { ReviewSink } from './types.js';

export interface SinkOptions {
  mode: Mode;
  /** Force the GitHub sink even in local mode. */
  post: boolean;
  /** Explicit PR number (`--pr`), if given. */
  prNumber?: number;
}

export async function createSink(options: SinkOptions): Promise<ReviewSink> {
  const wantPost = options.mode === 'ci' || options.post;
  if (!wantPost) return new TerminalSink();

  const ctx = await resolvePrContext(options.prNumber);
  if (!ctx) {
    console.warn(
      'pr-review: cannot post to GitHub — missing PR number, repo, or token. ' +
      'Printing to the terminal instead.',
    );
    return new TerminalSink();
  }
  return new GitHubSink(ctx);
}
