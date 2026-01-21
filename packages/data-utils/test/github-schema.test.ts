/**
 * Tests for schema builders using GitHub module as test case
 */
import { expect } from 'chai';
import * as path from 'path';
import { Schema, Property, Type } from '@zerobias-org/module-interface-dataproducer';
import {
  OpenAPISchemaBuilder,
  TypeScriptSchemaBuilder,
  OpenAPILoader,
  TypeMapper,
  buildSchema,
} from '../src';

// Import GitHub generated models for TypeScript builder tests
// The published package exports models from dist/generated/model/index.js
import { Repository, Label } from '@auditlogic/module-github-github/dist/generated/model/index.js';

// Path to GitHub module's bundled OpenAPI spec (via node_modules)
// Note: The published package includes module-github-github.yml (bundled spec)
const GITHUB_API_SPEC = path.join(
  __dirname,
  '../node_modules/@auditlogic/module-github-github/module-github-github.yml'
);

describe('TypeMapper', () => {
  describe('mapTypeScriptType', () => {
    it('should map primitive types', () => {
      expect(TypeMapper.mapTypeScriptType('string', '')).to.deep.equal({
        dataType: 'string',
        isMulti: false,
      });

      expect(TypeMapper.mapTypeScriptType('number', '')).to.deep.equal({
        dataType: 'number',
        isMulti: false,
      });

      expect(TypeMapper.mapTypeScriptType('boolean', '')).to.deep.equal({
        dataType: 'boolean',
        isMulti: false,
      });
    });

    it('should map arrays', () => {
      const result = TypeMapper.mapTypeScriptType('Array<string>', '');
      expect(result).to.deep.equal({ dataType: 'string', isMulti: true });
    });

    it('should map nested arrays', () => {
      const result = TypeMapper.mapTypeScriptType('Array<Label>', '');
      expect(result.isMulti).to.be.true;
    });

    it('should map core types from @zerobias-org/types-core-js', () => {
      expect(TypeMapper.mapTypeScriptType('URL', '')).to.deep.equal({
        dataType: 'url',
        isMulti: false,
      });

      expect(TypeMapper.mapTypeScriptType('Email', '')).to.deep.equal({
        dataType: 'email',
        isMulti: false,
      });
    });

    it('should map format hints', () => {
      expect(TypeMapper.mapTypeScriptType('string', 'uri')).to.deep.equal({
        dataType: 'url',
        isMulti: false,
      });

      expect(TypeMapper.mapTypeScriptType('string', 'email')).to.deep.equal({
        dataType: 'email',
        isMulti: false,
      });

      expect(TypeMapper.mapTypeScriptType('string', 'date-time')).to.deep.equal({
        dataType: 'date-time',
        isMulti: false,
      });
    });
  });

  describe('createType', () => {
    it('should create Type object from dataType name', () => {
      const type = TypeMapper.createType('url');

      expect(type).to.be.instanceOf(Type);
      expect(type.name).to.equal('url');
      expect(type.jsonType).to.equal(Type.JsonTypeEnum.String);
      expect(type.htmlInput).to.equal(Type.HtmlInputEnum.Url);
    });

    it('should create Type with correct JSON type mapping', () => {
      const numberType = TypeMapper.createType('number');
      expect(numberType.jsonType).to.equal(Type.JsonTypeEnum.Number);

      const boolType = TypeMapper.createType('boolean');
      expect(boolType.jsonType).to.equal(Type.JsonTypeEnum.Boolean);
    });
  });

  describe('collectTypes', () => {
    it('should collect unique types', () => {
      const types = TypeMapper.collectTypes(['string', 'number', 'string', 'url']);

      expect(types).to.have.length(3);
      expect(types.map((t) => t.name)).to.include.members(['string', 'number', 'url']);
    });
  });
});

describe('OpenAPILoader', () => {
  let loader: OpenAPILoader;

  beforeEach(() => {
    loader = new OpenAPILoader();
  });

  it('should load OpenAPI spec from file path', () => {
    loader.loadSync(GITHUB_API_SPEC);

    expect(loader.isLoaded()).to.be.true;
    expect(loader.getSchemaNames()).to.be.an('array').with.length.greaterThan(0);
  });

  it('should get schema by name', () => {
    loader.loadSync(GITHUB_API_SPEC);

    const repoSchema = loader.getSchema('Repository');
    expect(repoSchema).to.exist;
    expect(repoSchema?.properties).to.exist;
  });

  it('should get required fields', () => {
    loader.loadSync(GITHUB_API_SPEC);

    const required = loader.getRequiredFields('Repository');
    expect(required).to.be.an('array');
  });

  it('should get property descriptions', () => {
    loader.loadSync(GITHUB_API_SPEC);

    const descriptions = loader.getPropertyDescriptions('Repository', true);
    expect(descriptions).to.be.an('object');
  });

  it('should convert snake_case to camelCase in descriptions', () => {
    loader.loadSync(GITHUB_API_SPEC);

    const descriptions = loader.getPropertyDescriptions('Repository', true);

    // Check that keys are in camelCase (no underscores)
    for (const key of Object.keys(descriptions)) {
      if (key.length > 1) {
        expect(key.includes('_')).to.be.false;
      }
    }
  });
});

