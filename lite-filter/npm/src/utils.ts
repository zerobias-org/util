/**
 * Utility functions for expression matching
 */

/**
 * Gets a property value from an object using dot notation
 * @param obj The object to access
 * @param path The property path (e.g., "user.email", "address.city")
 * @returns The property value or undefined if not found
 */
export function getProperty(obj: any, path: string): any {
  if (!obj || typeof obj !== 'object') {
    return undefined;
  }

  const parts = path.split('.');
  let current = obj;

  for (const part of parts) {
    if (current == null) {
      return undefined;
    }
    current = current[part];
  }

  return current;
}

/**
 * Coerces a value to match the type of the target for comparison
 * @param value The value to coerce
 * @param target The target value to match type against
 * @returns The coerced value
 */
export function coerceValue(value: any, target: any): any {
  // If types already match, no coercion needed
  if (typeof value === typeof target) {
    return value;
  }

  // String to number
  if (typeof target === 'number' && typeof value === 'string') {
    const num = Number(value);
    return isNaN(num) ? value : num;
  }

  // String to boolean
  if (typeof target === 'boolean' && typeof value === 'string') {
    if (value.toLowerCase() === 'true') return true;
    if (value.toLowerCase() === 'false') return false;
  }

  // Number to string
  if (typeof target === 'string' && typeof value === 'number') {
    return String(value);
  }

  // Boolean to string
  if (typeof target === 'string' && typeof value === 'boolean') {
    return String(value);
  }

  return value;
}

/**
 * Performs case-sensitive or case-insensitive string comparison
 * @param a First string
 * @param b Second string
 * @param caseSensitive Whether to compare case-sensitively
 * @returns true if strings match
 */
export function compareStrings(a: string, b: string, caseSensitive: boolean): boolean {
  if (caseSensitive) {
    return a === b;
  }
  return a.toLowerCase() === b.toLowerCase();
}

/**
 * Converts a wildcard pattern to a regex
 * @param pattern Pattern with * wildcards (e.g., "J*n", "*@example.com")
 * @returns RegExp object
 */
export function wildcardToRegex(pattern: string): RegExp {
  // Escape special regex characters except *
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  // Convert * to .*
  const regexPattern = escaped.replace(/\*/g, '.*');
  return new RegExp(`^${regexPattern}$`);
}

/**
 * Checks if a value is null or undefined
 * @param value The value to check
 * @returns true if null or undefined
 */
export function isNullOrUndefined(value: any): boolean {
  return value === null || value === undefined;
}

/**
 * Checks if an array is null, undefined, or empty
 * @param value The value to check
 * @returns true if null, undefined, or empty array
 */
export function isEmptyArray(value: any): boolean {
  return isNullOrUndefined(value) || (Array.isArray(value) && value.length === 0);
}

/**
 * Parses an ISO 8601 date string
 * @param value The value to parse
 * @returns Date object or null if invalid
 */
export function parseDate(value: any): Date | null {
  if (value instanceof Date) {
    return value;
  }

  if (typeof value === 'string') {
    const date = new Date(value);
    return isNaN(date.getTime()) ? null : date;
  }

  return null;
}

/**
 * Checks if a date is within N days from now
 * @param date The date to check
 * @param days Number of days
 * @returns true if date is within last N days
 */
export function isWithinDays(date: Date, days: number): boolean {
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffDays = diffMs / (1000 * 60 * 60 * 24);
  return diffDays >= 0 && diffDays <= days;
}

/**
 * Extracts the year from a date
 * @param date The date
 * @returns The year as a number
 */
export function getYear(date: Date): number {
  return date.getFullYear();
}
