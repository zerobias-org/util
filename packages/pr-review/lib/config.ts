/**
 * Configuration for pr-review.
 *
 * The model layer has two backends, chosen by `provider`:
 *   - 'anthropic' — Claude via @anthropic-ai/sdk
 *   - 'local'     — any OpenAI-compatible endpoint (qwen3-coder via Ollama or
 *                   vLLM, OpenAI, OpenRouter, ...)
 *
 * Resolution precedence: explicit flags > environment variables > defaults.
 * The committed `.pr-review.yml` policy file is layered in a later phase.
 */

import { detectMode, type Mode } from './mode.js';

/** Which model backend to use. */
export type ProviderKind = 'anthropic' | 'local';

/** Thinking effort for the Anthropic provider. `max` is Opus-tier only. */
export type Effort = 'low' | 'medium' | 'high' | 'max';

/** Resolved model-layer configuration. */
export interface ModelConfig {
  provider: ProviderKind;
  anthropic: {
    /** Claude model ID, e.g. claude-opus-4-7. */
    model: string;
    /** Thinking effort. */
    effort: Effort;
    /** Max tool-use round-trips before the model is forced to finalize. */
    maxToolCalls: number;
  };
  local: {
    /** OpenAI-compatible endpoint base URL (must include the /v1 path). */
    baseUrl: string;
    /** Local model name, e.g. qwen3-coder. */
    model: string;
  };
}

/** Transport used to reach the zb-knowledge MCP server. */
export type KnowledgeTransport = 'stdio' | 'http';

/**
 * Cross-repo knowledge layer (zb-knowledge MCP).
 *
 * When enabled, the reviewer seeds the prompt with affected-files impact and
 * exposes the zb-knowledge tools to the model for deeper cross-repo lookups.
 * A failure to reach the server degrades gracefully to a no-knowledge review.
 */
export interface KnowledgeConfig {
  enabled: boolean;
  /** stdio: a command line; http: a URL. Required when enabled. */
  endpoint?: string;
  transport: KnowledgeTransport;
  /**
   * Extra HTTP headers for the http transport (e.g. auth). Sourced from a
   * secret store, never committed — these typically carry an API key.
   */
  headers?: Record<string, string>;
  /** Per-tool-result char cap fed back to the model. */
  resultBudget: number;
  /** Max changed files the seed runs get_affected_files for. */
  seedFileLimit: number;
}

/** Resolved configuration for one `pr-review review` invocation. */
export interface ReviewConfig {
  mode: Mode;
  /** Git ref to diff against. */
  base: string;
  /** PR number when reviewing a GitHub PR; undefined for a local branch review. */
  prNumber?: number;
  /** The model layer. */
  model: ModelConfig;
  /** The cross-repo knowledge layer. */
  knowledge: KnowledgeConfig;
}

// Defaults — each overridable by an env var (see the resolvers below).
const DEFAULT_BASE = 'main';
const DEFAULT_ANTHROPIC_MODEL = 'claude-opus-4-7';
const DEFAULT_EFFORT: Effort = 'high';
const DEFAULT_MAX_TOOL_CALLS = 15;
const DEFAULT_LOCAL_BASE_URL = 'http://localhost:11434/v1'; // Ollama default
const DEFAULT_LOCAL_MODEL = 'qwen3-coder';
const DEFAULT_KNOWLEDGE_RESULT_BUDGET = 8_000;
const DEFAULT_KNOWLEDGE_SEED_FILES = 30;

/** Parse a positive-integer env var, falling back when unset or invalid. */
function toPositiveInt(value: string | undefined, fallback: number): number {
  if (value === undefined || value === '') return fallback;
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

/** Validate a knowledge-transport string. */
function parseTransport(value: string | undefined): KnowledgeTransport | undefined {
  if (value === undefined || value === '') return undefined;
  if (value === 'stdio' || value === 'http') return value;
  throw new Error(`Invalid knowledge transport '${value}' — expected 'stdio' or 'http'.`);
}

/** Parse a JSON object of HTTP headers, failing fast on malformed input. */
function parseHeaders(value: string | undefined): Record<string, string> | undefined {
  if (value === undefined || value === '') return undefined;
  const invalid = 'Invalid PR_REVIEW_KNOWLEDGE_HEADERS — expected a JSON object of string header values.';

  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error(invalid);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(invalid);
  }

  const headers: Record<string, string> = {};
  for (const [name, val] of Object.entries(parsed)) {
    if (typeof val !== 'string') throw new Error(invalid);
    headers[name] = val;
  }
  return Object.keys(headers).length > 0 ? headers : undefined;
}

