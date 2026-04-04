/**
 * Stack-internal type definitions.
 * Config-level types (StackManifest, etc.) live in ../config.ts and are re-exported here.
 */

export type {
  StackManifest,
  StackIdentity,
  DependencySpec,
  SubstackConfig,
  StateFieldSchema,
  CollectionStateConfig,
  LifecycleConfig,
  HealthCheckConfig,
  LogSourceConfig,
  SecretSchemaConfig,
  ImportAlias,
} from '../config.js';

// ── Layer 2: Per-Var Manifest Entry ─────────────────────────────────

export type Resolution =
  | 'allocated'
  | 'derived'
  | 'override'
  | 'inherited'
  | 'generated'
  | 'imported'
  | 'default';

export interface StackManifestEntry {
  resolution: Resolution;
  value?: string;
  source?: string;
  formula?: string;
  inputs?: Record<string, string>;
  set_by?: string;
  set_at?: string;
  default_formula?: string;
  from?: string;
  original_name?: string;
  generator?: string;
  mask?: boolean;
  type?: string;
  description?: string;
}

// ── Import Spec (parsed) ────────────────────────────────────────────

export interface ImportSpec {
  varName: string;
  alias?: string;
  fromStack: string;
}

// ── Env Explain ─────────────────────────────────────────────────────

export interface ExplainResult {
  name: string;
  type?: string;
  description?: string;
  resolution: Resolution;
  formula?: string;
  inputs?: Record<string, string>;
  current?: string;
  source?: string;
  from?: string;
  original_name?: string;
  overridable: boolean;
}

// ── Stack Status ────────────────────────────────────────────────────

export interface StackStatus {
  name: string;
  version: string;
  mode: 'dev' | 'packaged';
  status: string;
  ports: Record<string, number>;
  deps: string[];
}
