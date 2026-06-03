/**
 * The output sink — the *edge* of the pipeline that differs by mode.
 *
 * The diff -> context -> agent core is environment-agnostic; only where the
 * result goes changes: the terminal (local) or a GitHub PR comment (ci). The
 * reviewer never knows which sink it feeds.
 */

import type { ReviewResult } from '../types.js';

export interface ReviewSink {
  /** Short identifier for logs — 'terminal' or 'github'. */
  readonly name: string;
  /** Deliver a finished review to its destination. */
  publish(result: ReviewResult): Promise<void>;
}
