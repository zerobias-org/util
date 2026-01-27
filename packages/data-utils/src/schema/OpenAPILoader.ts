/**
 * OpenAPILoader - Loads and queries OpenAPI specifications
 *
 * Provides methods to:
 * - Load OpenAPI specs from file path, URL, or parsed object
 * - Stream-based URL loading for efficient memory usage
 * - Query schema definitions
 * - Extract required fields and descriptions
 */
import * as fs from 'node:fs';
import { promises as fsPromises } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { UrlLoadOptions } from '../types/SchemaConfig';

/**
 * OpenAPI property definition
 */
export interface OpenAPIProperty {
  type?: string;
  description?: string;
  format?: string;
  items?: OpenAPIProperty;
  $ref?: string;
  enum?: string[];
  oneOf?: OpenAPIProperty[];
  anyOf?: OpenAPIProperty[];
  allOf?: OpenAPIProperty[];
  nullable?: boolean;
  readOnly?: boolean;
  writeOnly?: boolean;
  example?: unknown;
  default?: unknown;
  [key: string]: unknown;
}

/**
 * OpenAPI schema definition
 */
export interface OpenAPISchema {
  type?: string;
  description?: string;
  properties?: Record<string, OpenAPIProperty>;
  required?: string[];
  allOf?: Array<{ $ref?: string; properties?: Record<string, OpenAPIProperty> }>;
  oneOf?: OpenAPISchema[];
  anyOf?: OpenAPISchema[];
  enum?: string[];
  items?: OpenAPIProperty;
  [key: string]: unknown;
}

/**
 * OpenAPI specification structure
 */
interface OpenAPISpec {
  openapi?: string;
  info?: {
    title?: string;
    version?: string;
    description?: string;
  };
  components?: {
    schemas?: Record<string, OpenAPISchema>;
    securitySchemes?: Record<string, unknown>;
  };
  paths?: Record<string, unknown>;
}

/**
 * Loader for OpenAPI specifications
 *
 * @example
 * ```typescript
 * // Load from file path
 * const loader = new OpenAPILoader();
 * loader.loadSync('/path/to/api.yml');
 *
 * // Or load from object
 * loader.loadSync(parsedSpec);
 *
 * // Query schema
 * const schema = loader.getSchema('Repository');
 * const required = loader.getRequiredFields('Repository');
 * const descriptions = loader.getPropertyDescriptions('Repository');
 * ```
 */
export class OpenAPILoader {
  private spec: OpenAPISpec | undefined = undefined;
  private schemas: Record<string, OpenAPISchema> = {};

  /**
   * Load OpenAPI specification synchronously
   *
   * @param specPathOrObject - File path to YAML/JSON spec or parsed spec object
   * @throws Error if spec cannot be loaded or is invalid
   */
  loadSync(specPathOrObject: string | object): void {
    if (typeof specPathOrObject === 'string') {
      this.loadFromPath(specPathOrObject);
    } else {
      this.loadFromObject(specPathOrObject);
    }
  }

  /**
   * Load OpenAPI specification asynchronously
   *
   * Supports multiple source types:
   * - File paths (local filesystem)
   * - URLs (http:// or https://)
   * - URL objects
   * - Parsed spec objects
   *
   * @param source - File path, URL string, URL object, or parsed spec object
   * @param options - Options for URL loading (headers, timeout, etc.)
   * @throws Error if spec cannot be loaded or is invalid
   *
   * @example
   * ```typescript
   * // Load from URL
   * await loader.loadAsync('https://api.example.com/openapi.yaml');
   *
   * // Load from URL with auth
   * await loader.loadAsync('https://api.example.com/openapi.json', {
   *   headers: { 'Authorization': 'Bearer token' },
   *   timeout: 60000
   * });
   *
   * // Load from file path (async)
   * await loader.loadAsync('/path/to/spec.yaml');
   *
   * // Load from object
   * await loader.loadAsync(parsedSpecObject);
   * ```
   */
  async loadAsync(source: string | object | URL, options?: UrlLoadOptions): Promise<void> {
    // Handle parsed objects (but not URL instances)
    if (typeof source === 'object' && !(source instanceof URL)) {
      this.loadFromObject(source);
      return;
    }

    const sourceStr = source instanceof URL ? source.toString() : source;

    // Check if it's a URL or file path
    await (sourceStr.startsWith('http://') || sourceStr.startsWith('https://')
      ? this.loadFromUrl(sourceStr, options)
      : this.loadFromPathAsync(sourceStr));
  }

