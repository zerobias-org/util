/**
 * CollectionsApi - Tabular collection data access
 *
 * Provides methods for querying and retrieving tabular data from collections.
 * Collections represent sets of records/rows with a defined schema,
 * similar to database tables or spreadsheet data.
 */

import { SortDirection as ExternalSortDirection } from '@zerobias-org/module-interface-dataproducer-client-ts';
import { PagedResults } from '@zerobias-org/types-core-js';
import {
  Collection,
  CollectionData,
  CollectionQueryParams,
  CollectionElement
} from '../types/collections.types';
import { QueryOptions, SortDirection } from '../types/common.types';
import { validatePagedResult, validateDefined } from '../../validation';

/**
 * CollectionsApi implementation
 *
 * This API provides access to tabular collection data with support for:
 * - Pagination
 * - Sorting (single or multiple fields)
 * - Filtering/searching
 * - Schema-based validation
 */
export class CollectionsApi {
  private client: import('../DataProducerClient').DataProducerClient;

  /**
   * Create a new CollectionsApi instance
   *
   * @param client - DataProducerClient instance
   * @internal
   */
  constructor(client: import('../DataProducerClient').DataProducerClient) {
    this.client = client;
  }

  /**
   * Get list of available collections
   *
   * Retrieves metadata about all collections available in the DataProducer.
   * Does not retrieve the actual collection data, only the collection descriptors.
   *
   * @returns Array of collection metadata
   * @throws DataProducerError if the operation fails
   *
   * @example
   * ```typescript
   * const client = new DataProducerClient(config);
   * await client.connect();
   * const collections = await client.collections.getCollections();
   * console.log(`Found ${collections.length} collections`);
   * ```
   */
  public async getCollections(): Promise<Collection[]> {
    try {
      const dataProducer = this.client.getDataProducer();
      const collectionsApi = dataProducer.getCollectionsApi();

      // Check if getCollections method exists
      let collectionsData: any;
      if (typeof collectionsApi.getCollections === 'function') {
        collectionsData = await collectionsApi.getCollections();
      } else if (typeof collectionsApi.listCollections === 'function') {
        collectionsData = await collectionsApi.listCollections();
      } else {
        throw new Error('CollectionsApi.getCollections is not available');
      }

      // Validate the response
      validateDefined(collectionsData, 'CollectionsApi.getCollections', 'collectionsData');

      // Normalize if it's an array
      if (Array.isArray(collectionsData)) {
        return collectionsData.map((coll: any) => this._normalizeCollection(coll));
      }

      // Throw error instead of silently returning empty array
      throw new Error('Unexpected response format from API: collections data is not an array');
    } catch (error) {
      this.client.handleError(error, 'Failed to get collections');
    }
  }

  /**
   * Get collection elements (rows/records)
   *
   * Retrieves paginated data from a collection with optional sorting.
   * This is the primary method for reading collection data.
   *
   * @param collectionId - Collection ID or object ID representing the collection
   * @param options - Query options (pagination, sorting)
   * @returns Paged results containing collection elements
   * @throws DataProducerError if the operation fails
   *
   * @example
   * ```typescript
   * const client = new DataProducerClient(config);
   * await client.connect();
   * const result = await client.collections.getCollectionElements('collection-123', {
   *   pageNumber: 0,
   *   pageSize: 50,
   *   sortBy: 'name',
   *   sortDirection: 'asc'
   * });
   * console.log(`Retrieved ${result.items.length} elements`);
   * ```
   */
  public async getCollectionElements(
    collectionId: string,
    options?: QueryOptions
  ): Promise<PagedResults<any>> {
    try {
      const dataProducer = this.client.getDataProducer();
      const collectionsApi = dataProducer.getCollectionsApi();

      // Prepare parameters
      const pageNumber = options?.pageNumber ?? 0;
      const pageSize = options?.pageSize ?? 50;
      const sortBy = this._normalizeSortBy(options?.sortBy);
      const sortDir = this._normalizeSortDirection(options?.sortDirection);

      // Call the underlying API
      const result = await collectionsApi.getCollectionElements(
        collectionId,
        pageNumber,
        pageSize,
        sortBy,
        sortDir
      );

      // Validate the response
      validatePagedResult(result, 'getCollectionElements');

      return result as PagedResults<any>;
    } catch (error) {
      this.client.handleError(error, `Failed to get collection elements for ${collectionId}`);
    }
  }

