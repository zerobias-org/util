import { expect } from "chai";
import jsonata from "jsonata";
import { camelCase, camelCaseAllPropertyNames, snakeCase, snakeCaseAllPropertyNames } from "../../src/index.js";

describe('Common functions test', () => {

  describe('#camelCaseAllPropertyNames', () => {
    it('Should rename all properties to camel case ', async () => {
      const body = {
        'body': {
          'KeyOne': 'value1',
          'key_two': 'value2',
          'Key-Three': 'value3'
        }
      };
      const expression = jsonata(`$~>${camelCaseAllPropertyNames}`);
      expression.registerFunction('camelCase', camelCase, '<s:s>');
      const transformed = await expression.evaluate(body);
      expect(transformed).eql(
        {
          'body': {
            'keyOne': 'value1',
            'keyTwo': 'value2',
            'keyThree': 'value3'
          }
        }
      );
    });
  });

  describe('#removeEmptyStrings', () => {
    it('Should remove all properties with empty string value', () => {

    });
  });

  describe('#snakeCaseAllPropertyNames', () => {
    it('Should rename all properties to snake case', async () => {
      const body = {
        "body": {
          'KeyOne': 'value1',
          'KEY_TWO': 'value2',
          'Key-Three': 'value3'
        }
      };
      const expression = jsonata(`$~>${snakeCaseAllPropertyNames}`);
      expression.registerFunction('snakeCase', snakeCase, '<s:s>');
      const transformed = await expression.evaluate(body);
      expect(transformed).eql(
        {
          'body': {
            'key_one': 'value1',
            'key_two': 'value2',
            'key_three': 'value3'
          }
        }
      );
    });
  });
});

