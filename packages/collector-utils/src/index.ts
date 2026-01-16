/**
 * @zerobias-org/collector-utils
 *
 * Common utilities for collector bots providing:
 * - HTTP fetching (download files, fetch JSON/YAML)
 * - Data manipulation (chunking, CSV parsing, transformations)
 * - Batch processing helpers (error handling, tracking)
 */

// HTTP utilities
export {
  downloadFile,
  downloadFilesParallel,
  fetchJson,
  fetchYaml,
  fetchText,
  type FetchOptions,
} from './http.js';

// Data utilities
export {
  splitArrayBySize,
  splitArrayByCount,
  readCsv,
  parseCsv,
  toArray,
  toCamelCase,
  createLookupMap,
  createGroupedMap,
  type ChunkResult,
  type CsvParseOptions,
} from './data.js';

// Batch utilities
export {
  Batch,
  BatchManager,
  BatchLogLevelEnum,
  BatchImportItem,
  UUID,
  UnexpectedError,
  PlatformApiClient,
  Tag,
  withTempDir,
  type BatchLogLevelEnumDef,
  type NewBatch,
  type NewBatchLog,
  type LoggerEngine,
  type BatchItem,
  type BatchEntry,
} from './batch.js';
