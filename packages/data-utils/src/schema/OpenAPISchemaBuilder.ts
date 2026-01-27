/**
 * OpenAPISchemaBuilder - Builds DataProducer Schema objects from OpenAPI specifications
 *
 * This builder reads schema definitions directly from OpenAPI specs and transforms
 * them into DataProducer Schema objects without needing generated TypeScript classes.
 */
import { Schema, Property } from '@zerobias-org/module-interface-dataproducer-hub-sdk';
import { OpenAPILoader, OpenAPIProperty } from './OpenAPILoader';
import { TypeMapper } from './TypeMapper';
import { OpenAPISchemaConfig, SchemaReference, UrlLoadOptions } from '../types';

/**
 * Builder for creating DataProducer Schema objects from OpenAPI specifications
 *
 * @example
 * ```typescript
 * const builder = new OpenAPISchemaBuilder();
 *
 * const repoSchema = builder.build({
 *   schemaId: 'github_repository_schema',
 *   openApiSpec: '/path/to/api.yml',
 *   schemaName: 'Repository',
 *   primaryKeys: ['id'],
 *   references: {
 *     owner: { schemaId: 'github_user_schema' }
 *   }
 * });
 * ```
 */
export class OpenAPISchemaBuilder {
  private loader: OpenAPILoader;

  constructor() {
    this.loader = new OpenAPILoader();
  }

  /**
   * Build a Schema from an OpenAPI specification (synchronous)
   *
   * For URL sources, use `buildAsync()` instead.
   *
   * @param config - OpenAPI schema configuration
   * @returns DataProducer Schema object
   */
  build(config: OpenAPISchemaConfig): Schema {
    if (!config.schemaId) {
      throw new Error('schemaId is required in config');
    }
    if (!config.schemaName) {
      throw new Error('schemaName is required in config');
    }
    if (!config.openApiSpec) {
      throw new Error('openApiSpec is required in config');
    }

    // Load the OpenAPI spec
    this.loader.loadSync(config.openApiSpec as string | object);

    // Verify schema exists
    const openApiSchema = this.loader.getSchema(config.schemaName);
    if (!openApiSchema) {
      const available = this.loader.getSchemaNames().slice(0, 10).join(', ');
      throw new Error(
        `Schema '${config.schemaName}' not found in OpenAPI spec. ` +
        `Available schemas include: ${available}...`
      );
    }

    // Build properties from OpenAPI schema
    const properties = this.buildProperties(config);

    // Collect unique data types
    const dataTypeNames = properties.map((p) => p.dataType);
    const dataTypes = TypeMapper.collectTypes(dataTypeNames);

    return new Schema(config.schemaId, dataTypes, properties);
  }

  /**
   * Build a Schema from an OpenAPI specification (asynchronous)
   *
   * Supports URLs, file paths, and objects. Use this method when loading
   * specs from remote URLs.
   *
   * @param config - OpenAPI schema configuration
   * @returns Promise resolving to DataProducer Schema object
   *
   * @example
   * ```typescript
   * // Build from remote URL
   * const schema = await builder.buildAsync({
   *   schemaId: 'github_repository_schema',
   *   openApiSpec: 'https://raw.githubusercontent.com/.../api.yaml',
   *   schemaName: 'Repository',
   *   primaryKeys: ['id'],
   *   urlOptions: {
   *     timeout: 60000,
   *     headers: { 'Authorization': 'token xxx' }
   *   }
   * });
   *
   * // Build from local file (async)
   * const schema = await builder.buildAsync({
   *   schemaId: 'petstore_pet_schema',
   *   openApiSpec: '/path/to/petstore.yaml',
   *   schemaName: 'Pet'
   * });
   * ```
   */
  async buildAsync(config: OpenAPISchemaConfig): Promise<Schema> {
    if (!config.schemaId) {
      throw new Error('schemaId is required in config');
    }
    if (!config.schemaName) {
      throw new Error('schemaName is required in config');
    }
    if (!config.openApiSpec) {
      throw new Error('openApiSpec is required in config');
    }

    // Load the OpenAPI spec asynchronously (supports URLs, paths, objects)
    await this.loader.loadAsync(config.openApiSpec, config.urlOptions);

    // Verify schema exists
    const openApiSchema = this.loader.getSchema(config.schemaName);
    if (!openApiSchema) {
      const available = this.loader.getSchemaNames().slice(0, 10).join(', ');
      throw new Error(
        `Schema '${config.schemaName}' not found in OpenAPI spec. ` +
        `Available schemas include: ${available}...`
      );
    }

    // Build properties from OpenAPI schema
    const properties = this.buildProperties(config);

    // Collect unique data types
    const dataTypeNames = properties.map((p) => p.dataType);
    const dataTypes = TypeMapper.collectTypes(dataTypeNames);

    return new Schema(config.schemaId, dataTypes, properties);
  }

  /**
   * Build multiple schemas from the same OpenAPI spec (synchronous)
   *
   * @param specPath - Path to OpenAPI spec file
   * @param configs - Array of schema configurations
   * @returns Map of schemaId to Schema objects
   */
  buildMultiple(specPath: string, configs: OpenAPISchemaConfig[]): Map<string, Schema> {
    // Load spec once
    this.loader.loadSync(specPath);

    const schemas = new Map<string, Schema>();

    for (const config of configs) {
      // Override spec path since it's already loaded
      const configWithSpec = { ...config, openApiSpec: specPath };
      const schema = this.buildFromLoadedSpec(configWithSpec);
      schemas.set(config.schemaId, schema);
    }

    return schemas;
  }

