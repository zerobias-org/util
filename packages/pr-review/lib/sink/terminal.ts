/**
 * Terminal sink — prints the review to stdout. The local-mode default, and
 * the fallback whenever GitHub posting isn't possible.
 */

import { renderReview } from '../render.js';
import type { ReviewResult } from '../types.js';
import type { ReviewSink } from './types.js';

export class TerminalSink implements ReviewSink {
  readonly name = 'terminal';

  async publish(result: ReviewResult): Promise<void> {
    console.log('');
    console.log(renderReview(result));
  }
}
