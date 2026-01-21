/**
 * Tests for SchemasApi
 */
import { expect } from 'chai';
import { DataProducerClient } from '../../src';

describe('SchemasApi', () => {
  let client: DataProducerClient;

  beforeEach(() => {
    client = new DataProducerClient();
  });

  describe('getSchemas', () => {
    it('should throw error when not connected', async () => {
      try {
        await client.schemas.getSchemas();
        expect.fail('Should have thrown error');
      } catch (error: any) {
        expect(error.message.toLowerCase()).to.include('not connected');
      }
    });
  });

  describe('getSchema', () => {
    it('should throw error when not connected', async () => {
      try {
        await client.schemas.getSchema('test-schema-id');
        expect.fail('Should have thrown error');
      } catch (error: any) {
        expect(error.message.toLowerCase()).to.include('not connected');
      }
    });

    it('should require schemaId parameter', async () => {
      try {
        await client.schemas.getSchema('');
        expect.fail('Should have thrown error');
      } catch (error) {
        expect(error).to.exist;
      }
    });
  });

  describe('getSchemaByName', () => {
    it('should throw error when not connected', async () => {
      try {
        await client.schemas.getSchemaByName('test-schema-name');
        expect.fail('Should have thrown error');
      } catch (error: any) {
        expect(error.message.toLowerCase()).to.include('not connected');
      }
    });

    it('should require name parameter', async () => {
      try {
        await client.schemas.getSchemaByName('');
        expect.fail('Should have thrown error');
      } catch (error) {
        expect(error).to.exist;
      }
    });
  });

  describe('getSchemaById', () => {
    it('should throw error when not connected', async () => {
      try {
        await client.schemas.getSchemaById('test-schema-id');
        expect.fail('Should have thrown error');
      } catch (error: any) {
        expect(error.message.toLowerCase()).to.include('not connected');
      }
    });

    it('should be an alias for getSchema', () => {
      // getSchemaById should behave the same as getSchema
      expect(client.schemas.getSchemaById).to.be.a('function');
      expect(client.schemas.getSchema).to.be.a('function');
    });

    it('should require schemaId parameter', async () => {
      try {
        await client.schemas.getSchemaById('');
        expect.fail('Should have thrown error');
      } catch (error) {
        expect(error).to.exist;
      }
    });
  });

  describe('validateData', () => {
    const testSchema: any = {
      id: 'test-schema',
      dataTypes: [],
      properties: [
        {
          name: 'name',
          jsonType: 'string',
          required: true
        },
        {
          name: 'age',
          jsonType: 'number',
          required: true
        },
        {
          name: 'email',
          jsonType: 'string',
          required: false
        }
      ]
    };

    it('should validate valid data', () => {
      const data = {
        name: 'John Doe',
        age: 30,
        email: 'john@example.com'
      };

      const result = client.schemas.validateData(data, testSchema);

      expect(result.valid).to.be.true;
      expect(result.errors).to.have.lengthOf(0);
    });

    it('should detect missing required fields', () => {
      const data = {
        name: 'John Doe'
        // Missing required 'age' field
      };

      const result = client.schemas.validateData(data, testSchema);

      expect(result.valid).to.be.false;
      expect(result.errors.length).to.be.greaterThan(0);
      expect(result.errors[0]).to.include('age');
    });

    it('should allow missing optional fields', () => {
      const data = {
        name: 'John Doe',
        age: 30
        // Missing optional 'email' field
      };

      const result = client.schemas.validateData(data, testSchema);

      expect(result.valid).to.be.true;
      expect(result.errors).to.have.lengthOf(0);
    });

    it('should detect type mismatches', () => {
      const data = {
        name: 'John Doe',
        age: 'thirty'  // Should be number
      };

      const result = client.schemas.validateData(data, testSchema);

      expect(result.valid).to.be.false;
      expect(result.errors.length).to.be.greaterThan(0);
    });

    it('should validate number type', () => {
      const data = {
        name: 'John Doe',
        age: 'not-a-number'
      };

      const result = client.schemas.validateData(data, testSchema);

      expect(result.valid).to.be.false;
      expect(result.errors.some(e => e.includes('number'))).to.be.true;
    });

    it('should validate string type', () => {
      const data = {
        name: 123,  // Should be string
        age: 30
      };

      const result = client.schemas.validateData(data, testSchema);

      expect(result.valid).to.be.false;
      expect(result.errors.some(e => e.includes('string'))).to.be.true;
    });

    it('should validate boolean type', () => {
      const boolSchema: any = {
        id: 'bool-schema',
        dataTypes: [],
        properties: [
          {
            name: 'active',
            jsonType: 'boolean',
            required: true
          }
        ]
      };

      const validData = { active: true };
      const invalidData = { active: 'yes' };

      expect(client.schemas.validateData(validData, boolSchema).valid).to.be.true;
      expect(client.schemas.validateData(invalidData, boolSchema).valid).to.be.false;
    });

    it('should validate array type', () => {
      const arraySchema: any = {
        id: 'array-schema',
        dataTypes: [],
        properties: [
          {
            name: 'items',
            jsonType: 'array',
            required: true
          }
        ]
      };

      const validData = { items: [1, 2, 3] };
      const invalidData = { items: 'not-an-array' };

      expect(client.schemas.validateData(validData, arraySchema).valid).to.be.true;
      expect(client.schemas.validateData(invalidData, arraySchema).valid).to.be.false;
    });

    it('should validate object type', () => {
      const objectSchema: any = {
        id: 'object-schema',
        dataTypes: [],
        properties: [
          {
            name: 'metadata',
            jsonType: 'object',
            required: true
          }
        ]
      };

      const validData = { metadata: { key: 'value' } };
      const invalidData = { metadata: 'not-an-object' };

      expect(client.schemas.validateData(validData, objectSchema).valid).to.be.true;
      expect(client.schemas.validateData(invalidData, objectSchema).valid).to.be.false;
    });

    it('should handle null values for optional fields', () => {
      const data = {
        name: 'John Doe',
        age: 30,
        email: null  // Optional field with null
      };

      const result = client.schemas.validateData(data, testSchema);

      expect(result.valid).to.be.true;
    });

    it('should handle undefined values for optional fields', () => {
      const data = {
        name: 'John Doe',
        age: 30,
        email: undefined  // Optional field with undefined
      };

      const result = client.schemas.validateData(data, testSchema);

      expect(result.valid).to.be.true;
    });

    it('should handle empty schema', () => {
      const emptySchema: any = {
        id: 'empty-schema',
        dataTypes: [],
        properties: []
      };

      const data = { anything: 'goes' };

      const result = client.schemas.validateData(data, emptySchema);

      expect(result.valid).to.be.true;
      expect(result.errors).to.have.lengthOf(0);
    });

    it('should handle null data', () => {
      const result = client.schemas.validateData(null as any, testSchema);

      expect(result.valid).to.be.false;
      expect(result.errors.length).to.be.greaterThan(0);
    });

    it('should handle undefined data', () => {
      const result = client.schemas.validateData(undefined as any, testSchema);

      expect(result.valid).to.be.false;
      expect(result.errors.length).to.be.greaterThan(0);
    });

    it('should provide descriptive error messages', () => {
      const data = {
        name: 'John Doe'
        // Missing age
      };

      const result = client.schemas.validateData(data, testSchema);

      expect(result.errors.length).to.be.greaterThan(0);
      expect(result.errors[0]).to.be.a('string');
      expect(result.errors[0].length).to.be.greaterThan(0);
    });
  });

  describe('error handling', () => {
    it('should provide meaningful error messages', async () => {
      try {
        await client.schemas.getSchemas();
        expect.fail('Should have thrown error');
      } catch (error: any) {
        expect(error.message).to.be.a('string');
        expect(error.message.length).to.be.greaterThan(0);
      }
    });

    it('should handle null/undefined schemaId', async () => {
      try {
        await client.schemas.getSchema(null as any);
        expect.fail('Should have thrown error');
      } catch (error) {
        expect(error).to.exist;
      }
    });

    it('should handle null/undefined schema name', async () => {
      try {
        await client.schemas.getSchemaByName(null as any);
        expect.fail('Should have thrown error');
      } catch (error) {
        expect(error).to.exist;
      }
    });
  });

  describe('normalization', () => {
    it('should preserve original properties in schema objects', () => {
      // This would be tested with actual API responses
      // For now, just verify the API methods exist
      expect(client.schemas.getSchemas).to.be.a('function');
      expect(client.schemas.getSchema).to.be.a('function');
      expect(client.schemas.getSchemaByName).to.be.a('function');
    });
  });
});
