/**
 * Types for SchemasApi - schema definitions
 */

/**
 * Schema definition
 * This extends or wraps the DataProducer Schema type
 */
export interface Schema {
  /**
   * Unique identifier for the schema
   */
  id: string;

  /**
   * Schema name
   */
  name: string;

  /**
   * Schema description
   */
  description?: string;

  /**
   * Schema version
   */
  version?: string;

  /**
   * Schema type (e.g., 'object', 'collection')
   */
  type?: string;

  /**
   * Field definitions
   */
  fields?: SchemaField[];

  /**
   * Required field names
   */
  required?: string[];

  /**
   * Additional properties allowed
   */
  additionalProperties?: boolean;

  /**
   * Schema metadata
   */
  metadata?: Record<string, any>;

  /**
   * JSON Schema definition (if available)
   */
  jsonSchema?: any;

  /**
   * OpenAPI schema definition (if available)
   */
  openApiSchema?: any;

  /**
   * Allow any additional properties from the DataProducer API
   * This preserves all original properties from the API response
   */
  [key: string]: any;
}

/**
 * Schema field definition
 */
export interface SchemaField {
  /**
   * Field name
   */
  name: string;

  /**
   * Field type (string, number, boolean, object, array, etc.)
   */
  type: string;

  /**
   * Field description
   */
  description?: string;

  /**
   * Whether the field is required
   */
  required?: boolean;

  /**
   * Whether the field is nullable
   */
  nullable?: boolean;

  /**
   * Default value
   */
  defaultValue?: any;

  /**
   * Field format (e.g., 'date-time', 'email', 'uuid')
   */
  format?: string;

  /**
   * Minimum value (for numbers)
   */
  minimum?: number;

  /**
   * Maximum value (for numbers)
   */
  maximum?: number;

  /**
   * Minimum length (for strings/arrays)
   */
  minLength?: number;

  /**
   * Maximum length (for strings/arrays)
   */
  maxLength?: number;

  /**
   * Pattern for validation (regex)
   */
  pattern?: string;

  /**
   * Enum values (if applicable)
   */
  enum?: any[];

  /**
   * Nested schema for objects/arrays
   */
  items?: SchemaField;

  /**
   * Nested schema for objects
   */
  properties?: Record<string, SchemaField>;

  /**
   * Field metadata
   */
  metadata?: Record<string, any>;

  /**
   * Display hints
   */
  displayHints?: FieldDisplayHints;
}

/**
 * Display hints for UI rendering
 */
export interface FieldDisplayHints {
  /**
   * Display label
   */
  label?: string;

  /**
   * Placeholder text
   */
  placeholder?: string;

  /**
   * Whether to display as multiline
   */
  multiline?: boolean;

  /**
   * Whether to display as password
   */
  password?: boolean;

  /**
   * Display order
   */
  order?: number;

  /**
   * Group name for grouping fields
   */
  group?: string;

  /**
   * Whether the field is hidden
   */
  hidden?: boolean;

  /**
   * Whether the field is read-only
   */
  readOnly?: boolean;
}

/**
 * Schema registry entry
 */
export interface SchemaRegistryEntry {
  /**
   * Schema ID
   */
  id: string;

  /**
   * Schema name
   */
  name: string;

  /**
   * Schema version
   */
  version: string;

  /**
   * When the schema was created
   */
  createdAt?: string;

  /**
   * When the schema was last updated
   */
  updatedAt?: string;

  /**
   * Schema description
   */
  description?: string;
}
