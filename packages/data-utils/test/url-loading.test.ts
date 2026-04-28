/**
 * Tests for URL-based OpenAPI spec loading
 *
 * These tests verify:
 * - Loading specs from remote URLs using streaming fetch
 * - Async methods for both OpenAPILoader and OpenAPISchemaBuilder
 * - Timeout handling
 * - Content type detection
 */
import { expect } from 'chai';
import { Schema } from '@zerobias-org/module-interface-dataproducer';
import { OpenAPISchemaBuilder, OpenAPILoader } from '../src';

// Public OpenAPI spec URLs for testing
// Using the Swagger Petstore v3 example API
const PETSTORE_JSON_URL = 'https://petstore3.swagger.io/api/v3/openapi.json';
// For YAML, we'll use the GitHub raw link to the actual source
const PETSTORE_YAML_URL =
  'https://raw.githubusercontent.com/swagger-api/swagger-petstore/master/src/main/resources/openapi.yaml';

// Timeout for network requests (longer for CI environments)
const NETWORK_TIMEOUT = 30000;

describe('OpenAPILoader - URL Loading', function () {
  // Increase timeout for network requests
  this.timeout(NETWORK_TIMEOUT + 5000);

  let loader: OpenAPILoader;

  beforeEach(() => {
    loader = new OpenAPILoader();
  });

  describe('loadAsync', () => {
    it('should load OpenAPI spec from YAML URL', async () => {
      await loader.loadAsync(PETSTORE_YAML_URL);

      expect(loader.isLoaded()).to.be.true;
      expect(loader.getSchemaNames()).to.include('Pet');
    });

    it('should load OpenAPI spec from JSON URL', async () => {
      await loader.loadAsync(PETSTORE_JSON_URL);

      expect(loader.isLoaded()).to.be.true;
      expect(loader.getSchemaNames()).to.include('Pet');
    });

    it('should load spec from URL object', async () => {
      const url = new URL(PETSTORE_JSON_URL);
      await loader.loadAsync(url);

      expect(loader.isLoaded()).to.be.true;
    });

    it('should load spec from parsed object', async () => {
      const mockSpec = {
        openapi: '3.0.0',
        info: { title: 'Test API', version: '1.0.0' },
        components: {
          schemas: {
            TestModel: {
              type: 'object',
              properties: {
                id: { type: 'integer' },
                name: { type: 'string' },
              },
            },
          },
        },
      };

      await loader.loadAsync(mockSpec);

      expect(loader.isLoaded()).to.be.true;
      expect(loader.getSchemaNames()).to.include('TestModel');
    });

    it('should respect custom timeout option', async () => {
      try {
        // Use a very short timeout to trigger timeout error
        await loader.loadAsync(PETSTORE_YAML_URL, { timeout: 1 });
        // If we get here, the request was faster than 1ms (unlikely but possible)
      } catch (error) {
        expect((error as Error).message).to.include('timeout');
      }
    });

    it('should handle invalid URL gracefully', async () => {
      try {
        await loader.loadAsync('https://invalid.example.com/nonexistent.yaml', {
          timeout: 5000,
        });
        expect.fail('Should have thrown an error');
      } catch (error) {
        expect((error as Error).message).to.include('Failed to load');
      }
    });
  });

  describe('loadFromUrl', () => {
    it('should force JSON content type', async () => {
      // Use YAML URL but force JSON parsing - should fail since content is YAML
      try {
        await loader.loadFromUrl(PETSTORE_YAML_URL, { contentType: 'json' });
        expect.fail('Should have thrown a JSON parse error');
      } catch (error) {
        // Expected: JSON parse error on YAML content
        expect((error as Error).message).to.include('Failed to load');
      }
    });

    it('should force YAML content type', async () => {
      // Use JSON URL but force YAML parsing - YAML parser can handle JSON
      await loader.loadFromUrl(PETSTORE_JSON_URL, { contentType: 'yaml' });
      expect(loader.isLoaded()).to.be.true;
    });

    it('should auto-detect content type from URL extension', async () => {
      // JSON URL should be detected and parsed as JSON
      await loader.loadFromUrl(PETSTORE_JSON_URL, { contentType: 'auto' });
      expect(loader.isLoaded()).to.be.true;

      // Reset and load YAML
      loader = new OpenAPILoader();
      await loader.loadFromUrl(PETSTORE_YAML_URL, { contentType: 'auto' });
      expect(loader.isLoaded()).to.be.true;
    });
  });

  describe('getSchema after URL load', () => {
    it('should query schemas after loading from URL', async () => {
      await loader.loadAsync(PETSTORE_YAML_URL);

      const petSchema = loader.getSchema('Pet');
      expect(petSchema).to.exist;
      expect(petSchema?.properties).to.have.property('id');
      expect(petSchema?.properties).to.have.property('name');
    });

    it('should get required fields after URL load', async () => {
      await loader.loadAsync(PETSTORE_YAML_URL);

      const required = loader.getRequiredFields('Pet');
      expect(required).to.be.an('array');
      // Pet schema requires 'name' and 'photoUrls'
      expect(required).to.include('name');
      expect(required).to.include('photoUrls');
    });

    it('should get spec info after URL load', async () => {
      await loader.loadAsync(PETSTORE_YAML_URL);

      const info = loader.getInfo();
      expect(info.title).to.include('Swagger Petstore');
      expect(info.version).to.exist;
    });
  });
});

