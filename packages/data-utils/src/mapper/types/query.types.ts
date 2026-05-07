/**
 * Types for query-driven data mapping.
 *
 * A "query source" is an ad-hoc SQL statement run against a data
 * producer's `query` function (see `DataMapper.applyAllMappingsFromQuery`).
 * Unlike a collection source, the producer doesn't store a schema id for
 * the result — callers infer the schema from the rows and persist it
 * inline on the mapping.
 */

/** Reference to a producer-side query function plus the SQL to run. */
export interface QuerySourceConfig {
  /** Object id of the producer's `query` function (e.g. `/db:neondb/function:query`). */
  objectId: string;
  /** SQL statement to send as the function's `sql` body parameter. */
  sql: string;
}

/**
 * Caller-supplied invoker that runs a producer function and returns the
 * raw response. Lets `DataMapper` stay framework-agnostic — Angular UI
 * passes `DataExplorerService.invokeFunctionRaw`; the server pipeline
 * runner passes its own producer client wrapper.
 */
export type InvokeFunction = (
  objectId: string,
  body: Record<string, any>,
) => Promise<any>;

/** A single column of an inferred schema. */
export interface SchemaProperty {
  /** Column name as it appears in the row object. */
  name: string;
  /** Inferred data type — `string`, `number`, `boolean`, `date`, `array`, `object`. */
  dataType: string;
  /** Convenience copy of `dataType` for downstream adapters that look at `.type`. */
  type?: string;
  /** Same name under the `key` field — some adapters reach for that instead of `.name`. */
  key?: string;
  required?: boolean;
  multi?: boolean;
  /** First non-null value seen for this column; useful for samples in UI. */
  sampleValue?: any;
}

/**
 * Schema-shaped object inferred from query result rows. Mirrors the
 * platform's existing `Schema` shape closely enough that the mapping
 * rule editor can consume it without any adapter.
 */
export interface InferredSchema {
  /** Optional id — typically the source query's object id, or null for ad-hoc. */
  id: string | null;
  /** Display name (e.g. the query function's name). */
  name: string;
  /** Reserved for downstream type registry; left empty for inferred schemas. */
  dataTypes: any[];
  properties: SchemaProperty[];
}

/** Result of comparing a previously persisted schema to a freshly inferred one. */
export interface SchemaDiff {
  /** Column names present in `next` but not `prev`. */
  added: string[];
  /** Column names present in `prev` but not `next`. */
  removed: string[];
  /** Columns whose `dataType` changed between the two schemas. */
  changed: Array<{ name: string; prevType: string; nextType: string }>;
  /** Columns whose name + dataType matched exactly. */
  unchanged: string[];
}