/** Validate a provider string, failing fast on anything unexpected. */
function parseProvider(value: string | undefined): ProviderKind | undefined {
  if (value === undefined || value === '') return undefined;
  if (value === 'anthropic' || value === 'local') return value;
  throw new Error(`Invalid provider '${value}' — expected 'anthropic' or 'local'.`);
}

/** Validate an effort string, failing fast on anything unexpected. */
function parseEffort(value: string | undefined): Effort | undefined {
  if (value === undefined || value === '') return undefined;
  if (value === 'low' || value === 'medium' || value === 'high' || value === 'max') {
    return value;
  }
  throw new Error(`Invalid effort '${value}' — expected low | medium | high | max.`);
}

/**
 * Resolve the model-layer configuration from an optional provider override,
 * environment variables, and defaults — in that precedence order.
 *
 * Environment variables:
 *   PR_REVIEW_PROVIDER          anthropic | local
 *   PR_REVIEW_ANTHROPIC_MODEL   Claude model ID
 *   PR_REVIEW_EFFORT            low | medium | high | max
 *   PR_REVIEW_LOCAL_BASE_URL    OpenAI-compatible endpoint base URL
 *   PR_REVIEW_LOCAL_MODEL       local model name
 *   PR_REVIEW_MAX_TOOL_CALLS    cap on the Anthropic tool-use loop
 */
export function resolveModelConfig(provider?: ProviderKind): ModelConfig {
  return {
    provider: provider ?? parseProvider(process.env.PR_REVIEW_PROVIDER) ?? 'anthropic',
    anthropic: {
      model: process.env.PR_REVIEW_ANTHROPIC_MODEL ?? DEFAULT_ANTHROPIC_MODEL,
      effort: parseEffort(process.env.PR_REVIEW_EFFORT) ?? DEFAULT_EFFORT,
      maxToolCalls: toPositiveInt(process.env.PR_REVIEW_MAX_TOOL_CALLS, DEFAULT_MAX_TOOL_CALLS),
    },
    local: {
      baseUrl: process.env.PR_REVIEW_LOCAL_BASE_URL ?? DEFAULT_LOCAL_BASE_URL,
      model: process.env.PR_REVIEW_LOCAL_MODEL ?? DEFAULT_LOCAL_MODEL,
    },
  };
}

/**
 * Resolve the cross-repo knowledge configuration from environment variables.
 *
 * Environment variables:
 *   PR_REVIEW_KNOWLEDGE               on | off (default: on when an endpoint is set)
 *   PR_REVIEW_KNOWLEDGE_ENDPOINT      stdio command line, or http URL
 *   PR_REVIEW_KNOWLEDGE_TRANSPORT     stdio | http (default: inferred from endpoint)
 *   PR_REVIEW_KNOWLEDGE_HEADERS       JSON object of http headers (auth) — keep secret
 *   PR_REVIEW_KNOWLEDGE_RESULT_BUDGET per-tool-result char cap
 *   PR_REVIEW_KNOWLEDGE_SEED_FILES    max changed files the seed queries
 */
export function resolveKnowledgeConfig(): KnowledgeConfig {
  const endpoint = process.env.PR_REVIEW_KNOWLEDGE_ENDPOINT || undefined;
  const toggle = process.env.PR_REVIEW_KNOWLEDGE;
  const enabled = toggle ? toggle === 'on' : Boolean(endpoint);
  const transport =
    parseTransport(process.env.PR_REVIEW_KNOWLEDGE_TRANSPORT) ??
    (endpoint?.startsWith('http') ? 'http' : 'stdio');
  return {
    enabled,
    endpoint,
    transport,
    headers: parseHeaders(process.env.PR_REVIEW_KNOWLEDGE_HEADERS),
    resultBudget: toPositiveInt(
      process.env.PR_REVIEW_KNOWLEDGE_RESULT_BUDGET,
      DEFAULT_KNOWLEDGE_RESULT_BUDGET,
    ),
    seedFileLimit: toPositiveInt(
      process.env.PR_REVIEW_KNOWLEDGE_SEED_FILES,
      DEFAULT_KNOWLEDGE_SEED_FILES,
    ),
  };
}

/** Flags parsed from the `review` subcommand. */
export interface ReviewFlags {
  base?: string;
  pr?: number;
  provider?: ProviderKind;
  /** Force posting the review to the PR even in local mode. */
  post?: boolean;
}

/**
 * Resolve the full review configuration. Mode is auto-detected (see mode.ts).
 */
export function resolveConfig(flags: ReviewFlags): ReviewConfig {
  return {
    mode: detectMode(),
    base: flags.base ?? process.env.PR_REVIEW_BASE ?? DEFAULT_BASE,
    prNumber: flags.pr,
    model: resolveModelConfig(flags.provider),
    knowledge: resolveKnowledgeConfig(),
  };
}
