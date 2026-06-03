/**
 * Local git helpers for the diff identifier and context gatherer.
 *
 * Phase 1 sources the diff from local git (`git diff base...HEAD`). A
 * GitHub-API source for ci mode (reviewing a real PR by number) is added in
 * a later phase — see README.md.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** Larger buffer than the 1 MB default — diffs and file contents can be big. */
const MAX_BUFFER = 32 * 1024 * 1024;

/** Run a git command and return its stdout. */
async function git(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { maxBuffer: MAX_BUFFER });
  return stdout;
}

/** Raw `git diff --name-status base...HEAD` output. */
export function diffNameStatus(base: string): Promise<string> {
  return git(['diff', '--name-status', `${base}...HEAD`]);
}

/** Unified diff text for `base...HEAD`. */
export function diffPatch(base: string): Promise<string> {
  return git(['diff', `${base}...HEAD`]);
}

/**
 * Content of a file at HEAD. Returns undefined when the path does not exist
 * there (e.g. a deleted file, or a binary `git show` rejects).
 */
export async function fileAtHead(path: string): Promise<string | undefined> {
  try {
    return await git(['show', `HEAD:${path}`]);
  } catch {
    return undefined;
  }
}

/** GitHub org + repo, e.g. { org: 'zerobias-org', repo: 'util' }. */
export interface RepoSlug {
  org: string;
  repo: string;
}

/**
 * Parse the org/repo out of a remote URL. Handles the SSH
 * (`git@github.com:org/repo.git`), HTTPS (`https://github.com/org/repo.git`),
 * and `ssh://` forms by taking the last two path segments.
 */
function parseSlug(url: string): RepoSlug | undefined {
  const parts = url.trim().replace(/\.git$/, '').split(/[/:]/).filter(Boolean);
  if (parts.length < 2) return undefined;
  const [org, repo] = parts.slice(-2);
  return org && repo ? { org, repo } : undefined;
}

/**
 * The GitHub org + repo for the `origin` remote, used to scope zb-knowledge
 * lookups. Returns undefined when there is no origin (e.g. a detached checkout).
 */
export async function remoteSlug(): Promise<RepoSlug | undefined> {
  try {
    return parseSlug(await git(['remote', 'get-url', 'origin']));
  } catch {
    return undefined;
  }
}
