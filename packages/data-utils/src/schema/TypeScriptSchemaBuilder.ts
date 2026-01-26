/**
 * TypeScriptSchemaBuilder - Builds DataProducer Schema objects from TypeScript interfaces
 *
 * This builder reads type information from generated TypeScript classes that have
 * `attributeTypeMap` static property (produced by OpenAPI codegen) and transforms
 * them into DataProducer Schema objects.
 */
import { Schema, Property, Type } from '@zerobias-org/module-interface-dataproducer-hub-sdk';
import { OpenAPILoader } from './OpenAPILoader';
import { TypeMapper } from './TypeMapper';
import {
  TypeScriptSchemaConfig,
  ModelClass,
  AttributeTypeMap,
  SchemaReference,
} from '../types';

/**
 * Builder for creating DataProducer Schema objects from TypeScript interfaces
 *
 * This is the recommended approach when you have generated TypeScript models
 * from OpenAPI codegen, as the attributeTypeMap provides precise type information.
 *
 * @example
 * ```typescript
 * import { Repository } from '@auditlogic/module-github-github/generated/model';
 *
 * const builder = new TypeScriptSchemaBuilder();
 *
 * const repoSchema = builder.build({
 *   schemaId: 'github_repository_schema',
 *   modelClass: Repository,
 *   primaryKeys: ['id'],
 *   references: {
 *     owner: { schemaId: 'github_user_schema' }
 *   },
 *   // Optional: enrich with OpenAPI descriptions
 *   openApiSpec: '/path/to/api.yml',
 *   openApiSchemaName: 'Repository'
 * });
 * ```
 */
export class TypeScriptSchemaBuilder {
  private loader: OpenAPILoader | null = null;

  constructor() {}

  /**
   * Build a Schema from a TypeScript model class
   *
   * @param config - TypeScript schema configuration
   * @returns DataProducer Schema object
   */
  build(config: TypeScriptSchemaConfig): Schema {
    if (!config.schemaId) {
      throw new Error('schemaId is required in config');
    }
    if (!config.modelClass) {
      throw new Error('modelClass is required in config');
    }
    if (!config.modelClass.attributeTypeMap) {
      throw new Error('modelClass must have attributeTypeMap static property');
    }

    // Optionally load OpenAPI spec for descriptions and required fields
    let requiredFields: string[] = [];
    let descriptions: Record<string, string> = {};

    if (config.openApiSpec) {
      this.loader = new OpenAPILoader();
      this.loader.loadSync(config.openApiSpec);

      const schemaName = config.openApiSchemaName || config.modelClass.name || 'Unknown';

      // Get required fields and convert to camelCase
      const openApiRequired = this.loader.getRequiredFields(schemaName);
      requiredFields = openApiRequired.map((field) => this.snakeToCamel(field));

      // Get descriptions (already converted to camelCase by loader)
      descriptions = this.loader.getPropertyDescriptions(schemaName, true);
    }

    // Build properties from attributeTypeMap
    const properties = this.buildProperties(
      config.modelClass.attributeTypeMap,
      requiredFields,
      config.primaryKeys || [],
      descriptions,
      config.references
    );

    // Collect unique data types
    const dataTypeNames = properties.map((p) => p.dataType);
    const dataTypes = TypeMapper.collectTypes(dataTypeNames);

    return new Schema(config.schemaId, dataTypes, properties);
  }

  /**
   * Build a Schema using a shared OpenAPILoader instance
   *
   * Use this when building multiple schemas from the same OpenAPI spec
   * to avoid reloading the spec for each schema.
   *
   * @param config - TypeScript schema configuration
   * @param sharedLoader - Pre-loaded OpenAPILoader instance
   * @returns DataProducer Schema object
   */
  buildWithLoader(config: TypeScriptSchemaConfig, sharedLoader: OpenAPILoader): Schema {
    if (!config.schemaId) {
      throw new Error('schemaId is required in config');
    }
    if (!config.modelClass) {
      throw new Error('modelClass is required in config');
    }
    if (!config.modelClass.attributeTypeMap) {
      throw new Error('modelClass must have attributeTypeMap static property');
    }

    // Use shared loader for descriptions and required fields
    const schemaName = config.openApiSchemaName || config.modelClass.name || 'Unknown';

    // Get required fields and convert to camelCase
    const openApiRequired = sharedLoader.getRequiredFields(schemaName);
    const requiredFields = openApiRequired.map((field) => this.snakeToCamel(field));

    // Get descriptions (already converted to camelCase by loader)
    const descriptions = sharedLoader.getPropertyDescriptions(schemaName, true);

    // Build properties from attributeTypeMap
    const properties = this.buildProperties(
      config.modelClass.attributeTypeMap,
      requiredFields,
      config.primaryKeys || [],
      descriptions,
      config.references
    );

    // Collect unique data types
    const dataTypeNames = properties.map((p) => p.dataType);
    const dataTypes = TypeMapper.collectTypes(dataTypeNames);

    return new Schema(config.schemaId, dataTypes, properties);
  }

  /**
   * Build Property array from attributeTypeMap
   */
  private buildProperties(
    attributeTypeMap: ReadonlyArray<AttributeTypeMap>,
    requiredFields: string[],
    primaryKeys: string[],
    descriptions: Record<string, string>,
    references?: Record<string, SchemaReference>
  ): Property[] {
    const properties: Property[] = [];

    for (const attr of attributeTypeMap) {
      const property = this.buildProperty(
        attr,
        requiredFields,
        primaryKeys,
        descriptions,
        references
      );
      properties.push(property);
    }

    return properties;
  }

  /**
   * Build a single Property from an attributeTypeMap entry
   */
  private buildProperty(
    attr: AttributeTypeMap,
    requiredFields: string[],
    primaryKeys: string[],
    descriptions: Record<string, string>,
    references?: Record<string, SchemaReference>
  ): Property {
    // Map TypeScript type to DataType
    const { dataType, isMulti } = TypeMapper.mapTypeScriptType(attr.type, attr.format);

    // Check if required
    const isRequired = requiredFields.includes(attr.name);

    // Check if primary key
    const isPrimaryKey = primaryKeys.includes(attr.name);

    // Get description from OpenAPI
    const description = descriptions[attr.name];

    // Get schema reference if provided
    const propertyReference = references?.[attr.name];

    return new Property(
      attr.name,
      dataType,
      description,
      isRequired,
      isMulti,
      isPrimaryKey,
      attr.format || undefined,
      propertyReference
    );
  }

  /**
   * Convert snake_case to camelCase
   */
  private snakeToCamel(str: string): string {
    return str.replaceAll(/_([a-z])/g, (_, letter) => letter.toUpperCase());
  }

  /**
   * Get the loader instance (if OpenAPI spec was loaded)
   */
  getLoader(): OpenAPILoader | null {
    return this.loader;
  }
}

/**
 * Convenience function to build a schema from a TypeScript model
 *
 * This is a simpler interface for common use cases.
 *
 * @param modelClass - Generated class with attributeTypeMap
 * @param config - Schema configuration
 * @returns DataProducer Schema object
 *
 * @example
 * ```typescript
 * import { Repository } from '../generated/model';
 * import { buildSchema } from '@zerobias-org/data-utils';
 *
 * const schema = buildSchema(Repository, {
 *   schemaId: 'github_repository_schema',
 *   primaryKeys: ['id']
 * });
 * ```
 */
export function buildSchema(
  modelClass: ModelClass,
  config: Omit<TypeScriptSchemaConfig, 'modelClass'>
): Schema {
  const builder = new TypeScriptSchemaBuilder();
  return builder.build({ ...config, modelClass });
}
