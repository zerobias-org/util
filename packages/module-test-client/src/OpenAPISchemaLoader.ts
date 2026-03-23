import * as yaml from 'js-yaml';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

// ESM equivalent of __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * OpenAPI property definition
 */
interface OpenAPIProperty {
  type: string;
  description?: string;
  format?: string;
  items?: OpenAPIProperty;
  $ref?: string;
  enum?: string[];
  [key: string]: any;
}

/**
 * OpenAPI schema definition
 */
export interface OpenAPISchema {
  type: string;
  description?: string;
  properties?: Record<string, OpenAPIProperty>;
  required?: string[];
  [key: string]: any;
}

/**
 * OpenAPI specification structure
 */
interface OpenAPISpec {
  components: {
    schemas: Record<string, OpenAPISchema>;
  };
}

/**
 * Derive distribution spec filename from package.json name.
 * @auditlogic/module-github-github → module-github-github.yml
 */
function deriveSpecName(): string {
  // Walk up from __dirname to find package.json
  const candidates = [
    path.join(__dirname, '../package.json'),       // src/
    path.join(__dirname, '../../package.json'),     // dist/src/
  ];
  for (const pkgPath of candidates) {
    if (fs.existsSync(pkgPath)) {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
      const name: string = pkg.name ?? '';
      // @auditlogic/module-github-github → module-github-github
      const stripped = name.replace(/^@[^/]+\//, '');
      return `${stripped}.yml`;
    }
  }
  throw new Error('package.json not found — cannot derive spec filename');
}

/**
 * Singleton loader for OpenAPI schema definitions.
 *
 * Derives the spec filename from package.json name (convention-based).
 * Searches generated/ (dev) and package root (production/Docker).
 */
export class OpenAPISchemaLoader {
  private static instance: OpenAPISchemaLoader;
  private schemas: Record<string, OpenAPISchema>;
  private specPath: string;

  private constructor() {
    const specName = deriveSpecName();

    // Search paths: generated/ (dev build), package root (published npm package)
    const searchPaths = [
      path.join(__dirname, '../generated', specName),      // src/ → generated/
      path.join(__dirname, '../../generated', specName),    // dist/src/ → generated/
      path.join(__dirname, '..', specName),                 // src/ → root (published)
      path.join(__dirname, '../..', specName),              // dist/src/ → root (published)
    ];

    const found = searchPaths.find(p => fs.existsSync(p));
    if (!found) {
      throw new Error(
        `OpenAPI spec '${specName}' not found. Searched:\n` +
        searchPaths.map(p => `  ${p}`).join('\n')
      );
    }
    this.specPath = found;

    try {
      const specContent = fs.readFileSync(this.specPath, 'utf8');
      const spec = yaml.load(specContent) as OpenAPISpec;

      if (!spec.components?.schemas) {
        throw new Error('Invalid OpenAPI spec: missing components.schemas');
      }

      this.schemas = spec.components.schemas;
    } catch (error) {
      throw new Error(`Failed to load OpenAPI spec from ${this.specPath}: ${error}`);
    }
  }

  static getInstance(): OpenAPISchemaLoader {
    if (!OpenAPISchemaLoader.instance) {
      OpenAPISchemaLoader.instance = new OpenAPISchemaLoader();
    }
    return OpenAPISchemaLoader.instance;
  }

  getSchema(schemaName: string): OpenAPISchema | undefined {
    return this.schemas[schemaName];
  }

  getRequiredFields(schemaName: string): string[] {
    const schema = this.getSchema(schemaName);
    return schema?.required || [];
  }

  getPropertyDescriptions(schemaName: string, convertCasing: boolean = true): Record<string, string> {
    const schema = this.getSchema(schemaName);
    if (!schema?.properties) return {};

    const descriptions: Record<string, string> = {};
    for (const [propName, propDef] of Object.entries(schema.properties)) {
      if (propDef.description) {
        const key = convertCasing ? propName.replace(/_([a-z])/g, (_, l) => l.toUpperCase()) : propName;
        descriptions[key] = propDef.description;
      }
    }
    return descriptions;
  }

  getSchemaNames(): string[] {
    return Object.keys(this.schemas);
  }

  getSpecPath(): string {
    return this.specPath;
  }
}
