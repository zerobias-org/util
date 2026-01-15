import { expect } from 'chai';
import { camelCase, convertBooleans, convertNumbers, getAttributes, getBasicAuthHeader, pascalCase, snakeCase } from "../../src";

describe('Common functions test', () => {

  describe('#camelCase', () => {
    it('Should transform to camel case', () => {
      expect(camelCase('to_camel_case')).eql('toCamelCase');
      expect(camelCase('to camel case')).eql('toCamelCase');
      expect(camelCase('To camelCase')).eql('toCamelCase');
      expect(camelCase('ToCamelCase')).eql('toCamelCase');
      expect(camelCase('To_Camel_Case')).eql('toCamelCase');
      expect(camelCase('To-Camel-Case')).eql('toCamelCase');
      expect(camelCase('to-camel-case')).eql('toCamelCase');
      expect(camelCase('toCamelCase')).eql('toCamelCase');
    });
  });

  describe('#pascalCase', () => {
    it('Should transform to pascal case', () => {
      expect(pascalCase('to_pascal_case')).eql('ToPascalCase');
      expect(pascalCase('to pascal case')).eql('ToPascalCase');
      expect(pascalCase('To pascalCase')).eql('ToPascalCase');
      expect(pascalCase('ToPascalCase')).eql('ToPascalCase');
      expect(pascalCase('To_Pascal_Case')).eql('ToPascalCase');
      expect(pascalCase('To-Pascal-Case')).eql('ToPascalCase');
      expect(pascalCase('to-pascal-case')).eql('ToPascalCase');
      expect(pascalCase('toPascalCase')).eql('ToPascalCase');
    });
  });

  describe('#pascalCase', () => {
    it('Should transform to snake case', () => {
      expect(snakeCase('to_snake_case')).eql('to_snake_case');
      expect(snakeCase('to snake case')).eql('to_snake_case');
      expect(snakeCase('To snakeCase')).eql('to_snake_case');
      expect(snakeCase('ToSnakeCase')).eql('to_snake_case');
      expect(snakeCase('To_Snake_Case')).eql('to_snake_case');
      expect(snakeCase('To-Snake-Case')).eql('to_snake_case');
      expect(snakeCase('to-snake-case')).eql('to_snake_case');
      expect(snakeCase('toSnakeCase')).eql('to_snake_case');
    });
  });

  const modelsPath = 'node_modules/@zerobias-org/types-core-js/dist/generated/model';

  describe('#getAttributes', () => {
    it('Should get attributes', () => {
      const numberAttributes = getAttributes('UnexpectedError', 'number', modelsPath);
      const stringAttributes = getAttributes('UnexpectedError', 'string', modelsPath);
      const booleanAttributes = getAttributes('Type', 'boolean', modelsPath);
      expect(numberAttributes).eql(['statusCode']);
      expect(stringAttributes).eql(['key', 'template', 'msg', 'stack']);
      expect(booleanAttributes).eql(['isEnum']);
    });
  });


  describe('#convertBooleans', () => {
    it('Should convert booleans', () => {
      const body = {
        "key1": "value1",
        "isEnum": "false"
      };
      const converted = convertBooleans(body, 'Type', modelsPath);
      expect(converted).eql({
        "key1": "value1",
        "isEnum": false
      });

    });
  });

  describe('#convertNumbers', () => {
    it('Should convert numbers', () => {
      const body = {
        "key1": "value1",
        "statusCode": "500"
      };
      const converted = convertNumbers(body, 'UnexpectedError', modelsPath);
      expect(converted).eql({
        "key1": "value1",
        "statusCode": 500
      });

    });
  });

  it('Should create basic atuh header', () => {
    const header = getBasicAuthHeader('username', 'password');
    expect(header).eql('Basic dXNlcm5hbWU6cGFzc3dvcmQ=');
  });
});