describe('OpenAPISchemaBuilder', () => {
  const builder = new OpenAPISchemaBuilder();

  it('should build Repository schema from OpenAPI spec', () => {
    const schema = builder.build({
      schemaId: 'github_repository_schema',
      openApiSpec: GITHUB_API_SPEC,
      schemaName: 'Repository',
      primaryKeys: ['id'],
    });

    expect(schema).to.be.instanceOf(Schema);
    expect(schema.id).to.equal('github_repository_schema');
    expect(schema.properties).to.be.an('array').with.length.greaterThan(0);
    expect(schema.dataTypes).to.be.an('array').with.length.greaterThan(0);
  });

  it('should mark primary keys correctly', () => {
    const schema = builder.build({
      schemaId: 'github_repository_schema',
      openApiSpec: GITHUB_API_SPEC,
      schemaName: 'Repository',
      primaryKeys: ['id'],
    });

    const idProp = schema.properties.find((p) => p.name === 'id');
    expect(idProp).to.exist;
    expect(idProp?.primaryKey).to.be.true;
  });

  it('should handle references configuration', () => {
    const schema = builder.build({
      schemaId: 'github_repository_schema',
      openApiSpec: GITHUB_API_SPEC,
      schemaName: 'Repository',
      primaryKeys: ['id'],
      references: {
        owner: { schemaId: 'github_user_schema' },
      },
    });

    const ownerProp = schema.properties.find((p) => p.name === 'owner');
    expect(ownerProp).to.exist;
    expect(ownerProp?.references?.schemaId).to.equal('github_user_schema');
  });

  it('should throw error for missing schema', () => {
    expect(() =>
      builder.build({
        schemaId: 'test_schema',
        openApiSpec: GITHUB_API_SPEC,
        schemaName: 'NonExistentSchema',
      })
    ).to.throw(/not found in OpenAPI spec/);
  });
});

describe('TypeScriptSchemaBuilder', () => {
  const builder = new TypeScriptSchemaBuilder();

  it('should build schema from TypeScript class with attributeTypeMap', () => {
    // Verify the model class has attributeTypeMap
    expect(Label.attributeTypeMap).to.be.an('array');

    const schema = builder.build({
      schemaId: 'github_label_schema',
      modelClass: Label,
      primaryKeys: ['id'],
    });

    expect(schema).to.be.instanceOf(Schema);
    expect(schema.id).to.equal('github_label_schema');
    expect(schema.properties).to.be.an('array').with.length.greaterThan(0);
  });

  it('should enrich with OpenAPI descriptions when spec is provided', () => {
    const schema = builder.build({
      schemaId: 'github_label_schema',
      modelClass: Label,
      primaryKeys: ['id'],
      openApiSpec: GITHUB_API_SPEC,
      openApiSchemaName: 'Label',
    });

    // Some properties should have descriptions from OpenAPI
    const descriptionCount = schema.properties.filter((p) => p.description).length;
    expect(descriptionCount).to.be.greaterThan(0);
  });

  it('should handle Repository model', () => {
    const schema = builder.build({
      schemaId: 'github_repository_schema',
      modelClass: Repository,
      primaryKeys: ['id'],
    });

    expect(schema.id).to.equal('github_repository_schema');
    expect(schema.properties).to.be.an('array');

    // Check specific properties exist
    const propertyNames = schema.properties.map((p) => p.name);
    expect(propertyNames).to.include('id');
    expect(propertyNames).to.include('name');
    expect(propertyNames).to.include('fullName');
  });

  it('should handle references correctly', () => {
    const schema = builder.build({
      schemaId: 'github_repository_schema',
      modelClass: Repository,
      primaryKeys: ['id'],
      references: {
        owner: { schemaId: 'github_user_schema' },
        license: { schemaId: 'github_license_schema' },
      },
    });

    const ownerProp = schema.properties.find((p) => p.name === 'owner');
    expect(ownerProp?.references?.schemaId).to.equal('github_user_schema');

    const licenseProp = schema.properties.find((p) => p.name === 'license');
    expect(licenseProp?.references?.schemaId).to.equal('github_license_schema');
  });

  it('should mark multi-valued properties correctly', () => {
    const schema = builder.build({
      schemaId: 'github_repository_schema',
      modelClass: Repository,
      primaryKeys: ['id'],
    });

    // Repository has topics which is an array
    const topicsProp = schema.properties.find((p) => p.name === 'topics');
    if (topicsProp) {
      expect(topicsProp.multi).to.be.true;
    }
  });
});

describe('buildSchema convenience function', () => {
  it('should build schema using the convenience function', () => {
    const schema = buildSchema(Label, {
      schemaId: 'github_label_schema',
      primaryKeys: ['id'],
    });

    expect(schema).to.be.instanceOf(Schema);
    expect(schema.id).to.equal('github_label_schema');
  });
});

describe('Integration: Multiple schemas from same spec', () => {
  it('should build multiple schemas efficiently using buildMultiple', () => {
    const builder = new OpenAPISchemaBuilder();

    const schemas = builder.buildMultiple(GITHUB_API_SPEC, [
      { schemaId: 'github_repository_schema', schemaName: 'Repository', primaryKeys: ['id'], openApiSpec: GITHUB_API_SPEC },
      { schemaId: 'github_label_schema', schemaName: 'Label', primaryKeys: ['id'], openApiSpec: GITHUB_API_SPEC },
    ]);

    expect(schemas.size).to.equal(2);
    expect(schemas.get('github_repository_schema')).to.be.instanceOf(Schema);
    expect(schemas.get('github_label_schema')).to.be.instanceOf(Schema);
  });
});
