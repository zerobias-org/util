/**
 * GitHub PR context resolution for the github sink.
 *
 * Pulls owner/repo, the PR number, and an API token from the environment —
 * the GitHub Actions context in ci, or local flags / `gh` on a dev machine.
 * Returns undefined when any piece is missing, so the caller can fall back to
 * the terminal rather than fail the review.
 */

import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { remoteSlug } from './git.js';

const execFileAsync = promisify(execFile);

export interface PrContext {
  owner: string;
  repo: string;
  prNumber: number;
  token: string;
}

/** Token from env (CI / explicit), else the local `gh` CLI session. */
async function resolveToken(): Promise<string | undefined> {
  const fromEnv = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (fromEnv) return fromEnv;
  try {
    const { stdout } = await execFileAsync('gh', ['auth', 'token']);
    return stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

/** owner/repo from the Actions env, else the origin remote. */
async function resolveOwnerRepo(): Promise<{ owner: string; repo: string } | undefined> {
  const fromEnv = process.env.GITHUB_REPOSITORY;
  if (fromEnv?.includes('/')) {
    const [owner, repo] = fromEnv.split('/');
    if (owner && repo) return { owner, repo };
  }
  const slug = await remoteSlug();
  return slug ? { owner: slug.org, repo: slug.repo } : undefined;
}

/** PR number from an explicit flag, else the Actions event payload. */
async function resolvePrNumber(explicit?: number): Promise<number | undefined> {
  if (explicit && explicit > 0) return explicit;

  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (eventPath) {
    try {
      const payload = JSON.parse(await readFile(eventPath, 'utf-8')) as {
        pull_request?: { number?: number };
        number?: number;
      };
      const number = payload.pull_request?.number ?? payload.number;
      if (typeof number === 'number' && number > 0) return number;
    } catch {
      // Malformed/absent payload — fall through to undefined.
    }
  }
  return undefined;
}

/** Resolve the full PR context, or undefined when posting isn't possible. */
export async function resolvePrContext(explicitPr?: number): Promise<PrContext | undefined> {
  const [ownerRepo, token, prNumber] = await Promise.all([
    resolveOwnerRepo(),
    resolveToken(),
    resolvePrNumber(explicitPr),
  ]);
  if (!ownerRepo || !token || prNumber === undefined) return undefined;
  return { ...ownerRepo, prNumber, token };
}
