/**
 * Shared types for the pr-review pipeline.
 *
 * Three stages, each consuming the previous stage's output:
 *   1. diff identifier   -> DiffSummary
 *   2. context gatherer  -> ReviewContext
 *   3. review agent      -> ReviewResult
 */

/** Change status of a single file, from `git diff --name-status`. */
export type FileStatus = 'added' | 'modified' | 'deleted' | 'renamed';

/** A single changed file in the diff under review. */
export interface ChangedFile {
  path: string;
  status: FileStatus;
  /**
   * True when the file is an API/schema contract (OpenAPI spec, JSON schema).
   * Contract changes carry wide blast radius and are flagged to the model.
   */
  isContract: boolean;
}

/** Output of stage 1 — the diff identifier. */
export interface DiffSummary {
  /** Git ref the diff is computed against (PR base / merge base). */
  base: string;
  /** Git ref under review (PR head / local HEAD). */
  head: string;
  /** Every file touched between base and head. */
  files: ChangedFile[];
  /** Unified diff text (`git diff base...HEAD`). */
  patch: string;
}

/** A changed file paired with its full post-change content. */
export interface FileContext {
  path: string;
  status: FileStatus;
  isContract: boolean;
  /** Full content of the file at HEAD; undefined for deleted files. */
  content?: string;
}

/** Output of stage 2 — the context gatherer. */
export interface ReviewContext {
  diff: DiffSummary;
  /** Changed files with their content. */
  files: FileContext[];
  /** Repo documentation (CLAUDE.md / README.md) used to ground the review. */
  repoDocs: string;
}

/** Severity of a review finding. */
export type Severity = 'critical' | 'high' | 'medium' | 'low' | 'nit';

/** A single issue raised by the review agent. */
export interface ReviewFinding {
  /** Repo-relative file path the finding refers to. */
  file: string;
  /** Line number in the new file, when the model can identify one. */
  line?: number;
  severity: Severity;
  /** The model's confidence, 0..1. */
  confidence: number;
  /** Clear description of the issue, ideally with a suggested fix. */
  message: string;
}

/** Output of stage 3 — the review agent. */
export interface ReviewResult {
  /** One-paragraph overall assessment. */
  summary: string;
  findings: ReviewFinding[];
  /** Identifier of the model that produced the review. */
  model: string;
}
