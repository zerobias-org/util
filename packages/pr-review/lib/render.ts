/**
 * Terminal rendering of a review result.
 *
 * Used in local mode, and — for Phase 1 — in ci mode too. Posting findings
 * as GitHub PR review comments lands in a later phase; until then ci mode
 * also prints, and the workflow captures the output.
 */

import type { ReviewResult, Severity } from './types.js';

/** Sort order for findings — most severe first. */
const SEVERITY_RANK: Record<Severity, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
  nit: 4,
};

/** Render a review result as plain text for the terminal. */
export function renderReview(result: ReviewResult): string {
  const lines: string[] = ['━━━ PR Review ━━━', '', result.summary, ''];

  if (result.findings.length === 0) {
    lines.push('No findings.');
  } else {
    const sorted = [...result.findings].sort(
      (a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity],
    );
    lines.push(`Findings (${sorted.length}):`, '');
    for (const f of sorted) {
      const loc = f.line === undefined ? f.file : `${f.file}:${f.line}`;
      const confidence = `${Math.round(f.confidence * 100)}%`;
      lines.push(`  [${f.severity.toUpperCase()}] ${loc}  (confidence ${confidence})`);
      lines.push(`    ${f.message}`, '');
    }
  }

  lines.push(`— reviewed by ${result.model}`);
  return lines.join('\n');
}
