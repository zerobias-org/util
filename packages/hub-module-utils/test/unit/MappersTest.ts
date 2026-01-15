import { AwsRegion } from '@zerobias-org/types-amazon-js';
import { CloudProvider, CloudRegion, EnumValue, IllegalArgumentError, InvalidInputError, UnexpectedError, UUID } from '@zerobias-org/types-core-js';
import { AzureRegion } from '@zerobias-org/types-microsoft-js';
import { expect } from 'chai';
import { Enum, EnumDef } from '../../generated/model';
import { fromCloudRegion, map, mapArray, toCloudRegion, toEnum } from '../../src';

describe('Mappers test', () => {
  describe('#map', () => {
    it('Should map a UUID', () => {
      const uuidValue = '68375558-cf56-4e17-a278-b09ac49e5283';
      const uuid = map(UUID, uuidValue);
      expect(uuid).to.be.instanceOf(UUID);
      expect(uuid?.toString()).to.be.eql(uuidValue);
    });

    it('Should fail to map UUID', () => {
      try {
        map(UUID, 'invalidUUID');
      } catch (err) {
        expect(err).to.be.instanceOf(InvalidInputError);
        return;
      }
      expect.fail('expected error not thrown');
    });

    it('Should map a Date', () => {
      const date = map(Date, '2020-01-01');
      expect(date).to.be.instanceOf(Date);
      expect(date).to.be.eql(new Date('2020-01-01'));
    });

    it('Should return undefined', () => {
      const uuid = map(UUID, undefined);
      expect(uuid).to.be.undefined;
    });

    it('Should return default value when input is undefined', () => {
      const dflt = new Date('2020-01-02');
      const date = map(Date, undefined, dflt);
      expect(date).to.be.eql(dflt);
    });

    it('Should map Date with Date input', () => {
      const dateInput = new Date();
      const date = map(Date, dateInput);
      expect(date).eql(dateInput);
    });
  });

  describe('#toEnum', () => {
    it('Should map a snake case enum', () => {
      const enumValue: EnumDef = toEnum(Enum, 'val1');
      expect(enumValue).to.be.eql(Enum.Val1);
      expect(enumValue).instanceOf(EnumValue);
    });

    it('Should map non snake case enum', () => {
      const enumValue: EnumDef = toEnum(Enum, 'VAL2');
      expect(enumValue).to.be.eql(Enum.Val2);
      expect(enumValue).instanceOf(EnumValue);
    });

    it('Should throw error for invalid enum value', () => {
      try {
        toEnum(Enum, 'NON-SnakeCase');
      } catch (err) {
        expect(err).instanceOf(IllegalArgumentError);
        expect(err).to.have.property('msg', 'non_snake_case is not a valid Enum');
      }
    });

    it('Should map an enum overriding transform function', () => {
      const enumValue: EnumDef = toEnum(Enum, 'NON-SnakeCase', (str) => str);
      expect(enumValue).to.be.eql(Enum.NonSnakeCase);
      expect(enumValue).instanceOf(EnumValue);
    });

  });

  describe('#mapArray', () => {
    const dummyMapper = (val: number): string => val.toString();

    const expectStringArray = (arr: unknown) => {
      (arr as string[]).forEach((val) => expect(val).to.be.a('string'));
    };

    it('should throw because data is not an array', () => {
      const dummyArray = JSON.parse('{}');
      try {
        mapArray(dummyMapper, dummyArray);
        expect.fail('expected error not thrown');
      } catch (err) {
        expect(err).instanceOf(UnexpectedError);
      }
    });

    it('Should map mixed content array to return only defined string values', () => {
      const dummyArray = [2, undefined, 3, 5, undefined];
      const mappedArray = mapArray(dummyMapper, dummyArray);
      expect(mappedArray.length).to.equal(3);
      expectStringArray(mappedArray);
    });

    it('should return an empty array', () => {
      const dummyArray = [];
      const mappedArray = mapArray(dummyMapper, dummyArray);
      expect(mappedArray.length).to.equal(0);
      expectStringArray(mappedArray);
    });

    it('should return an empty array as custom default value', () => {
      const dummyArray = undefined;
      const mappedArray = mapArray(dummyMapper, dummyArray, []);
      expect(mappedArray.length).to.equal(0);
      expectStringArray(mappedArray);
    });

    it('should return undefined with no custom default value', () => {
      const dummyArray = undefined;
      const mappedArray = mapArray(dummyMapper, dummyArray);
      expect(mappedArray).to.be.undefined;
    });

    it('should correctly map fully defined array with correct types', () => {
      const dummyArray = [1, 2, 3, 4];
      const mappedArray = mapArray(dummyMapper, dummyArray);
      expect(mappedArray.length).to.equal(4);
      expectStringArray(mappedArray);
    });

    it('should return empty array from array of undefined', () => {
      const dummyArray = [undefined, undefined, undefined];
      const mappedArray = mapArray(dummyMapper, dummyArray);
      expect(mappedArray.length).to.equal(0);
      expectStringArray(mappedArray);
    });
  });

  describe('#toCloudRegion', () => {
    it('should map an awsRegion to cloudRegion', () => {
      const cr = toCloudRegion(CloudProvider.Aws, AwsRegion.UsEast2);
      expect(cr).eq(CloudRegion.AwsUsEast2);
    });

    it('should map an azureRegion to cloudRegion', () => {
      const cr = toCloudRegion(CloudProvider.Azure, AzureRegion.Centralus);
      expect(cr).eq(CloudRegion.AzureCentralus);
    });

    it('should map an aws region string to cloudRegion', () => {
      const cr = toCloudRegion(CloudProvider.Aws, 'us-east-2');
      expect(cr).eq(CloudRegion.AwsUsEast2);
    });

    it('should map an azure region string to cloudRegion', () => {
      const cr = toCloudRegion(CloudProvider.Azure, 'centralus');
      expect(cr).eq(CloudRegion.AzureCentralus);
    });

    it('should fail to map an invalid region string to cloudRegion', () => {
      try {
        toCloudRegion(CloudProvider.Aws, 'invalid-region');
      } catch (err) {
        expect(err).instanceOf(InvalidInputError);
      }
    });

    it('should throw an error when provider does not match', () => {
      try {
        toCloudRegion(CloudProvider.Aws, AzureRegion.Centralus);
      } catch (err) {
        expect(err).instanceOf(InvalidInputError);
        return;
      }
      expect.fail('Expected error not thrown');
    });
  });

  describe('#fromCloudRegion', () => {
    it('should map a cloudRegion to an awsRegion', () => {
      const region = fromCloudRegion(CloudRegion.AwsUsWest1, 'aws');
      expect(region).eql(AwsRegion.UsWest1);
    });

    it('should map a cloudRegion to an azureRegion', () => {
      const region = fromCloudRegion(CloudRegion.AzureSouthcentralus, 'azure');
      expect(region).eql(AzureRegion.Southcentralus);
    });

    it('should map a cloudRegion to an awsRegion without specifiying the provider', () => {
      const region = fromCloudRegion(CloudRegion.AwsUsWest1);
      expect(region).eql(AwsRegion.UsWest1);
    });

    it('should map a cloudRegion to an azureRegion without specifiying the provider', () => {
      const region = fromCloudRegion(CloudRegion.AzureSouthcentralus);
      expect(region).eql(AzureRegion.Southcentralus);
    });

    it('should throw an error with a wrong specified provider', () => {
      try {
        fromCloudRegion(CloudRegion.AwsUsWest1, 'azure');
      } catch (err) {
        expect(err).instanceOf(InvalidInputError);
      }
    });
  });
});
