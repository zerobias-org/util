import { SourceField, DestinationField } from './field.types';
import { TransformConfig } from './transform.types';

/**
 * Error handling strategy for mapping failures
 */
export type ErrorHandlingStrategy = 'fail' | 'skip' | 'default';

/**
 * Represents a complete mapping rule from source(s) to destination
 */
export interface MappingRule {
  /** Unique identifier for this mapping rule */
  id: string;
  /** Source field(s) - can be single or multiple for combine operations */
  source: SourceField | SourceField[];
  /** Destination field to map to */
  destination: DestinationField;
  /** Transformation configuration */
  transform: TransformConfig;
  /** Optional description of what this mapping does */
  description?: string;
  /** Whether this mapping is enabled (default: true) */
  enabled?: boolean;
  /** Tags for categorizing mappings */
  tags?: string[];
  /** Error handling strategy */
  errorStrategy?: ErrorHandlingStrategy;
  /** Default value to use when error strategy is 'default' */
  errorDefault?: any;
}

/**
 * Result of applying a mapping rule to data
 */
export interface MappingResult {
  /** The destination field key */
  destinationKey: string;
  /** The transformed value */
  value: any;
  /** Whether the transformation was successful */
  success: boolean;
  /** Error message if transformation failed */
  error?: string;
}
