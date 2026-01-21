/**
 * Types for BinaryApi - binary data retrieval
 *
 * TODO: Implement binary types when BinaryApi is fully implemented
 */

/**
 * Binary metadata
 * TODO: Define full binary structure based on DataProducer API
 */
export interface BinaryMetadata {
  /**
   * Binary resource ID
   */
  id: string;

  /**
   * Binary resource name
   */
  name: string;

  /**
   * Content type/MIME type
   */
  contentType?: string;

  /**
   * Size in bytes
   */
  size?: number;

  /**
   * Hash/checksum
   */
  hash?: string;

  /**
   * Created timestamp
   */
  createdAt?: string;

  /**
   * Additional metadata
   */
  metadata?: Record<string, any>;
}

/**
 * Binary download options
 * TODO: Refine based on actual BinaryApi requirements
 */
export interface BinaryDownloadOptions {
  /**
   * Range start (for partial downloads)
   */
  rangeStart?: number;

  /**
   * Range end (for partial downloads)
   */
  rangeEnd?: number;

  /**
   * Whether to include metadata
   */
  includeMetadata?: boolean;
}

/**
 * Binary data result
 * TODO: Define based on actual BinaryApi response
 */
export interface BinaryData {
  /**
   * Binary metadata
   */
  metadata: BinaryMetadata;

  /**
   * Binary content
   */
  data: ArrayBuffer;

  /**
   * Content type
   */
  contentType: string;
}
