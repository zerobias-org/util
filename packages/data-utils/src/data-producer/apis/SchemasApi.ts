/**
 * SchemasApi - Schema definition access
 *
 * Provides methods for retrieving schema definitions from a DataProducer.
 * Schemas define the structure, types, and validation rules for objects
 * and collections.
 */

import { Schema as ExternalSchema } from '@zerobias-org/module-interface-dataproducer';
import { Schema, SchemaField, SchemaRegistryEntry } from '../types/schemas.types';
import { validateDefined } from '../../validation';

/**
 * SchemasApi implementation
 *
 * This API provides access to schema definitions that describe
 * the structure of objects and collections in the DataProducer.
 */
export class SchemasApi {
  private client: import('../DataProducerClient').DataProducerClient;

  /**
   * Create a new SchemasApi instance
   *
   * @param client - DataProducerClient instance
   * @internal
   */
  constructor(client: import('../DataProducerClient').DataProducerClient) {
    this.client = client;
  }

  /**
   * Get list of available schemas
   *
   * Retrieves metadata about all schemas available in the DataProducer.
   * This returns a registry of schemas without their full definitions.
   *
   * @returns Array of schema registry entries
   * @throws DataProducerError if the operation fails
   *
   * @example
   * ```typescript
   * const client = new DataProducerClient(config);
   * await client.connect();
   * const schemas = await client.schemas.getSchemas();
   * console.log(`Found ${schemas.length} schemas`);
   * ```
   */
  public async getSchemas(): Promise<SchemaRegistryEntry[]> {
    try {
      const dataProducer = this.client.getDataProducer();
      const schemasApi = dataProducer.getSchemasApi();

      // Check if getSchemas or listSchemas method exists
      let schemasData: any;
      if (typeof schemasApi.getSchemas === 'function') {
        schemasData = await schemasApi.getSchemas();
      } else if (typeof schemasApi.listSchemas === 'function') {
        schemasData = await schemasApi.listSchemas();
      } else {
        throw new Error('SchemasApi.getSchemas is not available');
      }

      // Validate the response
      validateDefined(schemasData, 'SchemasApi.getSchemas', 'schemasData');

      // Normalize if it's an array
      if (Array.isArray(schemasData)) {
        return schemasData.map((schema: any) => this._normalizeSchemaRegistryEntry(schema));
      }

      // Throw error instead of silently returning empty array
      throw new Error('Unexpected response format from API: schemas data is not an array');
    } catch (error) {
      this.client.handleError(error, 'Failed to get schemas');
    }
  }

  /**
   * Get a schema by ID
   *
   * Retrieves the full schema definition for a specific schema ID.
   * This includes field definitions, validation rules, and metadata.
   *
   * @param schemaId - Schema ID to retrieve
   * @returns Full schema definition
   * @throws DataProducerError if the operation fails or schema not found
   *
   * @example
   * ```typescript
   * const client = new DataProducerClient(config);
   * await client.connect();
   * const schema = await client.schemas.getSchema('schema-123');
   * console.log('Schema:', schema.name);
   * console.log('Fields:', schema.fields);
   * ```
   */
  public async getSchema(schemaId: string): Promise<Schema> {
    try {
      const dataProducer = this.client.getDataProducer();
      const schemasApi = dataProducer.getSchemasApi();

      // Call the underlying API
      const schema = await schemasApi.getSchema(schemaId);

      // Validate the response
      validateDefined(schema, 'SchemasApi.getSchema', 'schema');

      return this._normalizeSchema(schema);
    } catch (error) {
      this.client.handleError(error, `Failed to get schema ${schemaId}`);
    }
  }

  /**
   * Get a schema by name
   *
   * Retrieves the full schema definition for a specific schema name.
   * This is a convenience method that searches for a schema by name.
   *
   * @param name - Schema name to search for
   * @returns Full schema definition
   * @throws DataProducerError if the operation fails or schema not found
   *
   * @example
   * ```typescript
   * const client = new DataProducerClient(config);
   * await client.connect();
   * const schema = await client.schemas.getSchemaByName('User');
   * console.log('Schema ID:', schema.id);
   * ```
   */
  public async getSchemaByName(name: string): Promise<Schema> {
    try {
      const dataProducer = this.client.getDataProducer();
      const schemasApi = dataProducer.getSchemasApi();

      // Check if getSchemaByName method exists
      if (typeof schemasApi.getSchemaByName === 'function') {
        const schema = await schemasApi.getSchemaByName(name);
        validateDefined(schema, 'SchemasApi.getSchemaByName', 'schema');
        return this._normalizeSchema(schema);
      }

      // Fallback: Get all schemas and find by name
      const schemas = await this.getSchemas();
      const matchingSchema = schemas.find((s: SchemaRegistryEntry) => s.name === name);

      if (!matchingSchema) {
        throw new Error(`Schema with name "${name}" not found`);
      }

      // Retrieve the full schema by ID
      return await this.getSchema(matchingSchema.id);
    } catch (error) {
      this.client.handleError(error, `Failed to get schema by name "${name}"`);
    }
  }

