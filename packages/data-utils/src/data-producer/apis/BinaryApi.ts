/**
 * BinaryApi - Binary data retrieval (PLACEHOLDER)
 *
 * TODO: Implement BinaryApi when the DataProducer Binary API is available.
 *
 * This API will provide methods for:
 * - Retrieving binary data by ID
 * - Listing binary resources
 * - Downloading binary content
 * - Managing binary metadata
 */

import { BinaryMetadata, BinaryDownloadOptions, BinaryData } from '../types/binary.types';

/**
 * BinaryApi implementation (PLACEHOLDER)
 *
 * This is a placeholder implementation that will be fully implemented
 * when the DataProducer Binary API becomes available.
 *
 * @placeholder
 */
export class BinaryApi {
  private client: import('../DataProducerClient').DataProducerClient;

  /**
   * Create a new BinaryApi instance
   *
   * @param client - DataProducerClient instance
   * @internal
   */
  constructor(client: import('../DataProducerClient').DataProducerClient) {
    this.client = client;
  }

  /**
   * Get binary data by ID (PLACEHOLDER)
   *
   * TODO: Implement when Binary API is available
   *
   * @param binaryId - Binary resource ID
   * @param options - Download options (range, etc.)
   * @returns Binary data as ArrayBuffer
   * @throws Error indicating this method is not yet implemented
   *
   * @placeholder
   */
  public async getBinary(binaryId: string, options?: any): Promise<ArrayBuffer> {
    throw new Error(
      'BinaryApi.getBinary is not yet implemented. ' +
      'This is a placeholder for future functionality.'
    );
  }

  /**
   * List binary resources (PLACEHOLDER)
   *
   * TODO: Implement when Binary API is available
   *
   * @returns Array of binary metadata
   * @throws Error indicating this method is not yet implemented
   *
   * @placeholder
   */
  public async listBinaries(): Promise<any[]> {
    throw new Error(
      'BinaryApi.listBinaries is not yet implemented. ' +
      'This is a placeholder for future functionality.'
    );
  }

  /**
   * Check if Binary API is available
   *
   * @returns False (not yet implemented)
   */
  public isAvailable(): boolean {
    return false;
  }
}
