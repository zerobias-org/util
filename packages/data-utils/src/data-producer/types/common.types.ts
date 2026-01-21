/**
 * Common types used across DataProducer APIs
 */

import { UUID } from '@zerobias-org/types-core-js';

/**
 * Configuration for DataProducer connection
 */
export interface DataProducerConfig {
  /**
   * Server URL for the DataProducer API
   * Can be a string URL or a URL object (e.g., from @zerobias-org/types-core-js)
   */
  server: string | any;

  /**
   * Target ID (node/resource ID)
   */
  targetId: UUID | string;

  /**
   * Scope ID (boundary/context ID)
   */
  scopeId: string;

  /**
   * Optional timeout in milliseconds
   */
  timeout?: number;

  /**
   * Optional additional headers
   */
  headers?: Record<string, string>;
}

/**
 * Connection result status
 */
export interface ConnectionResult {
  /**
   * Whether the connection was successful
   */
  success: boolean;

  /**
   * Error message if connection failed
   */
  error?: string;

  /**
   * Additional state information
   */
  state?: any;
}

/**
 * Query options for paginated results
 */
export interface QueryOptions {
  /**
   * Page number (0-indexed)
   */
  pageNumber?: number;

  /**
   * Number of items per page
   */
  pageSize?: number;

  /**
   * Sort field
   */
  sortBy?: string | string[];

  /**
   * Sort direction
   */
  sortDirection?: 'asc' | 'desc' | SortDirection | SortDirection[];

  /**
   * Filter expression (implementation-specific)
   */
  filter?: string;
}

/**
 * List options for non-paginated queries
 */
export interface ListOptions {
  /**
   * Maximum number of items to return
   */
  limit?: number;

  /**
   * Offset for pagination
   */
  offset?: number;

  /**
   * Filter expression
   */
  filter?: string;
}

/**
 * Sort direction enum (compatible with DataProducer API)
 */
export enum SortDirection {
  Ascending = 'asc',
  Descending = 'desc'
}

/**
 * Error types for DataProducer operations
 */
export enum DataProducerErrorType {
  ConnectionError = 'CONNECTION_ERROR',
  AuthenticationError = 'AUTHENTICATION_ERROR',
  ValidationError = 'VALIDATION_ERROR',
  NotFoundError = 'NOT_FOUND_ERROR',
  TimeoutError = 'TIMEOUT_ERROR',
  UnknownError = 'UNKNOWN_ERROR'
}

/**
 * DataProducer error class
 */
export class DataProducerError extends Error {
  public readonly type: DataProducerErrorType;
  public readonly details?: any;

  constructor(message: string, type: DataProducerErrorType = DataProducerErrorType.UnknownError, details?: any) {
    super(message);
    this.name = 'DataProducerError';
    this.type = type;
    this.details = details;
  }
}
