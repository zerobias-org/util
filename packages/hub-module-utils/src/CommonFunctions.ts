import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { UnexpectedError } from '@zerobias-org/types-core-js';
import jsonata from 'jsonata';
export { snakeCase, camelCase, pascalCase } from 'change-case';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
// When running from src: go up 3 levels to monorepo root
// When running from dist/src: go up 4 levels to monorepo root
const parentModulePath = __dirname.includes('/dist/')
  ? resolve(__dirname, '..', '..', '..', '..')
  : resolve(__dirname, '..', '..', '..');
/**
 * Creates a Basic Authentication header value out of given username and password.
 * @returns Authentication header
 */
export function getBasicAuthHeader(username?: string, password?: string): string {
  if (!username || !password) {
    throw new UnexpectedError('Missing username or password');
  }
  const authToken = Buffer.from(`${username}:${password}`);
  return `Basic ${authToken.toString('base64')}`;
}

/**
 * Returns a list of all attributes of specified type in the specified model.
 * @param modelName The name of the model.
 * @param type The type of the attributes to return.
 * @param modelPath Optional: Override the model path
 * @returns An array of attribute names.
 */
export async function getAttributes(
  modelName: string,
  type: string,
  modelPath?: string
): Promise<string[]> {
  const basePath = modelPath || resolve(parentModulePath, 'generated/model');
  const resolvedPath = resolve(parentModulePath, basePath);
  const module = await import(resolvedPath);
  const model = module[modelName];
  return model.getAttributeTypeMap().filter((t: { type: string }) => t.type === type).map((t: { name: string }) => t.name);
}

/**
 * Converts to type `number` all `body`'s properties defined as number in the specified model.
 * @param body Input body.
 * @param modelName The name of the model.
 * @param modelPath Optional: Override the model path.
 * @returns The value of the input with converted number values.
 */
export async function convertNumbers<BodyType>(
  body: BodyType,
  modelName: string,
  modelPath?: string
): Promise<BodyType> {
  const path = modelPath ? `,"${modelPath}"` : '';
  const expression = jsonata(`
  $~>|$.**[$type($)="object"]
  |(
    $nums:=$.$sift(function($v,$k){$k in $getAttributes("${modelName}","number"${path})});
    $k := $nums.$keys();
    $merge($k.{$:$number($lookup($nums,$))})
  )|`);
  expression.registerFunction(
    'getAttributes',
    getAttributes,
    '<sss?>:a<s>>'
  );
  return expression.evaluate(body);
}

/**
 * Converts to type `boolean` all `body`'s properties defined as boolean in the specified model.
 * @param body Input body.
 * @param modelName The name of the model.
 * @param modelPath Optional: Override the model path.
 * @returns The value of the input with converted number values.
 */
export async function convertBooleans<BodyType>(
  body: BodyType,
  modelName: string,
  modelPath?: string
): Promise<BodyType> {
  const path = modelPath ? `,"${modelPath}"` : '';
  const expression = jsonata(`
  $~>|$.**[$type($)="object"]
  |(
    $bools:=$.$sift(function($v,$k){$k in $getAttributes("${modelName}","boolean"${path})});
    $k := $bools.$keys();
    $merge($k.{$:$lookup($bools,$)="true"?true:$lookup($bools,$)="false"?false:null})
  )|`);
  expression.registerFunction(
    'getAttributes',
    getAttributes,
    '<sss?:a<s>>'
  );
  return expression.evaluate(body);
}
