/**
 * Data manipulation utilities for collector bots
 * Provides functions for chunking, parsing, and transforming data
 */

import { parse } from 'csv-parse/sync';
import * as fs from 'node:fs';

export interface ChunkResult<T> {
  /** Chunks of items that fit within the size limit */
  chunks: T[][];
  /** Individual items that exceed the size limit */
  largeItems: T[];
}

export interface CsvParseOptions {
  /** Use first row as column headers (default: true) */
  columns?: boolean;
  /** Skip empty lines (default: true) */
  skipEmptyLines?: boolean;
  /** Custom delimiter (default: ',') */
  delimiter?: string;
  /** Character used to quote fields (default: '"') */
  quote?: string;
  /** Skip the first N lines */
  fromLine?: number;
}

/**
 * Splits an array into chunks based on serialized byte size
 * Useful for batch operations with payload size limits
 *
 * @param items - Array of items to chunk
 * @param maxSizeBytes - Maximum chunk size in bytes (default: 350000)
 * @returns Object containing chunks and any items exceeding the limit
 *
 * @example
 * ```typescript
 * const { chunks, largeItems } = splitArrayBySize(records, 350000);
 * for (const chunk of chunks) {
 *   await batch.addItems(chunk);
 * }
 * ```
 */
export function splitArrayBySize<T>(
  items: T[],
  maxSizeBytes: number = 350_000
): ChunkResult<T> {
  const itemsWithSize = items.map((item) => ({
    item,
    size: Buffer.byteLength(JSON.stringify(item)),
  }));

  const chunks: T[][] = [];
  const largeItems: T[] = [];
  let currentChunk: T[] = [];
  let currentSize = 0;

  for (const { item, size } of itemsWithSize) {
    // Item alone exceeds limit - add to largeItems
    if (size >= maxSizeBytes) {
      largeItems.push(item);
      continue;
    }

    // Adding item would exceed limit - start new chunk
    if (currentSize + size >= maxSizeBytes && currentChunk.length > 0) {
      chunks.push(currentChunk);
      currentChunk = [];
      currentSize = 0;
    }

    currentChunk.push(item);
    currentSize += size;
  }

  // Don't forget the last chunk
  if (currentChunk.length > 0) {
    chunks.push(currentChunk);
  }

  return { chunks, largeItems };
}

/**
 * Splits an array into fixed-size chunks by item count
 *
 * @param items - Array of items to chunk
 * @param chunkSize - Number of items per chunk (default: 500)
 * @returns Array of chunks
 *
 * @example
 * ```typescript
 * const chunks = splitArrayByCount(records, 100);
 * ```
 */
export function splitArrayByCount<T>(items: T[], chunkSize: number = 500): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += chunkSize) {
    chunks.push(items.slice(i, i + chunkSize));
  }
  return chunks;
}

/**
 * Reads and parses a CSV file
 *
 * @param filePath - Path to the CSV file
 * @param options - CSV parsing options
 * @returns Array of parsed records
 *
 * @example
 * ```typescript
 * const records = readCsv<MyRecord>('/tmp/data.csv');
 * ```
 */
export function readCsv<T = Record<string, string>>(
  filePath: string,
  options: CsvParseOptions = {}
): T[] {
  const { columns = true, skipEmptyLines = true, delimiter = ',', quote = '"', fromLine } = options;

  const fileContent = fs.readFileSync(filePath, 'utf8');

  return parse(fileContent, {
    columns,
    skip_empty_lines: skipEmptyLines,
    delimiter,
    quote,
    from_line: fromLine,
  }) as T[];
}

/**
 * Reads and parses CSV content from a string
 *
 * @param content - CSV content as string
 * @param options - CSV parsing options
 * @returns Array of parsed records
 */
export function parseCsv<T = Record<string, string>>(
  content: string,
  options: CsvParseOptions = {}
): T[] {
  const { columns = true, skipEmptyLines = true, delimiter = ',', quote = '"', fromLine } = options;

  return parse(content, {
    columns,
    skip_empty_lines: skipEmptyLines,
    delimiter,
    quote,
    from_line: fromLine,
  }) as T[];
}

/**
 * Converts a value to an array (wraps non-array values)
 * Useful for handling API responses that may return single items or arrays
 *
 * @param value - Value to convert
 * @returns Array containing the value(s)
 *
 * @example
 * ```typescript
 * const items = toArray(response.items); // Always returns array
 * ```
 */
export function toArray<T>(value: T | T[] | undefined | null): T[] {
  if (value === undefined || value === null) {
    return [];
  }
  return Array.isArray(value) ? value : [value];
}

/**
 * Converts a string to camelCase
 * Handles kebab-case, snake_case, and space-separated strings
 *
 * @param str - String to convert
 * @returns camelCase string
 *
 * @example
 * ```typescript
 * toCamelCase('my-property-name'); // 'myPropertyName'
 * toCamelCase('my_property_name'); // 'myPropertyName'
 * ```
 */
export function toCamelCase(str: string): string {
  return str
    .replaceAll(/[\s_-](.)/g, (_, char) => char.toUpperCase())
    .replace(/^(.)/, (char) => char.toLowerCase());
}

/**
 * Creates a lookup map from an array of objects
 *
 * @param items - Array of objects
 * @param keyField - Field to use as the map key
 * @returns Map with keyField values as keys
 *
 * @example
 * ```typescript
 * const techniqueById = createLookupMap(techniques, 'id');
 * const technique = techniqueById.get('T1001');
 * ```
 */
export function createLookupMap<T extends Record<string, unknown>>(
  items: T[],
  keyField: keyof T
): Map<string, T> {
  const map = new Map<string, T>();
  for (const item of items) {
    const key = String(item[keyField]);
    map.set(key, item);
  }
  return map;
}

/**
 * Creates a grouped map from an array of objects
 *
 * @param items - Array of objects
 * @param keyField - Field to group by
 * @returns Map with arrays of items grouped by keyField
 *
 * @example
 * ```typescript
 * const techniquesByTactic = createGroupedMap(techniques, 'tactic');
 * const reconTechniques = techniquesByTactic.get('reconnaissance') ?? [];
 * ```
 */
export function createGroupedMap<T extends Record<string, unknown>>(
  items: T[],
  keyField: keyof T
): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const item of items) {
    const key = String(item[keyField]);
    const existing = map.get(key) ?? [];
    existing.push(item);
    map.set(key, existing);
  }
  return map;
}
