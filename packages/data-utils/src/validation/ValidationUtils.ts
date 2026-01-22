/**
 * ValidationUtils - Response validation utilities for DataProducer implementations
 *
 * Provides runtime validation to prevent crashes when APIs return unexpected formats.
 * All validation functions use TypeScript's 'asserts' syntax to provide type narrowing.
 *
 * @example
 * ```typescript
 * import { validatePagedResult, validateFound } from '@zerobias-org/data-utils';
 *
 * const repos = await api.listRepositories();
 * validatePagedResult(repos, 'listRepositories');
 * // Now TypeScript knows repos.items is an array
 *
 * const repo = repos.items.find(r => r.name === 'my-repo');
 * validateFound(repo, 'findRepository', `name=my-repo`);
 * // Now TypeScript knows repo is defined
 * ```
 */

/**
 * Validates that a value is a non-null array
 *
 * @param value - The value to validate
 * @param context - Context for error message (e.g., function name)
 * @throws Error with descriptive message if validation fails
 *
 * @example
 * ```typescript
 * validateArray(response.items, 'getPullRequestsCollection');
 * // Now TypeScript knows response.items is an array
 * ```
 */
export function validateArray<T>(
  value: unknown,
  context: string
): asserts value is T[] {
  if (value === null || value === undefined) {
    throw new Error(`${context}: Expected array, received ${value}`);
  }

  if (!Array.isArray(value)) {
    throw new TypeError(
      `${context}: Expected array, received ${typeof value}. ` +
      `This may indicate an API format change.`
    );
  }
}

/**
 * Validates a paged result object has the required structure with an items array
 *
 * @param result - The paged result object to validate
 * @param context - Context for error message (e.g., function name)
 * @throws Error with descriptive message if validation fails
 *
 * @example
 * ```typescript
 * const prs = await github.getRepoApi().listPullRequests(...);
 * validatePagedResult(prs, 'getPullRequestsCollection');
 * // Now safe to access prs.items
 * ```
 */
export function validatePagedResult<T>(
  result: unknown,
  context: string
): asserts result is { items: T[]; count?: number } {
  if (result === null || result === undefined) {
    throw new Error(`${context}: Response is null or undefined`);
  }

  if (typeof result !== 'object') {
    throw new TypeError(`${context}: Expected object, received ${typeof result}`);
  }

  const typedResult = result as { items?: unknown };

  if (!('items' in typedResult)) {
    throw new Error(
      `${context}: Response missing 'items' field. ` +
      `Available fields: ${Object.keys(result).join(', ')}`
    );
  }

  validateArray<T>(typedResult.items, `${context}.items`);
}

/**
 * Validates that an array find operation returned a result (not undefined)
 *
 * Useful after find/filter operations that might return undefined
 *
 * @param value - The result from array.find()
 * @param context - Context for error message (e.g., function name)
 * @param searchCriteria - Description of what was being searched for
 * @throws Error with descriptive message if value is undefined
 *
 * @example
 * ```typescript
 * const pr = prs.items.find(p => p.number === prNumber);
 * validateFound(pr, 'getPullRequestObject', `number=${prNumber}`);
 * // Now TypeScript knows pr is defined
 * ```
 */
export function validateFound<T>(
  value: T | undefined,
  context: string,
  searchCriteria: string
): asserts value is T {
  if (value === undefined) {
    throw new Error(
      `${context}: Item not found (${searchCriteria}). ` +
      `This may indicate the item was deleted or access was revoked.`
    );
  }
}

/**
 * Validates an object has all required fields
 *
 * @param obj - The object to validate
 * @param fields - Array of required field names
 * @param context - Context for error message (e.g., function name)
 * @throws Error with descriptive message if any fields are missing
 *
 * @example
 * ```typescript
 * validateRequiredFields(user, ['id', 'login', 'email'], 'addUserEmail');
 * ```
 */
export function validateRequiredFields(
  obj: unknown,
  fields: string[],
  context: string
): void {
  if (obj === null || obj === undefined) {
    throw new Error(`${context}: Object is null or undefined`);
  }

  if (typeof obj !== 'object') {
    throw new TypeError(`${context}: Expected object, received ${typeof obj}`);
  }

  const typedObj = obj as Record<string, unknown>;
  const missingFields = fields.filter(field => !(field in typedObj));

  if (missingFields.length > 0) {
    throw new Error(
      `${context}: Missing required fields: ${missingFields.join(', ')}`
    );
  }
}

/**
 * Validates that a value is a non-empty string
 *
 * @param value - Value to validate
 * @param context - Context string for error messages
 * @param fieldName - Name of the field being validated
 * @throws Error if value is not a non-empty string
 *
 * @example
 * ```typescript
 * validateNonEmptyString(bucketName, 'getBucket', 'bucketName');
 * ```
 */
export function validateNonEmptyString(
  value: unknown,
  context: string,
  fieldName: string
): asserts value is string {
  if (typeof value !== 'string') {
    throw new TypeError(
      `${context}: Expected ${fieldName} to be string, received ${typeof value}`
    );
  }

  if (value.trim().length === 0) {
    throw new Error(
      `${context}: ${fieldName} cannot be empty`
    );
  }
}

/**
 * Validates that a value is a valid number
 *
 * @param value - Value to validate
 * @param context - Context string for error messages
 * @param fieldName - Name of the field being validated
 * @throws Error if value is not a valid number
 *
 * @example
 * ```typescript
 * validateNumber(fileSize, 'uploadFile', 'fileSize');
 * ```
 */
export function validateNumber(
  value: unknown,
  context: string,
  fieldName: string
): asserts value is number {
  if (typeof value !== 'number') {
    throw new TypeError(
      `${context}: Expected ${fieldName} to be number, received ${typeof value}`
    );
  }

  if (Number.Number.isNaN(value)) {
    throw new TypeError(
      `${context}: ${fieldName} cannot be NaN`
    );
  }
}

/**
 * Validates that a value is defined (not null or undefined)
 *
 * @param value - Value to validate
 * @param context - Context string for error messages
 * @param fieldName - Name of the field being validated
 * @throws Error if value is null or undefined
 *
 * @example
 * ```typescript
 * validateDefined(response.data, 'fetchData', 'response.data');
 * ```
 */
export function validateDefined<T>(
  value: T | null | undefined,
  context: string,
  fieldName: string
): asserts value is T {
  if (value === null || value === undefined) {
    throw new Error(
      `${context}: ${fieldName} is ${value === null ? 'null' : 'undefined'}`
    );
  }
}
