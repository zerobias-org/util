/**
 * Stage 3 — the review agent.
 *
 * Builds the provider request from the gathered context, runs it through the
 * configured ModelProvider, and parses the model's JSON response into a
 * ReviewResult.
 *
 * The JSON parse is deliberately tolerant — smaller local models sometimes
 * wrap output in markdown fences or add stray prose. Anything unparseable is
 * surfaced as an error rather than silently dropped.
 */

import type { KnowledgeConfig, ModelConfig } from '../config.js';
import { remoteSlug } from '../git.js';
import { openKnowledgeClient } from '../knowledge/factory.js';
import { createToolRunner, type ZbKnowledgeClient } from '../knowledge/zb-mcp.js';
import type { DiffSummary, ReviewContext, ReviewFinding, ReviewResult, Severity } from '../types.js';
import { buildReviewRequest } from './prompts.js';
import { createProvider } from './providers/factory.js';

/** Extract the first JSON object from raw model text, tolerating fences/prose. */
function extractJson(text: string): string {
  const trimmed = text.trim();
  // Strip a ```json ... ``` fence if present.
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fence ? fence[1].trim() : trimmed;
  // Fall back to the outermost { ... } span.
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) {
    throw new Error('model response contained no JSON object');
  }
  return candidate.slice(start, end + 1);
}

/**
 * Repair malformations smaller local models commonly emit in otherwise-valid
 * JSON: uppercase / Python literals in value position, and trailing commas.
 * Only literals that directly follow `:`, `,` or `[` are touched, so words
 * inside string values are left alone.
 */
function sanitizeJson(json: string): string {
  return json
    .replace(/([:,[]\s*)(?:NULL|Null|None)\b/g, '$1null')
    .replace(/([:,[]\s*)(?:True|TRUE)\b/g, '$1true')
    .replace(/([:,[]\s*)(?:False|FALSE)\b/g, '$1false')
    .replace(/,(\s*[}\]])/g, '$1');
}

/** Type guard for the Severity union. */
function isSeverity(value: unknown): value is Severity {
  return (
    value === 'critical' || value === 'high' || value === 'medium'
    || value === 'low' || value === 'nit'
  );
}

/** Coerce an unknown value into a 0..1 confidence, defaulting to 0.5. */
function toConfidence(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return 0.5;
  return Math.min(1, Math.max(0, n));
}

/** Normalize one raw finding object into a ReviewFinding (or drop it). */
function toFinding(raw: unknown): ReviewFinding | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const obj = raw as Record<string, unknown>;
  const file = typeof obj.file === 'string' ? obj.file : undefined;
  const message = typeof obj.message === 'string' ? obj.message : undefined;
  if (!file || !message) return undefined;
  return {
    file,
    line: typeof obj.line === 'number' && obj.line > 0 ? obj.line : undefined,
    severity: isSeverity(obj.severity) ? obj.severity : 'medium',
    confidence: toConfidence(obj.confidence),
    message,
  };
}

/**
 * The seed — the one deterministic knowledge query run up front. For each
 * changed file we ask zb-knowledge "what depends on this?" and hand the
 * combined answer to the model as static context, so it starts already knowing
 * the cross-repo blast radius instead of discovering it through tool calls.
 *
 * Returns undefined when the repo slug can't be resolved (no origin remote);
 * the affected-files tool needs an org/repo. Individual per-file failures are
 * skipped, never fatal.
 */
async function gatherSeed(
  client: ZbKnowledgeClient,
  diff: DiffSummary,
  fileLimit: number,
): Promise<string | undefined> {
  const slug = await remoteSlug();
  if (!slug) return undefined;

  const header = `Repository under review: ${slug.org}/${slug.repo}`;
  const targets = diff.files.filter((file) => file.status !== 'deleted').slice(0, fileLimit);

  const blocks: string[] = [];
  for (const file of targets) {
    try {
      const affected = await client.call('get_affected_files', {
        file_path: file.path,
        repo_org: slug.org,
        repo_name: slug.repo,
      });
      if (affected.trim()) blocks.push(`### ${file.path}\n${affected.trim()}`);
    } catch {
      // A single file's impact lookup failing must not sink the seed.
    }
  }

  return blocks.length > 0 ? [header, '', blocks.join('\n\n')].join('\n') : header;
}

/** Run the full review: build the request, call the model, parse findings. */
export async function runReview(
  context: ReviewContext,
  model: ModelConfig,
  knowledge: KnowledgeConfig,
): Promise<ReviewResult> {
  const provider = createProvider(model);
  const client = await openKnowledgeClient(knowledge);

  try {
    const seed = client
      ? await gatherSeed(client, context.diff, knowledge.seedFileLimit)
      : undefined;
    const tools = client?.toolSpecs();
    const runTool = client ? createToolRunner(client) : undefined;

    const request = buildReviewRequest(context, {
      seed,
      toolsAvailable: tools !== undefined && tools.length > 0,
    });
    const response = await provider.review(request, tools, runTool);
    return parseReviewResponse(response.text, response.model);
  } finally {
    await client?.close();
  }
}

/** Parse a model's raw review text into a ReviewResult. */
function parseReviewResponse(text: string, model: string): ReviewResult {
  let parsed: { summary?: unknown; findings?: unknown };
  try {
    parsed = JSON.parse(sanitizeJson(extractJson(text)));
  } catch (err) {
    const snippet = text.length > 800 ? `${text.slice(0, 800)}\n...[truncated]` : text;
    throw new Error(
      `Could not parse the model's review output as JSON ` +
      `(${err instanceof Error ? err.message : String(err)}).\n\n` +
      `Raw model output:\n${snippet}`,
    );
  }

  const findings = Array.isArray(parsed.findings)
    ? parsed.findings.map(toFinding).filter((f): f is ReviewFinding => f !== undefined)
    : [];

  return {
    summary: typeof parsed.summary === 'string' ? parsed.summary : '(no summary provided)',
    findings,
    model,
  };
}
