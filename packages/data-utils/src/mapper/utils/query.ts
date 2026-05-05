/**
 * Pure helpers for query-driven data mapping. Used by
 * `DataMapper.applyAllMappingsFromQuery` and re-exported from the package
 * root so callers (Angular UI, server pipeline runner) can invoke them
 * directly when they need the same behaviour outside the engine.
 */

import {
  InferredSchema,
  SchemaDiff,
  SchemaProperty,
} from '../types/query.types.js';

/**
 * Normalise the result of a producer function invocation to a plain row
 * array. Producers return either:
 *   - a bare array of row objects, or
 *   - an envelope wrapping the array under one of `rows | items | results | data`.
 *
 * Returns `[]` for null/undefined and for shapes we don't recognise (the
 * caller is responsible for surfacing those as "no tabular rows").
 */
export function extractRows(result: any): any[] {
  if (!result) return [];
  if (Array.isArray(result)) return result;
  if (typeof result !== 'object') return [];
  return result.rows || result.items || result.results || result.data || [];
}

/**
 * Walk every row's keys in declared order, picking each column's data
 * type from the first non-null sample value. Preserves first-seen
 * ordering across rows so `properties[]` matches what the user saw in
 * the result preview.
 *
 * Returns null when there's nothing to infer from (empty rows or no
 * object-shaped rows).
 */
export function inferSchemaFromRows(
  rows: any[],
  opts: { id?: string | null; name?: string } = {},
): InferredSchema | null {
  if (!rows || rows.length === 0) return null;

  const seen = new Set<string>();
  const keys: string[] = [];
  for (const row of rows) {
    if (row && typeof row === 'object') {
      for (const k of Object.keys(row)) {
        if (!seen.has(k)) {
          seen.add(k);
          keys.push(k);
        }
      }
    }
  }
  if (keys.length === 0) return null;

  const properties: SchemaProperty[] = keys.map((key) => {
    const sampleValue = firstNonNullValue(rows, key);
    const dataType = detectDataType(sampleValue);
    return {
      name: key,
      key,
      dataType,
      type: dataType,
      sampleValue,
      required: false,
      multi: false,
    };
  });

  return {
    id: opts.id ?? null,
    name: opts.name ?? 'Query Result',
    dataTypes: [],
    properties,
  };
}

/**
 * Compare a previously persisted schema against a freshly inferred one
 * and report what changed. Used by the UI's edit-time drift check; the
 * server pipeline runner can use it for telemetry.
 */
export function diffSchemas(
  prev: InferredSchema | null | undefined,
  next: InferredSchema | null | undefined,
): SchemaDiff {
  const prevProps = prev?.properties ?? [];
  const nextProps = next?.properties ?? [];
  const prevByName = new Map(prevProps.map((p) => [p.name, p]));
  const nextByName = new Map(nextProps.map((p) => [p.name, p]));

  const added: string[] = [];
  const removed: string[] = [];
  const changed: Array<{ name: string; prevType: string; nextType: string }> = [];
  const unchanged: string[] = [];

  for (const [name, np] of nextByName) {
    const pp = prevByName.get(name);
    if (!pp) {
      added.push(name);
      continue;
    }
    if ((pp.dataType || '') !== (np.dataType || '')) {
      changed.push({ name, prevType: pp.dataType, nextType: np.dataType });
    } else {
      unchanged.push(name);
    }
  }
  for (const name of prevByName.keys()) {
    if (!nextByName.has(name)) removed.push(name);
  }

  return { added, removed, changed, unchanged };
}

// ---- internals ----

function firstNonNullValue(rows: any[], key: string): any {
  for (const row of rows) {
    if (row && row[key] !== null && row[key] !== undefined) return row[key];
  }
  return null;
}

const ISO_DATE_RE =
  /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:?\d{2})?)?$/;

function detectDataType(v: any): string {
  if (v === null || v === undefined) return 'string';
  if (typeof v === 'boolean') return 'boolean';
  if (typeof v === 'number') return 'number';
  if (v instanceof Date) return 'date';
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'object') return 'object';
  if (typeof v === 'string') {
    // Cheap ISO-date sniff — DataMapper engine accepts 'date' for these.
    if (ISO_DATE_RE.test(v)) return 'date';
    return 'string';
  }
  return 'string';
}
