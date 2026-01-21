/**
 * Types for DocumentsApi - document retrieval and management
 *
 * TODO: Implement document types when DocumentsApi is fully implemented
 */

import { ListOptions } from './common.types';

/**
 * Document metadata
 * TODO: Define full document structure based on DataProducer API
 */
export interface Document {
  /**
   * Document ID
   */
  id: string;

  /**
   * Document name
   */
  name: string;

  /**
   * Document type/format
   */
  type?: string;

  /**
   * Document size in bytes
   */
  size?: number;

  /**
   * Document content (if loaded)
   */
  content?: any;

  /**
   * Document metadata
   */
  metadata?: Record<string, any>;

  /**
   * Created timestamp
   */
  createdAt?: string;

  /**
   * Updated timestamp
   */
  updatedAt?: string;
}

/**
 * Document list options
 * TODO: Refine based on actual DocumentsApi requirements
 */
export interface DocumentListOptions extends ListOptions {
  /**
   * Filter by document type
   */
  type?: string;

  /**
   * Include document content in results
   */
  includeContent?: boolean;
}
