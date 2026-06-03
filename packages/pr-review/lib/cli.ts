/**
 * pr-review — CLI entry point and command router.
 *
 * Commands:
 *   pr-review review [--base <ref>] [--pr <n>] [--provider <kind>]
 *   pr-review index
 *   pr-review --help
 *
 * `review` runs the full pipeline: diff -> context -> agent. Mode is
 * auto-detected (see mode.ts); Phase 1 prints the result to the terminal in
 * both modes — posting GitHub PR comments lands in a later phase.
 */

import { runReview } from './agent/reviewer.js';
import { resolveConfig, type ProviderKind, type ReviewFlags } from './config.js';
import { gatherContext } from './context/gatherer.js';
import { identifyDiff } from './diff/identifier.js';
import { createSink } from './sink/factory.js';

/** Validate a `--provider` flag value, throwing a clear error if invalid. */
function parseProviderFlag(value: string): ProviderKind {
  if (value === 'anthropic' || value === 'local') return value;
  throw new Error(`Invalid --provider '${value}' — expected 'anthropic' or 'local'.`);
}

/** Parse the `review` subcommand's flags. */
function parseReviewFlags(args: string[]): ReviewFlags {
  const flags: ReviewFlags = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--base' && args[i + 1]) {
      flags.base = args[++i];
    } else if (arg === '--pr' && args[i + 1]) {
      flags.pr = Number(args[++i]);
    } else if (arg === '--provider' && args[i + 1]) {
      flags.provider = parseProviderFlag(args[++i]);
    } else if (arg === '--post') {
      flags.post = true;
    }
  }
  return flags;
}

/** `pr-review review` — run the review pipeline. */
async function runReviewCommand(args: string[]): Promise<void> {
  const flags = parseReviewFlags(args);
  const config = resolveConfig(flags);
  console.log(
    `pr-review: mode=${config.mode} base=${config.base} ` +
    `provider=${config.model.provider} ` +
    `knowledge=${config.knowledge.enabled ? 'on' : 'off'}` +
    (config.prNumber ? ` pr=#${config.prNumber}` : ''),
  );

  const diff = await identifyDiff(config.base);
  if (diff.files.length === 0) {
    console.log(`No changes between ${config.base} and HEAD — nothing to review.`);
    return;
  }
  console.log(`Reviewing ${diff.files.length} changed file(s)...`);

  const context = await gatherContext(diff);
  const result = await runReview(context, config.model, config.knowledge);

  const sink = await createSink({
    mode: config.mode,
    post: flags.post ?? false,
    prNumber: config.prNumber,
  });
  await sink.publish(result);
}

/** `pr-review index` — Phase 2 placeholder. */
function runIndexCommand(): void {
  console.log('[Phase 1] pr-review index: knowledge-base indexer arrives in Phase 2.');
}

/** Print CLI usage. */
function printUsage(): void {
  console.log(`pr-review — agentic PR review for ZeroBias repos

Usage:
  pr-review review [options]    Run the PR review pipeline
  pr-review index               Rebuild the knowledge-base index (Phase 2)
  pr-review --help               Show this help

review options:
  --base <ref>          Git ref to diff against (default: main)
  --pr <number>         PR number, when reviewing a GitHub PR
  --provider <kind>     Model backend: anthropic | local
  --post                Post the review to the PR (forced; ci posts by default)

Mode is auto-detected: GitHub Actions => ci, otherwise => local.
ci mode posts the review as a PR comment; local prints to the terminal.`);
}

/** CLI entry point. Invoked by bin/pr-review.mjs. */
export async function main(argv: string[]): Promise<void> {
  const args = argv.slice(2);
  const command = args[0];

  switch (command) {
    case 'review':
      return runReviewCommand(args.slice(1));
    case 'index':
      return runIndexCommand();
    case undefined:
    case '--help':
    case '-h':
      return printUsage();
    default:
      console.error(`Unknown command: ${command}\n`);
      printUsage();
      process.exit(1);
  }
}
