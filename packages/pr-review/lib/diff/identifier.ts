/**
 * Stage 1 — the diff identifier.
 *
 * Produces a DiffSummary: the changed files (classified by status and by
 * whether they are API/schema contracts) plus the unified diff text.
 *
 * Phase 1 works at file granularity. Method/API-symbol extraction (an AST
 * pass) is a later enhancement — see README.md.
 */

import { diffNameStatus, diffPatch } from '../git.js';
import type { ChangedFile, DiffSummary, FileStatus } from '../types.js';

/**
 * Path patterns that identify an API/schema contract. A change to one of
 * these has wider blast radius than ordinary code, so the reviewer flags it.
 */
const CONTRACT_PATTERNS: readonly RegExp[] = [
  /\.openapi\.ya?ml$/i,
  /openapi\.ya?ml$/i,
  /\.schema\.json$/i,
  /(^|\/)schema\//i,
];

/** Map a `git diff --name-status` status letter to a FileStatus. */
function parseStatus(code: string): FileStatus {
  switch (code[0]) {
    case 'A': return 'added';
    case 'D': return 'deleted';
    case 'R': return 'renamed';
    default:  return 'modified';
  }
}

/** True when a path looks like an API/schema contract. */
function isContractPath(path: string): boolean {
  return CONTRACT_PATTERNS.some((pattern) => pattern.test(path));
}

/** Identify everything that changed between `base` and HEAD. */
export async function identifyDiff(base: string): Promise<DiffSummary> {
  const nameStatus = await diffNameStatus(base);

  const files: ChangedFile[] = nameStatus
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      const fields = line.split(/\s+/);
      // Renames are emitted as `R100 old new` — the new path is the last field.
      const path = fields[fields.length - 1];
      return {
        path,
        status: parseStatus(fields[0]),
        isContract: isContractPath(path),
      };
    });

  const patch = await diffPatch(base);

  return { base, head: 'HEAD', files, patch };
}