  /**
   * Search/filter collection elements
   *
   * Retrieves filtered collection data based on a search query.
   * Supports the same pagination and sorting options as getCollectionElements,
   * plus filtering capabilities.
   *
   * @param collectionId - Collection ID or object ID representing the collection
   * @param filter - Filter expression (implementation-specific syntax)
   * @param options - Query options (pagination, sorting)
   * @returns Paged results containing filtered collection elements
   * @throws DataProducerError if the operation fails
   *
   * @example
   * ```typescript
   * const client = new DataProducerClient(config);
   * await client.connect();
   * const result = await client.collections.searchCollectionElements(
   *   'collection-123',
   *   'name LIKE "John%"',
   *   {
   *     pageNumber: 0,
   *     pageSize: 50,
   *     sortBy: 'name',
   *     sortDirection: 'asc'
   *   }
   * );
   * console.log(`Found ${result.totalElements} matching elements`);
   * ```
   */
  public async searchCollectionElements(
    collectionId: string,
    filter: string,
    options?: QueryOptions
  ): Promise<PagedResults<any>> {
    try {
      const dataProducer = this.client.getDataProducer();
      const collectionsApi = dataProducer.getCollectionsApi();

      // Prepare parameters
      const pageNumber = options?.pageNumber ?? 0;
      const pageSize = options?.pageSize ?? 50;
      const sortBy = this._normalizeSortBy(options?.sortBy);
      const sortDir = this._normalizeSortDirection(options?.sortDirection);

      // Call the underlying API
      const result = await collectionsApi.searchCollectionElements(
        collectionId,
        pageNumber,
        pageSize,
        filter,
        sortBy,
        sortDir
      );

      // Validate the response
      validatePagedResult(result, 'searchCollectionElements');

      return result as PagedResults<any>;
    } catch (error) {
      this.client.handleError(error, `Failed to search collection elements for ${collectionId}`);
    }
  }

  /**
   * Query collection with full options
   *
   * A convenience method that combines getCollectionElements and searchCollectionElements.
   * Automatically uses search if a filter is provided, otherwise uses standard get.
   *
   * @param params - Collection query parameters
   * @returns Paged results containing collection elements
   * @throws DataProducerError if the operation fails
   *
   * @example
   * ```typescript
   * const client = new DataProducerClient(config);
   * await client.connect();
   * const result = await client.collections.queryCollection({
   *   collectionId: 'collection-123',
   *   filter: 'age > 18',
   *   pageNumber: 0,
   *   pageSize: 100,
   *   sortBy: ['lastName', 'firstName'],
   *   sortDirection: ['asc', 'asc']
   * });
   * ```
   */
  public async queryCollection(params: CollectionQueryParams): Promise<PagedResults<any>> {
    const options: QueryOptions = {
      pageNumber: params.pageNumber,
      pageSize: params.pageSize,
      sortBy: params.sortBy,
      sortDirection: params.sortDirection,
      filter: params.filter
    };

    if (params.filter) {
      return this.searchCollectionElements(params.collectionId, params.filter, options);
    } else {
      return this.getCollectionElements(params.collectionId, options);
    }
  }

  /**
   * Normalize collection metadata
   *
   * @param collection - Raw collection data from DataProducer API
   * @returns Normalized Collection
   * @private
   */
  private _normalizeCollection(collection: any): Collection {
    // Preserve all original properties and overlay normalized ones
    return {
      ...collection, // Keep all original properties
      id: collection.id || collection.collectionId || '',
      name: collection.name || collection.displayName || '',
      description: collection.description || undefined,
      schemaId: collection.schemaId || collection.schema || undefined,
      elementCount: collection.elementCount || collection.count || undefined,
      type: collection.type || undefined,
      pageable: collection.pageable !== false,
      searchable: collection.searchable !== false,
      sortable: collection.sortable !== false,
      sortableFields: collection.sortableFields || undefined,
      metadata: collection.metadata || {}
    };
  }

  /**
   * Normalize sort by parameter
   *
   * Converts string or array to array format expected by API
   *
   * @param sortBy - Sort field(s)
   * @returns Array of sort fields or null
   * @private
   */
  private _normalizeSortBy(sortBy?: string | string[]): string[] | null {
    if (!sortBy) {
      return null;
    }

    if (typeof sortBy === 'string') {
      return [sortBy];
    }

    if (Array.isArray(sortBy)) {
      return sortBy;
    }

    return null;
  }

  /**
   * Normalize sort direction parameter
   *
   * Converts our SortDirection enum to the external API's SortDirection
   *
   * @param sortDirection - Sort direction(s)
   * @returns Array of ExternalSortDirection or null
   * @private
   */
  private _normalizeSortDirection(
    sortDirection?: 'asc' | 'desc' | SortDirection | SortDirection[] | any | any[]
  ): any[] | null {
    if (!sortDirection) {
      return null;
    }

    // If it's already an array, convert each element
    if (Array.isArray(sortDirection)) {
      return sortDirection.map((dir: any) => this._convertSortDirection(dir));
    }

    // Single value - convert and wrap in array
    return [this._convertSortDirection(sortDirection)];
  }

  /**
   * Convert a single sort direction value to ExternalSortDirection
   *
   * @param direction - Sort direction value
   * @returns ExternalSortDirection instance
   * @private
   */
  private _convertSortDirection(direction: any): any {
    // If it's already an ExternalSortDirection, return as-is
    if (direction && typeof direction === 'object' && direction.constructor.name === 'SortDirection') {
      return direction;
    }

    // Convert string to ExternalSortDirection
    const dirStr = String(direction).toLowerCase();
    if (dirStr === 'asc' || dirStr === 'ascending') {
      return ExternalSortDirection.from('asc');
    } else if (dirStr === 'desc' || dirStr === 'descending') {
      return ExternalSortDirection.from('desc');
    }

    // Default to ascending
    return ExternalSortDirection.from('asc');
  }
}
