/**
 * TypeMapper - Maps TypeScript types and OpenAPI formats to DataProducer types
 *
 * Uses @zerobias-org/types-core-js CoreType for dynamic type resolution, ensuring
 * type definitions stay in sync with the platform's core type definitions.
 *
 * Provides bidirectional mapping between:
 * - TypeScript types (string, number, Array<T>, URL, Email, etc.)
 * - OpenAPI format hints (uri, email, date-time, etc.)
 * - DataProducer DataType names (url, email, date-time, etc.)
 * - JSON Schema types (string, number, boolean, etc.)
 * - HTML input types (text, email, url, date, etc.)
 */
import { Type } from '@zerobias-org/module-interface-dataproducer-hub-sdk';
import { CoreType } from '@zerobias-org/types-core-js';

/**
 * Result of TypeScript type to DataType mapping
 */
export interface TypeMappingResult {
  /** CoreType DataType name */
  dataType: string;

  /** Whether this is a multi-valued property (array) */
  isMulti: boolean;
}

/**
 * Maps TypeScript types and formats to DataProducer types
 */
export class TypeMapper {
  /**
   * Core type mappings from @zerobias-org/types-core-js class names to their canonical type names.
   * These map TypeScript class names used in generated code to their CoreType names.
   */
  static readonly CORE_TYPE_MAP: Readonly<Record<string, string>> = {
    URL: 'url',
    MimeType: 'mimeType',
    GeoCountry: 'geoCountry',
    GeoSubdivision: 'geoSubdivision',
    PhoneNumber: 'phoneNumber',
    IpAddress: 'ipAddress',
    Email: 'email',
    EnumValue: 'string',
  };

  /**
   * Primitive TypeScript type to DataType mappings.
   * These are TypeScript-specific and don't have CoreType equivalents.
   */
  static readonly PRIMITIVE_MAP: Readonly<Record<string, string>> = {
    string: 'string',
    number: 'number',
    boolean: 'boolean',
    Date: 'date-time',
    object: 'object',
    any: 'string',
  };

  /**
   * Fallback format mappings for formats not in CoreType.
   * CoreType handles most format aliases (uri→url, phone→phoneNumber),
   * but some OpenAPI-specific formats need explicit mapping.
   */
  private static readonly FALLBACK_FORMAT_MAP: Readonly<Record<string, string>> = {
    'uri-reference': 'url',
    'mime-type': 'mimeType',
    binary: 'byte',
    int32: 'integer',
    int64: 'integer',
    float: 'number',
    double: 'number',
  };

  /**
   * Resolves a format string to its canonical CoreType name using CoreType.
   * Falls back to hardcoded mappings for formats not in CoreType.
   *
   * @param format - OpenAPI format string (e.g., 'uri', 'email', 'date-time')
   * @returns Canonical CoreType name or undefined if not found
   */
  static resolveFormat(format: string): string | undefined {
    // First try CoreType - it handles format aliases automatically
    try {
      const coreType = CoreType.get(format);
      return coreType.name;
    } catch {
      // Not a direct CoreType match, check fallback mappings
    }

    // Check fallback mappings for OpenAPI-specific formats
    if (TypeMapper.FALLBACK_FORMAT_MAP[format]) {
      return TypeMapper.FALLBACK_FORMAT_MAP[format];
    }

    return undefined;
  }

  /**
   * Gets all available CoreType names from @zerobias-org/types-core-js
   *
   * @returns Array of all valid CoreType names
   */
  static listCoreTypes(): string[] {
    return CoreType.listTypes();
  }

  /**
   * Gets all valid format aliases from @zerobias-org/types-core-js
   *
   * @returns Array of all valid format strings (superset of listCoreTypes)
   */
  static listAllFormats(): string[] {
    return CoreType.allFormats();
  }

  /**
   * Maps a TypeScript type string and optional format hint to a DataType name
   *
   * @param tsType - TypeScript type string (e.g., 'string', 'Array<Label>', 'URL')
   * @param format - Optional OpenAPI format hint (e.g., 'uri', 'email', 'date-time')
   * @returns TypeMappingResult with dataType name and isMulti flag
   *
   * @example
   * ```typescript
   * TypeMapper.mapTypeScriptType('string', 'uri')     // { dataType: 'url', isMulti: false }
   * TypeMapper.mapTypeScriptType('Array<string>', '') // { dataType: 'string', isMulti: true }
   * TypeMapper.mapTypeScriptType('Email', '')         // { dataType: 'email', isMulti: false }
   * ```
   */
  static mapTypeScriptType(tsType: string, format?: string): TypeMappingResult {
    // Handle arrays - extract element type and recurse
    const arrayMatch = tsType.match(/^Array<(.+)>$/);
    if (arrayMatch) {
      const elementType = arrayMatch[1];
      const elementMapping = TypeMapper.mapTypeScriptType(elementType, format);
      return { ...elementMapping, isMulti: true };
    }

    // Handle core types from @zerobias-org/types-core-js class names
    if (TypeMapper.CORE_TYPE_MAP[tsType]) {
      return { dataType: TypeMapper.CORE_TYPE_MAP[tsType], isMulti: false };
    }

    // Handle format hints using CoreType (takes precedence over primitive types for strings)
    if (format) {
      const resolvedType = TypeMapper.resolveFormat(format);
      if (resolvedType) {
        return { dataType: resolvedType, isMulti: false };
      }
    }

    // Handle primitive types
    if (TypeMapper.PRIMITIVE_MAP[tsType]) {
      return { dataType: TypeMapper.PRIMITIVE_MAP[tsType], isMulti: false };
    }

    // Handle enums (e.g., 'Repository.VisibilityEnum')
    if (tsType.includes('.') && tsType.includes('Enum')) {
      return { dataType: 'string', isMulti: false };
    }

    // Default: treat unknown types as string (nested objects, custom types)
    return { dataType: 'string', isMulti: false };
  }

