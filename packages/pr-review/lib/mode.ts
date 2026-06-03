/**
 * Execution-mode detection.
 *
 * pr-review runs in two contexts that share an identical core pipeline
 * (diff -> context -> agent). Only the edges differ:
 *
 *   ci     — inside GitHub Actions: reviews a real PR, posts review comments.
 *   local  — on a developer machine: reviews the current branch, prints to
 *            the terminal.
 *
 * The mode is detected exactly once, here, and threaded through as config.
 * No other module should branch on `process.env.GITHUB_ACTIONS`.
 */

export type Mode = 'ci' | 'local';

/**
 * Detect the execution mode.
 *
 * GitHub Actions sets `GITHUB_ACTIONS=true` on every runner — its presence is
 * the single authoritative CI signal. Anything else is treated as local.
 */
export function detectMode(): Mode {
  return process.env.GITHUB_ACTIONS === 'true' ? 'ci' : 'local';
}
