/**
 * Markdown rendering of a review for a GitHub PR comment.
 *
 * The body ends with a hidden HTML marker so a re-run can find and update the
 * same comment instead of posting a duplicate (see GitHubSink).
 */

import type { ReviewResult, Severity } from '../types.js';

/** Hidden marker that identifies a pr-review comment for upsert. */
export const COMMENT_MARKER = '<!-- pr-review -->';

/** Sort order for findings — most severe first. */
const SEVERITY_RANK: Record<Severity, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
  nit: 4,
};

/** Render a review result as a GitHub-flavored markdown comment body. */
export function renderMarkdown(result: ReviewResult): string {
  const parts: string[] = ['## PR Review', '', result.summary.trim(), ''];

  if (result.findings.length === 0) {
    parts.push('No findings.');
  } else {
    const sorted = [...result.findings].sort(
      (a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity],
    );
    parts.push(`### Findings (${sorted.length})`, '');
    for (const finding of sorted) {
      const loc = finding.line === undefined ? finding.file : `${finding.file}:${finding.line}`;
      const confidence = `${Math.round(finding.confidence * 100)}%`;
      // One block per finding (not a list item) so multi-line messages render.
      parts.push(`**[${finding.severity.toUpperCase()}]** \`${loc}\` · confidence ${confidence}`);
      parts.push('');
      parts.push(finding.message.trim());
      parts.push('');
    }
  }

  parts.push(`<sub>— reviewed by ${result.model}</sub>`, '', COMMENT_MARKER);
  return parts.join('\n');
}
