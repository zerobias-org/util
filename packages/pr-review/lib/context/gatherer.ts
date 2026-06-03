/**
 * Stage 2 — the context gatherer.
 *
 * Builds the ReviewContext the agent reviews against. Phase 1 gathers:
 *   - each changed file's full post-change content
 *   - the repo's own docs (CLAUDE.md / README.md), so the review enforces
 *     the repo's conventions
 *
 * A knowledge-base retrieval source is added in Phase 2 — see README.md.
 */

import { readFile } from 'node:fs/promises';
import { fileAtHead } from '../git.js';
import type { DiffSummary, FileContext, ReviewContext } from '../types.js';

/** Repo doc files to include, in priority order. */
const REPO_DOC_FILES: readonly string[] = ['CLAUDE.md', 'README.md'];

/** Per-file content cap — keeps one huge file from dominating the context. */
const MAX_FILE_CHARS = 60_000;

/** Read the repo's own documentation to ground the review in its conventions. */
async function gatherRepoDocs(): Promise<string> {
  const parts: string[] = [];
  for (const name of REPO_DOC_FILES) {
    try {
      const content = await readFile(name, 'utf-8');
      parts.push(`### ${name}\n\n${content}`);
    } catch {
      // Doc file absent — skip it.
    }
  }
  return parts.join('\n\n');
}

/** Truncate over-long content, leaving a visible marker. */
function clamp(content: string): string {
  if (content.length <= MAX_FILE_CHARS) return content;
  return `${content.slice(0, MAX_FILE_CHARS)}\n... [truncated]`;
}

/** Gather the full review context for a diff. */
export async function gatherContext(diff: DiffSummary): Promise<ReviewContext> {
  const files: FileContext[] = [];
  for (const file of diff.files) {
    // Deleted files have no post-change content to read.
    const raw = file.status === 'deleted' ? undefined : await fileAtHead(file.path);
    files.push({
      path: file.path,
      status: file.status,
      isContract: file.isContract,
      content: raw === undefined ? undefined : clamp(raw),
    });
  }

  const repoDocs = await gatherRepoDocs();

  return { diff, files, repoDocs };
}