  /**
   * Load OpenAPI spec from a URL using streaming fetch
   *
   * Uses the native fetch API with streaming for efficient memory usage
   * when downloading large specifications.
   *
   * @param url - URL to fetch the OpenAPI spec from
   * @param options - URL loading options (headers, timeout, contentType)
   * @throws Error if fetch fails, times out, or spec is invalid
   *
   * @example
   * ```typescript
   * // Simple fetch
   * await loader.loadFromUrl('https://raw.githubusercontent.com/OAI/OpenAPI-Specification/main/examples/v3.0/petstore.yaml');
   *
   * // With authentication
   * await loader.loadFromUrl('https://api.private.com/openapi.json', {
   *   headers: { 'X-API-Key': 'my-api-key' },
   *   timeout: 45000,
   *   contentType: 'json'
   * });
   * ```
   */
  async loadFromUrl(url: string, options: UrlLoadOptions = {}): Promise<void> {
    const { headers = {}, timeout = 30_000, contentType = 'auto' } = options;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    try {
      const response = await fetch(url, {
        headers,
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      // Stream the response body to string
      const content = await this.streamToString(response);

      // Detect format and parse
      const format = this.detectFormat(url, response, contentType);
      const parsed = format === 'json' ? JSON.parse(content) : parseYaml(content);

      this.loadFromObject(parsed);
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error(`Request timeout after ${timeout}ms: ${url}`);
      }
      throw new Error(`Failed to load OpenAPI spec from ${url}: ${error}`);
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * Stream response body to string efficiently
   *
   * Uses ReadableStream chunks for memory-efficient downloading
   * of large OpenAPI specifications.
   */
  private async streamToString(response: Response): Promise<string> {
    const reader = response.body?.getReader();
    if (!reader) {
      // Fallback if body is not streamable
      return response.text();
    }

    const decoder = new TextDecoder();
    const chunks: string[] = [];

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(decoder.decode(value, { stream: true }));
    }

    // Flush any remaining bytes
    chunks.push(decoder.decode());

    return chunks.join('');
  }

  /**
   * Detect content format from URL extension and response headers
   */
  private detectFormat(
    url: string,
    response: Response,
    override: 'json' | 'yaml' | 'auto'
  ): 'json' | 'yaml' {
    if (override !== 'auto') {
      return override;
    }

    // Check Content-Type header first
    const contentType = response.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
      return 'json';
    }
    if (contentType.includes('yaml') || contentType.includes('x-yaml')) {
      return 'yaml';
    }

    // Fallback to URL extension
    const urlLower = url.toLowerCase();
    if (urlLower.endsWith('.json')) {
      return 'json';
    }

    // Default to YAML for .yml, .yaml, or unknown extensions
    return 'yaml';
  }

  /**
   * Load spec from file path asynchronously
   */
  private async loadFromPathAsync(specPath: string): Promise<void> {
    try {
      const content = await fsPromises.readFile(specPath, 'utf8');

      // Parse based on file extension
      if (specPath.endsWith('.json')) {
        this.loadFromObject(JSON.parse(content));
      } else {
        // Assume YAML (.yml, .yaml, or no extension)
        this.loadFromObject(parseYaml(content));
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new Error(`OpenAPI spec not found at ${specPath}`);
      }
      throw new Error(`Failed to load OpenAPI spec from ${specPath}: ${error}`);
    }
  }

  /**
   * Load spec from file path
   */
  private loadFromPath(specPath: string): void {
    if (!fs.existsSync(specPath)) {
      throw new Error(`OpenAPI spec not found at ${specPath}`);
    }

    try {
      const content = fs.readFileSync(specPath, 'utf8');

      // Parse based on file extension
      if (specPath.endsWith('.json')) {
        this.loadFromObject(JSON.parse(content));
      } else {
        // Assume YAML (.yml, .yaml, or no extension)
        this.loadFromObject(parseYaml(content));
      }
    } catch (error) {
      throw new Error(`Failed to load OpenAPI spec from ${specPath}: ${error}`);
    }
  }

  /**
   * Load spec from parsed object
   */
  private loadFromObject(spec: object): void {
    this.spec = spec as OpenAPISpec;

    // Use components.schemas if available, otherwise check top level or default to empty
    this.schemas = this.spec.components?.schemas || (spec as any).schemas || {};
  }

  /**
   * Check if spec is loaded
   */
  isLoaded(): boolean {
    return this.spec !== undefined;
  }

  /**
   * Get OpenAPI schema definition by name
   *
   * @param schemaName - Name of the schema (e.g., "Repository", "PullRequest")
   * @returns Schema definition or undefined if not found
   */
  getSchema(schemaName: string): OpenAPISchema | undefined {
    return this.schemas[schemaName];
  }

  /**
   * Get all available schema names
   */
  getSchemaNames(): string[] {
    return Object.keys(this.schemas);
  }

  /**
   * Get required fields for a schema
   *
   * @param schemaName - Name of the schema
   * @returns Array of required field names (original casing from OpenAPI, usually snake_case)
   */
  getRequiredFields(schemaName: string): string[] {
    const schema = this.getSchema(schemaName);
    if (!schema) {
      return [];
    }

    // Handle allOf compositions
    if (schema.allOf) {
      const required: string[] = [];
      for (const part of schema.allOf) {
        if (part.$ref) {
          const refName = this.extractRefName(part.$ref);
          if (refName) {
            required.push(...this.getRequiredFields(refName));
          }
        }
      }
      if (schema.required) {
        required.push(...schema.required);
      }
      return [...new Set(required)];
    }

    return schema.required || [];
  }

  /**
   * Get property descriptions for a schema
   *
   * @param schemaName - Name of the schema
   * @param convertToCamelCase - If true, converts snake_case keys to camelCase
   * @returns Map of property names to descriptions
   */
  getPropertyDescriptions(schemaName: string, convertToCamelCase: boolean = true): Record<string, string> {
    const schema = this.getSchema(schemaName);
    if (!schema) {
      return {};
    }

    const descriptions: Record<string, string> = {};

    // Get properties from direct definition
    if (schema.properties) {
      this.extractDescriptions(schema.properties, descriptions, convertToCamelCase);
    }

    // Handle allOf compositions
    if (schema.allOf) {
      for (const part of schema.allOf) {
        if (part.$ref) {
          const refName = this.extractRefName(part.$ref);
          if (refName) {
            const refDescriptions = this.getPropertyDescriptions(refName, convertToCamelCase);
            Object.assign(descriptions, refDescriptions);
          }
        }
        if (part.properties) {
          this.extractDescriptions(part.properties, descriptions, convertToCamelCase);
        }
      }
    }

    return descriptions;
  }

  /**
   * Get all properties for a schema (merged from allOf if present)
   *
   * @param schemaName - Name of the schema
   * @returns Map of property names to property definitions
   */
  getProperties(schemaName: string): Record<string, OpenAPIProperty> {
    const schema = this.getSchema(schemaName);
    if (!schema) {
      return {};
    }

    const properties: Record<string, OpenAPIProperty> = {};

    // Get properties from direct definition
    if (schema.properties) {
      Object.assign(properties, schema.properties);
    }

    // Handle allOf compositions
    if (schema.allOf) {
      for (const part of schema.allOf) {
        if (part.$ref) {
          const refName = this.extractRefName(part.$ref);
          if (refName) {
            const refProps = this.getProperties(refName);
            Object.assign(properties, refProps);
          }
        }
        if (part.properties) {
          Object.assign(properties, part.properties);
        }
      }
    }

    return properties;
  }

  /**
   * Extract descriptions from properties map
   */
  private extractDescriptions(
    properties: Record<string, OpenAPIProperty>,
    target: Record<string, string>,
    convertToCamelCase: boolean
  ): void {
    for (const [propName, propDef] of Object.entries(properties)) {
      if (propDef.description) {
        const key = convertToCamelCase ? this.snakeToCamel(propName) : propName;
        target[key] = propDef.description;
      }
    }
  }

  /**
   * Extract schema name from $ref string
   *
   * @param ref - Reference string like "#/components/schemas/Repository"
   * @returns Schema name or undefined
   */
  private extractRefName(ref: string): string | undefined {
    const match = ref.match(/#\/components\/schemas\/(.+)/);
    return match ? match[1] : undefined;
  }

  /**
   * Convert snake_case to camelCase
   */
  private snakeToCamel(str: string): string {
    return str.replaceAll(/_([a-z])/g, (_, letter) => letter.toUpperCase());
  }

  /**
   * Convert camelCase to snake_case
   */
  static camelToSnake(str: string): string {
    return str.replaceAll(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
  }

  /**
   * Get spec info (title, version, description)
   */
  getInfo(): { title?: string; version?: string; description?: string } {
    return this.spec?.info || {};
  }
}
