import { AwsRegion, AwsRegionDef } from '@zerobias-org/types-amazon-js';
import {
  CloudRegion,
  CloudRegionDef,
  EnumValue,
  InvalidInputError,
  UnexpectedError
} from '@zerobias-org/types-core-js';
import { AzureRegion, AzureRegionDef } from '@zerobias-org/types-microsoft-js';
import CLOUD_REGIONS from '@zerobias-org/types-core/data/cloud/cloudRegions.json' with { type: 'json' };
import { snakeCase } from './CommonFunctions.js';

/**
 * If `value` is not `undefined`, returns a new instance of `Type` with the value of `value`.
 * @param OutputType The class to instantiate.
 * @param value The value to instantiate with.
 * @param defaultResponse The value to return when value is `undefined`. Default: `undefined`.
 */
export function map<I, O>(
  OutputType: { new(arg: I): O; },
  value: I,
  defaultResponse?: O
): O;
export function map<I, O>(
  OutputType: { new(arg: I): O; },
  value: I | undefined,
  defaultResponse: O
): O;
export function map<I, O>(
  OutputType: { new(arg: I): O; },
  value: I | undefined,
  defaultResponse?: O
): O | undefined;
export function map<I, O>(
  OutputType: { new(arg: I): O; },
  value?: I,
  defaultResponse: O | undefined = undefined
): O | undefined {
  return value ? new OutputType(value) : defaultResponse;
}

/**
 * Transforms the input and returns the enum value matching the result.
 * @param Enum The enum to convert to.
 * @param value The string value for the enum.
 * @param transformFunction Override transform function. The default transform function is `snakeCase`.
 * @returns The enum value that matches the transformed input value.
  */
export function toEnum<T extends { from: (val: string | number) => EnumValue; }>(
  Enum: T,
  value: string,
  transformFunction?: (arg: string) => string
): EnumValue;
export function toEnum<T extends { from: (val: string | number) => EnumValue; }>(
  Enum: T,
  value?: string,
  transformFunction?: (arg: string) => string
): EnumValue | undefined;
export function toEnum<T extends {
  from: (
    val: string | number
  ) => EnumValue;
}>(
  Enum: T,
  value?: string,
  transformFunction: (arg: string) => string = snakeCase
): EnumValue | undefined {
  return value ? Enum.from(transformFunction(value)) : undefined;
}

/**
 * Runs the mapper function on each defined value in the data array and returns
 * the result array with all the undefined values filtered out, or returns
 * a custom result or undefined if the data is undefined.
 * @param data The input array to run the mapper function on.
 * @param mapper The mapper function that will run on each defined value of data.
 * @param defaultResponse A custom result that can be returned if the result array is undefined. The default is `undefined`.
 */
export function mapArray<I, O>(
  mapper: (input: I) => O,
  data: I[] | (I | undefined)[],
  defaultResponse?: O[]
): O[];
export function mapArray<I, O>(
  mapper: (input: I) => O,
  data: I[] | (I | undefined)[] | undefined,
  defaultResponse: O[]
): O[];
export function mapArray<I, O>(
  mapper: (input: I) => O,
  data?: I[] | (I | undefined)[],
  defaultResponse?: O[]
): O[] | undefined;
export function mapArray<I, O>(
  mapper: (input: I) => O,
  data?: I[] | (I | undefined)[],
  defaultResponse: O[] | undefined = undefined
): O[] | undefined {
  if (!data) {
    return defaultResponse;
  }
  if (!Array.isArray(data)) {
    throw new UnexpectedError(`Expected array, but got ${typeof data}`);
  }
  const collector: O[] = [];
  data.forEach((elem) => {
    if (elem !== undefined) {
      collector.push(mapper(elem));
    }
  });
  return collector;
}

export function toCloudRegion(
  provider: CloudRegionDef,
  region: AwsRegionDef | AzureRegionDef | string
): CloudRegionDef {
  const cloudRegionData = CLOUD_REGIONS.find(
    (reg) => reg.providerCode === region.toString() && reg.provider === provider.toString()
  );

  const cloudRegion = toEnum(CloudRegion, cloudRegionData?.code);

  if (!cloudRegion) {
    throw new InvalidInputError('cloudRegion', snakeCase(`${provider}_${region.toString()}`));
  }

  return cloudRegion;
}

export function fromCloudRegion(
  cloudRegion: CloudRegionDef,
  provider: 'aws'
): AwsRegionDef;
export function fromCloudRegion(
  cloudRegion: CloudRegionDef,
  provider: 'azure'
): AzureRegionDef;
export function fromCloudRegion(
  cloudRegion: CloudRegionDef,
  provider?: 'aws' | 'azure'
): AwsRegionDef | AzureRegionDef;
export function fromCloudRegion(
  cloudRegion: CloudRegionDef,
  provider?: 'aws' | 'azure'
): AwsRegionDef | AzureRegionDef {
  const cloudRegionData = CLOUD_REGIONS.find((reg) => reg.code === cloudRegion.toString());

  if (!cloudRegionData || !cloudRegionData.code) {
    throw new InvalidInputError('cloudRegion', cloudRegion.toString());
  }

  if (!!provider && (provider !== cloudRegionData.provider)) {
    throw new InvalidInputError(`${provider} cloudRegion`, cloudRegion.toString());
  }

  let enumType: typeof AwsRegion | typeof AzureRegion;

  switch (cloudRegionData.provider) {
    case 'aws': enumType = AwsRegion; break;
    case 'azure': enumType = AzureRegion; break;
    default: throw new InvalidInputError('cloudRegion provider', cloudRegionData.provider);
  }

  return toEnum(enumType, cloudRegionData.providerCode, (str) => str);
}
