/**
 * GitHub sink — posts the review as a single PR comment, upserted.
 *
 * Re-running a review must not spam the PR, so the comment body carries a
 * hidden marker (see markdown.ts): on a re-run we find the existing marked
 * comment and PATCH it instead of posting a new one.
 *
 * Uses the native fetch (Node 22+) against the GitHub REST API — no SDK,
 * consistent with the OpenAI-compatible provider.
 */

import type { PrContext } from '../github.js';
import type { ReviewResult } from '../types.js';
import { COMMENT_MARKER, renderMarkdown } from './markdown.js';
import type { ReviewSink } from './types.js';

const API_BASE = 'https://api.github.com';
const PER_PAGE = 100;

/** The subset of an issue comment we read. */
interface IssueComment {
  id: number;
  body?: string;
}

export class GitHubSink implements ReviewSink {
  readonly name = 'github';

  constructor(private readonly ctx: PrContext) {}

  async publish(result: ReviewResult): Promise<void> {
    const body = renderMarkdown(result);
    const { owner, repo, prNumber } = this.ctx;
    const existingId = await this.findExistingComment();

    if (existingId !== undefined) {
      await this.request('PATCH', `/repos/${owner}/${repo}/issues/comments/${existingId}`, { body });
      console.log(`pr-review: updated review comment on ${owner}/${repo}#${prNumber}`);
    } else {
      await this.request('POST', `/repos/${owner}/${repo}/issues/${prNumber}/comments`, { body });
      console.log(`pr-review: posted review comment on ${owner}/${repo}#${prNumber}`);
    }
  }

  /** Find the id of a prior pr-review comment on this PR, if any. */
  private async findExistingComment(): Promise<number | undefined> {
    const { owner, repo, prNumber } = this.ctx;
    for (let page = 1; ; page++) {
      const comments = await this.request<IssueComment[]>(
        'GET',
        `/repos/${owner}/${repo}/issues/${prNumber}/comments?per_page=${PER_PAGE}&page=${page}`,
      );
      const match = comments.find((comment) => comment.body?.includes(COMMENT_MARKER));
      if (match) return match.id;
      if (comments.length < PER_PAGE) return undefined;
    }
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.ctx.token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    };
    if (body !== undefined) headers['Content-Type'] = 'application/json';

    const response = await fetch(`${API_BASE}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(
        `GitHub API ${method} ${path} failed: ${response.status} ${response.statusText}` +
        (detail ? ` — ${detail}` : ''),
      );
    }

    const text = await response.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }
}