  /**
   * Get a schema by ID (alternative method name)
   *
   * Alias for getSchema() to match common API naming conventions.
   *
   * @param schemaId - Schema ID to retrieve
   * @returns Full schema definition
   * @throws DataProducerError if the operation fails or schema not found
   */
  public async getSchemaById(schemaId: string): Promise<Schema> {
    return this.getSchema(schemaId);
  }

  /**
   * Normalize a schema registry entry
   *
   * @param entry - Raw schema registry entry from DataProducer API
   * @returns Normalized SchemaRegistryEntry
   * @private
   */
  private _normalizeSchemaRegistryEntry(entry: any): SchemaRegistryEntry {
    return {
      id: entry.id || entry.schemaId || '',
      name: entry.name || entry.schemaName || '',
      version: entry.version || '1.0',
      createdAt: entry.createdAt || entry.created || undefined,
      updatedAt: entry.updatedAt || entry.modified || undefined,
      description: entry.description || undefined
    };
  }

  /**
   * Normalize a full schema definition
   *
   * @param schema - Raw schema from DataProducer API
   * @returns Normalized Schema
   * @private
   */
  private _normalizeSchema(schema: ExternalSchema | any): Schema {
    // Preserve all original properties and overlay normalized ones
    return {
      ...schema, // Keep all original properties
      id: schema.id || schema.schemaId || '',
      name: schema.name || schema.schemaName || '',
      description: schema.description || undefined,
      version: schema.version || '1.0',
      type: schema.type || 'object',
      fields: schema.fields || schema.properties || [],
      required: schema.required || [],
      additionalProperties: schema.additionalProperties !== false,
      metadata: schema.metadata || {},
      jsonSchema: schema.jsonSchema || schema.schema || undefined,
      openApiSchema: schema.openApiSchema || undefined
    };
  }

  /**
   * Validate data against a schema
   *
   * A utility method that validates data against a schema definition.
   * This uses the schema's validation rules to check if the data conforms.
   *
   * @param data - Data to validate
   * @param schema - Schema to validate against
   * @returns Validation result with errors (if any)
   *
   * @example
   * ```typescript
   * const client = new DataProducerClient(config);
   * await client.connect();
   * const schema = await client.schemas.getSchema('schema-123');
   * const result = client.schemas.validateData({ name: 'John', age: 30 }, schema);
   * if (!result.valid) {
   *   console.error('Validation errors:', result.errors);
   * }
   * ```
   */
  public validateData(data: any, schema: Schema): { valid: boolean; errors: string[] } {
    const errors: string[] = [];

    // Basic validation
    if (!data) {
      errors.push('Data is null or undefined');
      return { valid: false, errors };
    }

    // Check required fields
    if (schema.required && Array.isArray(schema.required)) {
      for (const requiredField of schema.required) {
        if (!(requiredField in data) || data[requiredField] === undefined || data[requiredField] === null) {
          errors.push(`Required field "${requiredField}" is missing`);
        }
      }
    }

    // Get fields - support both 'fields' array and 'properties' object (JSON Schema format)
    let fieldsToValidate: SchemaField[] = [];

    if (schema.fields && Array.isArray(schema.fields)) {
      fieldsToValidate = schema.fields;
    } else if (schema.properties) {
      // Convert properties object to fields array
      fieldsToValidate = Object.entries(schema.properties).map(([name, fieldDef]: [string, any]) => ({
        name,
        type: fieldDef.jsonType || fieldDef.type,
        required: fieldDef.required || false,
        ...fieldDef
      }));
    }

    // Check field types (basic validation)
    for (const field of fieldsToValidate) {
      const fieldName = field.name;
      const fieldValue = data[fieldName];

      // Skip if field is not present and not required
      if (fieldValue === undefined || fieldValue === null) {
        if (field.required) {
          errors.push(`Required field "${fieldName}" is missing`);
        }
        continue;
      }

      // Basic type checking
      const actualType = typeof fieldValue;
      const expectedType = field.type?.toLowerCase();

      if (expectedType) {
        if (expectedType === 'string' && actualType !== 'string') {
          errors.push(`Field "${fieldName}" should be a string, got ${actualType}`);
        } else if (expectedType === 'number' && actualType !== 'number') {
          errors.push(`Field "${fieldName}" should be a number, got ${actualType}`);
        } else if (expectedType === 'boolean' && actualType !== 'boolean') {
          errors.push(`Field "${fieldName}" should be a boolean, got ${actualType}`);
        } else if (expectedType === 'object' && (actualType !== 'object' || Array.isArray(fieldValue))) {
          errors.push(`Field "${fieldName}" should be an object, got ${actualType}`);
        } else if (expectedType === 'array' && !Array.isArray(fieldValue)) {
          errors.push(`Field "${fieldName}" should be an array, got ${actualType}`);
        }
      }
    }

    return {
      valid: errors.length === 0,
      errors
    };
  }
}
