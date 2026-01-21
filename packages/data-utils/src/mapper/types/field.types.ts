/**
 * Represents a source field that can be mapped from
 */
export interface SourceField {
  /** Unique identifier for the field */
  key: string;
  /** Display name for the field (optional - will fall back to key if not provided) */
  name?: string;
  /** Data type of the field (string, number, object, array, etc.) */
  type: string;
  /** Sample value for preview and testing */
  sampleValue?: any;
  /** Full dot-notation path for nested fields (e.g., "user_metadata.department") */
  path?: string;
  /** Parent field key for nested fields */
  parent?: string;
  /** Whether this is a nested field */
  isNested?: boolean;
  /** Whether this is an array item field (e.g., "addresses[].street") */
  isArrayItem?: boolean;
  /** Nesting level (0 = root, 1 = first level, etc.) */
  level?: number;
}

/**
 * Represents a destination field that can be mapped to
 */
export interface DestinationField {
  /** Unique identifier for the field */
  key: string;
  /** Display name for the field (optional - will fall back to key if not provided) */
  name?: string;
  /** Data type expected for the field */
  type: string;
  /** Whether this field is required */
  required: boolean;
  /** Full dot-notation path for nested fields */
  path?: string;
  /** Parent field key for nested fields */
  parent?: string;
  /** Whether this is a nested field */
  isNested?: boolean;
  /** Whether this is an array item field (e.g., "locations[].street") */
  isArrayItem?: boolean;
  /** Nesting level */
  level?: number;
}