  /**
   * Build multiple schemas from the same OpenAPI spec (asynchronous)
   *
   * Efficiently loads the spec once and builds multiple schemas.
   * Supports URLs, file paths, and objects.
   *
   * @param source - URL, file path, or parsed spec object
   * @param configs - Array of schema configurations (openApiSpec field is ignored)
   * @param urlOptions - Options for URL loading
   * @returns Promise resolving to Map of schemaId to Schema objects
   *
   * @example
   * ```typescript
   * const schemas = await builder.buildMultipleAsync(
   *   'https://api.github.com/openapi.yaml',
   *   [
   *     { schemaId: 'repo_schema', schemaName: 'Repository', primaryKeys: ['id'] },
   *     { schemaId: 'user_schema', schemaName: 'User', primaryKeys: ['id'] },
   *     { schemaId: 'issue_schema', schemaName: 'Issue', primaryKeys: ['id'] }
   *   ],
   *   { timeout: 60000 }
   * );
   * ```
   */
  async buildMultipleAsync(
    source: string | object | URL,
    configs: OpenAPISchemaConfig[],
    urlOptions?: UrlLoadOptions
  ): Promise<Map<string, Schema>> {
    // Load spec once
    await this.loader.loadAsync(source, urlOptions);

    const schemas = new Map<string, Schema>();

    for (const config of configs) {
      // Override spec source since it's already loaded
      const configWithSpec = { ...config, openApiSpec: source };
      const schema = this.buildFromLoadedSpec(configWithSpec);
      schemas.set(config.schemaId, schema);
    }

    return schemas;
  }

  /**
   * Build schema when spec is already loaded
   */
  private buildFromLoadedSpec(config: OpenAPISchemaConfig): Schema {
    const openApiSchema = this.loader.getSchema(config.schemaName);
    if (!openApiSchema) {
      throw new Error(`Schema '${config.schemaName}' not found in OpenAPI spec`);
    }

    const properties = this.buildProperties(config);
    const dataTypeNames = properties.map((p) => p.dataType);
    const dataTypes = TypeMapper.collectTypes(dataTypeNames);

    return new Schema(config.schemaId, dataTypes, properties);
  }

  /**
   * Build Property array from OpenAPI schema definition
   */
  private buildProperties(config: OpenAPISchemaConfig): Property[] {
    const openApiProperties = this.loader.getProperties(config.schemaName);
    const requiredFields = this.loader.getRequiredFields(config.schemaName);
    const primaryKeys = config.primaryKeys || [];

    const properties: Property[] = [];

    for (const [propName, propDef] of Object.entries(openApiProperties)) {
      const camelName = this.snakeToCamel(propName);
      const property = this.buildProperty(
        camelName,
        propName,
        propDef,
        requiredFields,
        primaryKeys,
        config.references
      );
      properties.push(property);
    }

    return properties;
  }

  /**
   * Build a single Property from OpenAPI property definition
   */
  private buildProperty(
    name: string,
    originalName: string,
    propDef: OpenAPIProperty,
    requiredFields: string[],
    primaryKeys: string[],
    references?: Record<string, SchemaReference>
  ): Property {
    // Determine data type from OpenAPI definition
    const { dataType, isMulti } = this.mapOpenAPIType(propDef);

    // Check if required (using original snake_case name)
    const isRequired = requiredFields.includes(originalName);

    // Check if primary key (using camelCase name)
    const isPrimaryKey = primaryKeys.includes(name);

    // Get description
    const description = propDef.description;

    // Get format
    const format = propDef.format;

    // Get schema reference if provided
    const propertyReference = references?.[name];

    return new Property(
      name,
      dataType,
      description,
      isRequired,
      isMulti,
      isPrimaryKey,
      format,
      propertyReference
    );
  }

  /**
   * Map OpenAPI property type to DataType name
   */
  private mapOpenAPIType(propDef: OpenAPIProperty): { dataType: string; isMulti: boolean } {
    // Handle arrays
    if (propDef.type === 'array') {
      if (propDef.items) {
        const itemType = this.mapOpenAPIType(propDef.items);
        return { dataType: itemType.dataType, isMulti: true };
      }
      return { dataType: 'string', isMulti: true };
    }

    // Handle $ref - treat as object reference
    if (propDef.$ref) {
      return { dataType: 'object', isMulti: false };
    }

    // Handle oneOf/anyOf - use first type as fallback
    if (propDef.oneOf || propDef.anyOf) {
      const variants = propDef.oneOf || propDef.anyOf || [];
      if (variants.length > 0) {
        return this.mapOpenAPIType(variants[0]);
      }
      return { dataType: 'string', isMulti: false };
    }

    // Use format hint if available
    if (propDef.format) {
      const mapping = TypeMapper.mapTypeScriptType('string', propDef.format);
      return mapping;
    }

    // Map OpenAPI type to DataType
    const typeMap: Record<string, string> = {
      string: 'string',
      integer: 'integer',
      number: 'number',
      boolean: 'boolean',
      object: 'object',
    };

    const dataType = typeMap[propDef.type || 'string'] || 'string';
    return { dataType, isMulti: false };
  }

  /**
   * Convert snake_case to camelCase
   */
  private snakeToCamel(str: string): string {
    return str.replaceAll(/_([a-z])/g, (_, letter) => letter.toUpperCase());
  }

  /**
   * Get the loader instance (for advanced use cases)
   */
  getLoader(): OpenAPILoader {
    return this.loader;
  }
}
