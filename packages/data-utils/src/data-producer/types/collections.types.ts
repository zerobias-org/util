/**
 * Types for CollectionsApi - tabular collection data
 */

import { PagedResults } from '@zerobias-org/types-core-js';
import { SortDirection } from './common.types';

/**
 * Collection metadata
 */
export interface Collection {
  /**
   * Unique identifier for the collection
   */
  id: string;

  /**
   * Display name of the collection
   */
  name: string;

  /**
   * Collection description
   */
  description?: string;

  /**
   * Schema ID for this collection
   */
  schemaId?: string;

  /**
   * Number of elements in the collection
   */
  elementCount?: number;

  /**
   * Collection type
   */
  type?: string;

  /**
   * Whether the collection supports pagination
   */
  pageable?: boolean;

  /**
   * Whether the collection supports search/filtering
   */
  searchable?: boolean;

  /**
   * Whether the collection supports sorting
   */
  sortable?: boolean;

  /**
   * Available sort fields
   */
  sortableFields?: string[];

  /**
   * Additional metadata
   */
  metadata?: Record<string, any>;

  /**
   * Allow any additional properties from the DataProducer API
   * This preserves all original properties from the API response
   */
  [key: string]: any;
}

/**
 * Collection data with paged results
 */
export interface CollectionData<T = any> {
  /**
   * Collection metadata
   */
  collection: Collection;

  /**
   * Paged results
   */
  results: PagedResults<T>;

  /**
   * Schema definition for the elements
   */
  schema?: any;
}

/**
 * Collection element (generic row data)
 */
export interface CollectionElement {
  /**
   * Element ID
   */
  id?: string;

  /**
   * Element data
   */
  data: Record<string, any>;

  /**
   * Row metadata
   */
  metadata?: Record<string, any>;
}

/**
 * Collection query parameters
 */
export interface CollectionQueryParams {
  /**
   * Collection ID or name
   */
  collectionId: string;

  /**
   * Page number (0-indexed)
   */
  pageNumber?: number;

  /**
   * Page size
   */
  pageSize?: number;

  /**
   * Sort fields
   */
  sortBy?: string[];

  /**
   * Sort directions (must match sortBy length)
   */
  sortDirection?: SortDirection[];

  /**
   * Filter expression
   */
  filter?: string;

  /**
   * Additional query options
   */
  options?: Record<string, any>;
}

/**
 * Collection statistics
 */
export interface CollectionStats {
  /**
   * Total number of elements
   */
  totalElements: number;

  /**
   * Number of pages
   */
  totalPages: number;

  /**
   * Current page
   */
  currentPage: number;

  /**
   * Page size
   */
  pageSize: number;

  /**
   * Whether there are more pages
   */
  hasNext: boolean;

  /**
   * Whether there is a previous page
   */
  hasPrevious: boolean;
}