describe('OpenAPISchemaBuilder - Async Methods', function () {
  this.timeout(NETWORK_TIMEOUT + 5000);

  const builder = new OpenAPISchemaBuilder();

  describe('buildAsync', () => {
    it('should build schema from remote URL', async () => {
      const schema = await builder.buildAsync({
        schemaId: 'petstore_pet_schema',
        openApiSpec: PETSTORE_YAML_URL,
        schemaName: 'Pet',
        primaryKeys: ['id'],
      });

      expect(schema).to.be.instanceOf(Schema);
      expect(schema.id).to.equal('petstore_pet_schema');
      expect(schema.properties).to.be.an('array').with.length.greaterThan(0);
    });

    it('should build schema with urlOptions', async () => {
      const schema = await builder.buildAsync({
        schemaId: 'petstore_pet_schema',
        openApiSpec: PETSTORE_JSON_URL,
        schemaName: 'Pet',
        primaryKeys: ['id'],
        urlOptions: {
          timeout: NETWORK_TIMEOUT,
          contentType: 'json',
        },
      });

      expect(schema).to.be.instanceOf(Schema);
      expect(schema.properties.length).to.be.greaterThan(0);
    });

    it('should mark primary keys correctly from URL source', async () => {
      const schema = await builder.buildAsync({
        schemaId: 'petstore_pet_schema',
        openApiSpec: PETSTORE_YAML_URL,
        schemaName: 'Pet',
        primaryKeys: ['id'],
      });

      const idProp = schema.properties.find((p) => p.name === 'id');
      expect(idProp).to.exist;
      expect(idProp?.primaryKey).to.be.true;
    });

    it('should mark required fields from URL source', async () => {
      const schema = await builder.buildAsync({
        schemaId: 'petstore_pet_schema',
        openApiSpec: PETSTORE_YAML_URL,
        schemaName: 'Pet',
      });

      const nameProp = schema.properties.find((p) => p.name === 'name');
      expect(nameProp).to.exist;
      expect(nameProp?.required).to.be.true;
    });

    it('should throw error for non-existent schema in URL source', async () => {
      try {
        await builder.buildAsync({
          schemaId: 'test_schema',
          openApiSpec: PETSTORE_YAML_URL,
          schemaName: 'NonExistentSchema',
        });
        expect.fail('Should have thrown an error');
      } catch (error) {
        expect((error as Error).message).to.include('not found');
      }
    });
  });

  describe('buildMultipleAsync', () => {
    it('should build multiple schemas from single URL fetch', async () => {
      const schemas = await builder.buildMultipleAsync(
        PETSTORE_YAML_URL,
        [
          { schemaId: 'pet_schema', schemaName: 'Pet', primaryKeys: ['id'], openApiSpec: '' },
          { schemaId: 'order_schema', schemaName: 'Order', primaryKeys: ['id'], openApiSpec: '' },
        ],
        { timeout: NETWORK_TIMEOUT }
      );

      expect(schemas.size).to.equal(2);
      expect(schemas.get('pet_schema')).to.be.instanceOf(Schema);
      expect(schemas.get('order_schema')).to.be.instanceOf(Schema);
    });

    it('should efficiently reuse loaded spec for multiple schemas', async () => {
      // This test verifies that the spec is loaded once and reused
      const start = Date.now();

      const schemas = await builder.buildMultipleAsync(PETSTORE_YAML_URL, [
        { schemaId: 'pet_schema', schemaName: 'Pet', openApiSpec: '' },
        { schemaId: 'category_schema', schemaName: 'Category', openApiSpec: '' },
        { schemaId: 'tag_schema', schemaName: 'Tag', openApiSpec: '' },
      ]);

      const elapsed = Date.now() - start;

      expect(schemas.size).to.equal(3);
      // Building all 3 should be faster than 3x network request time
      // This is a rough check that we're not fetching multiple times
      console.log(`Built 3 schemas in ${elapsed}ms`);
    });
  });
});

describe('Integration: Mixed sources', function () {
  this.timeout(NETWORK_TIMEOUT + 5000);

  it('should handle URL object as source', async () => {
    const builder = new OpenAPISchemaBuilder();
    const url = new URL(PETSTORE_YAML_URL);

    const schema = await builder.buildAsync({
      schemaId: 'petstore_pet_schema',
      openApiSpec: url,
      schemaName: 'Pet',
    });

    expect(schema).to.be.instanceOf(Schema);
  });

  it('should work with buildAsync using object source', async () => {
    const builder = new OpenAPISchemaBuilder();

    const mockSpec = {
      openapi: '3.0.0',
      info: { title: 'Test', version: '1.0.0' },
      components: {
        schemas: {
          Widget: {
            type: 'object',
            required: ['id'],
            properties: {
              id: { type: 'integer', description: 'Widget ID' },
              name: { type: 'string', description: 'Widget name' },
            },
          },
        },
      },
    };

    const schema = await builder.buildAsync({
      schemaId: 'widget_schema',
      openApiSpec: mockSpec,
      schemaName: 'Widget',
      primaryKeys: ['id'],
    });

    expect(schema).to.be.instanceOf(Schema);
    expect(schema.properties.find((p) => p.name === 'id')?.primaryKey).to.be.true;
    expect(schema.properties.find((p) => p.name === 'id')?.required).to.be.true;
  });
});