  /**
   * Maps a DataType name to its JSON Schema type using CoreType.
   *
   * @param dataTypeName - DataType name (e.g., 'url', 'email', 'number')
   * @returns JSON Schema type enum value
   */
  static toJsonType(dataTypeName: string): typeof Type.JsonTypeEnum[keyof typeof Type.JsonTypeEnum] {
    // Handle primitive types not in CoreType
    const primitiveJsonTypes: Record<string, typeof Type.JsonTypeEnum[keyof typeof Type.JsonTypeEnum]> = {
      object: Type.JsonTypeEnum.Object,
      array: Type.JsonTypeEnum.Array,
    };
    if (primitiveJsonTypes[dataTypeName]) {
      return primitiveJsonTypes[dataTypeName];
    }

    // Use CoreType for dynamic lookup
    try {
      const coreType = CoreType.get(dataTypeName);
      // CoreType.jsonType returns the JSON type as a string ('string', 'number', 'boolean', 'object')
      const jsonTypeStr = String(coreType.jsonType);
      const jsonTypeMap: Record<string, typeof Type.JsonTypeEnum[keyof typeof Type.JsonTypeEnum]> = {
        string: Type.JsonTypeEnum.String,
        number: Type.JsonTypeEnum.Number,
        boolean: Type.JsonTypeEnum.Boolean,
        object: Type.JsonTypeEnum.Object,
        array: Type.JsonTypeEnum.Array,
      };
      return jsonTypeMap[jsonTypeStr] || Type.JsonTypeEnum.String;
    } catch {
      // Not a CoreType, default to string
      return Type.JsonTypeEnum.String;
    }
  }

  /**
   * Maps a DataType name to its HTML input type using CoreType.
   *
   * @param dataTypeName - DataType name (e.g., 'url', 'email', 'number')
   * @returns HTML input type enum value
   */
  static toHtmlInput(dataTypeName: string): typeof Type.HtmlInputEnum[keyof typeof Type.HtmlInputEnum] {
    // Handle primitive types
    const primitiveHtmlInputs: Record<string, typeof Type.HtmlInputEnum[keyof typeof Type.HtmlInputEnum]> = {
      number: Type.HtmlInputEnum.Number,
      integer: Type.HtmlInputEnum.Number,
    };
    if (primitiveHtmlInputs[dataTypeName]) {
      return primitiveHtmlInputs[dataTypeName];
    }

    // Use CoreType for dynamic lookup
    try {
      const coreType = CoreType.get(dataTypeName);
      // CoreType.htmlInput returns the HTML input type as a string ('text', 'email', 'url', etc.)
      const htmlInputStr = String(coreType.htmlInput);
      const htmlInputMap: Record<string, typeof Type.HtmlInputEnum[keyof typeof Type.HtmlInputEnum]> = {
        text: Type.HtmlInputEnum.Text,
        email: Type.HtmlInputEnum.Email,
        url: Type.HtmlInputEnum.Url,
        tel: Type.HtmlInputEnum.Tel,
        password: Type.HtmlInputEnum.Password,
        number: Type.HtmlInputEnum.Number,
        date: Type.HtmlInputEnum.Date,
        'datetime-local': Type.HtmlInputEnum.DatetimeLocal,
      };
      return htmlInputMap[htmlInputStr] || Type.HtmlInputEnum.Text;
    } catch {
      // Not a CoreType, default to text
      return Type.HtmlInputEnum.Text;
    }
  }

  /**
   * Creates a Type object from a DataType name using CoreType metadata.
   *
   * @param dataTypeName - DataType name (e.g., 'url', 'email', 'string')
   * @returns Type object suitable for Schema.dataTypes array
   *
   * @example
   * ```typescript
   * const urlType = TypeMapper.createType('url');
   * // Returns Type with name, jsonType, htmlInput, description, examples, pattern from CoreType
   * ```
   */
  static createType(dataTypeName: string): Type {
    // Try to get rich metadata from CoreType
    try {
      const coreType = CoreType.get(dataTypeName);
      const jsonType = TypeMapper.toJsonType(dataTypeName);
      const htmlInput = TypeMapper.toHtmlInput(dataTypeName);

      return new Type(
        coreType.name,                    // name
        jsonType,                         // jsonType
        coreType.isEnum,                  // isEnum
        coreType.description,             // description
        coreType.examples || [],          // examples
        htmlInput,                        // htmlInput
        coreType.isEnum ? coreType.enumValues : undefined,  // enumValues
        undefined,                        // minValue
        undefined,                        // maxValue
        coreType.pattern,                 // pattern
        undefined                         // defaultValue
      );
    } catch {
      // Fallback for types not in CoreType (object, array, etc.)
      const jsonType = TypeMapper.toJsonType(dataTypeName);
      const htmlInput = TypeMapper.toHtmlInput(dataTypeName);

      return new Type(
        dataTypeName,           // name
        jsonType,               // jsonType
        false,                  // isEnum
        `${dataTypeName} type`, // description
        [],                     // examples
        htmlInput,              // htmlInput
        undefined,              // enumValues
        undefined,              // minValue
        undefined,              // maxValue
        undefined,              // pattern
        undefined               // defaultValue
      );
    }
  }

  /**
   * Collects unique Type objects from an array of dataType names
   *
   * @param dataTypeNames - Array of DataType names
   * @returns Array of unique Type objects
   */
  static collectTypes(dataTypeNames: string[]): Type[] {
    const uniqueNames = [...new Set(dataTypeNames)];
    return uniqueNames.map((name) => TypeMapper.createType(name));
  }
}
