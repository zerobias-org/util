/**
 * Prompts for the review agent.
 *
 * The review asks for coverage, not self-filtering: every finding is
 * reported with a severity and a confidence score, and a downstream step
 * (Phase 3) does the ranking. This follows Anthropic's code-review guidance —
 * models that self-filter for "importance" depress recall.
 */

import type { ReviewContext } from '../types.js';
import type { ModelRequest } from './providers/types.js';

/** The reviewer's role and required output contract. */
export const SYSTEM_PROMPT = `You are a meticulous senior code reviewer for the ZeroBias monorepo.

You review a pull request diff against the repository's own conventions,
which are provided as repo docs in the context. Report every issue you find —
including ones you are uncertain about or consider low-severity. Do not
filter for importance or confidence; a separate downstream step does the
ranking. Coverage is the goal.

For each finding provide:
  - file: repo-relative path
  - line: line number in the new file when you can identify one (omit otherwise)
  - severity: one of critical | high | medium | low | nit
  - confidence: a number from 0 to 1
  - message: a clear, specific description and, where useful, a suggested fix

Pay special attention to files marked [CONTRACT] — OpenAPI specs and JSON
schemas — where a breaking change has wide blast radius.

Respond with ONLY a JSON object, no prose and no markdown fences, of the form:
{
  "summary": "one-paragraph overall assessment",
  "findings": [
    { "file": "...", "line": 0, "severity": "...", "confidence": 0.0, "message": "..." }
  ]
}
If you find no issues, return an empty "findings" array.`;

/**
 * Appended to the system prompt when zb-knowledge tools are available. Tells
 * the model it can reach beyond the PR into the wider org, and — crucially —
 * that the final turn must still be the JSON-only contract above.
 */
const TOOLS_CLAUSE = `

You also have tools to query the wider ZeroBias codebase (other repositories):
  - search_code(query, repo_name?, repo_org?, file_path?, language?)
  - get_file(file_path, repo_org, repo_name)
  - get_affected_files(file_path, repo_org, repo_name, symbol?)
  - get_dependency_chain(file_path, repo_org, repo_name, symbol?)
  - check_package_versions(repo_org?, repo_name?)
Use them to verify cross-repo impact before finalizing — for example, inspect
how callers in other repositories use a changed export, or whether a contract
change breaks a downstream consumer. The cross-repo impact section below seeds
the most likely starting points. Investigate as much as you need, then stop
calling tools and respond with ONLY the final JSON object described above.`;

/** Options that adapt the request to the available knowledge layer. */
export interface ReviewRequestOptions {
  /** Pre-fetched cross-repo impact (affected files), injected as static context. */
  seed?: string;
  /** Whether zb-knowledge tools are offered to the model this run. */
  toolsAvailable?: boolean;
}

/** Render the static review context (file contents + repo docs) as text. */
function renderContext(context: ReviewContext): string {
  const fileBlocks = context.files.map((file) => {
    const tag = file.isContract ? ' [CONTRACT]' : '';
    const header = `=== ${file.path} (${file.status})${tag} ===`;
    const body = file.content ?? '(file deleted)';
    return `${header}\n${body}`;
  });

  return [
    '## Repository conventions',
    context.repoDocs || '(no repo docs found)',
    '## Changed files (full post-change content)',
    fileBlocks.join('\n\n'),
  ].join('\n\n');
}

/**
 * Build the provider request for a review. The static context (file
 * contents + repo docs + the cross-repo seed) is kept separate from the
 * volatile diff so the Anthropic provider can cache the former across calls.
 */
export function buildReviewRequest(
  context: ReviewContext,
  options: ReviewRequestOptions = {},
): ModelRequest {
  const system = options.toolsAvailable ? `${SYSTEM_PROMPT}${TOOLS_CLAUSE}` : SYSTEM_PROMPT;

  const contextParts = [renderContext(context)];
  if (options.seed) {
    contextParts.push(`## Cross-repo impact (from zb-knowledge)\n\n${options.seed}`);
  }

  return {
    system,
    context: contextParts.join('\n\n'),
    prompt:
      'Review this unified diff. The full file contents and the repo ' +
      'conventions are in the context above.\n\n' +
      context.diff.patch,
  };
}
