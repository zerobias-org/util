/**
 * Value conversion utilities for DataProducer implementations
 *
 * Provides type-safe conversion between common data types used in
 * DataProducer schemas and API responses.
 *
 * @packageDocumentation
 */

/**
 * Supported data types for conversion
 */
export type DataType = 'string' | 'number' | 'boolean' | 'date' | 'array' | 'object';

/**
 * Value converter for common type transformations
 *
 * All methods handle null/undefined gracefully and return null for invalid inputs.
 */
export class ValueConverter {
  /**
   * Converts a value to boolean
   *
   * @param value - Value to convert
   * @returns Boolean value or null if conversion fails
   *
   * @example
   * ```typescript
   * ValueConverter.toBoolean('true')  // true
   * ValueConverter.toBoolean('false') // false
   * ValueConverter.toBoolean(1)       // true
   * ValueConverter.toBoolean(0)       // false
   * ValueConverter.toBoolean(null)    // null
   * ```
   */
  static toBoolean(value: any): boolean | null {
    if (value === null || value === undefined) {
      return null;
    }

    if (typeof value === 'boolean') {
      return value;
    }

    if (typeof value === 'string') {
      return value.toLowerCase() === 'true';
    }

    if (typeof value === 'number') {
      return value !== 0;
    }

    return Boolean(value);
  }

  /**
   * Converts a value to number
   *
   * Removes common formatting characters ($, commas) before conversion.
   *
   * @param value - Value to convert
   * @returns Number value or null if conversion fails
   *
   * @example
   * ```typescript
   * ValueConverter.toNumber('123')      // 123
   * ValueConverter.toNumber('$1,234.56') // 1234.56
   * ValueConverter.toNumber('abc')      // null
   * ValueConverter.toNumber(null)       // null
   * ```
   */
  static toNumber(value: any): number | null {
    if (value === null || value === undefined) {
      return null;
    }

    if (typeof value === 'number') {
      return isNaN(value) ? null : value;
    }

    if (typeof value === 'string') {
      // Remove common formatting characters
      const cleaned = value.replace(/[$,]/g, '');
      const numValue = parseFloat(cleaned);
      return isNaN(numValue) ? null : numValue;
    }

    const numValue = Number(value);
    return isNaN(numValue) ? null : numValue;
  }

  /**
   * Converts a value to Date
   *
   * @param value - Value to convert (Date object, ISO string, or timestamp)
   * @returns Date object or null if conversion fails
   *
   * @example
   * ```typescript
   * ValueConverter.toDate('2023-01-15')              // Date object
   * ValueConverter.toDate(1673740800000)             // Date from timestamp
   * ValueConverter.toDate(new Date())                // Returns same Date
   * ValueConverter.toDate('invalid')                 // null
   * ```
   */
  static toDate(value: any): Date | null {
    if (value === null || value === undefined) {
      return null;
    }

    if (value instanceof Date) {
      return isNaN(value.getTime()) ? null : value;
    }

    try {
      const date = new Date(value);
      return isNaN(date.getTime()) ? null : date;
    } catch {
      return null;
    }
  }

  /**
   * Converts a value to ISO date string
   *
   * @param value - Value to convert
   * @returns ISO date string or null if conversion fails
   *
   * @example
   * ```typescript
   * ValueConverter.toDateString('2023-01-15')  // '2023-01-15T00:00:00.000Z'
   * ValueConverter.toDateString(new Date())    // ISO string
   * ```
   */
  static toDateString(value: any): string | null {
    const date = this.toDate(value);
    return date ? date.toISOString() : null;
  }

  /**
   * Converts a value to string
   *
   * @param value - Value to convert
   * @returns String representation or empty string for null/undefined
   *
   * @example
   * ```typescript
   * ValueConverter.toString(123)     // '123'
   * ValueConverter.toString(true)    // 'true'
   * ValueConverter.toString(null)    // ''
   * ValueConverter.toString({a: 1})  // '[object Object]'
   * ```
   */
  static toString(value: any): string {
    if (value === null || value === undefined) {
      return '';
    }

    if (typeof value === 'string') {
      return value;
    }

    return String(value);
  }

  /**
   * Converts a value to the specified data type
   *
   * @param value - Value to convert
   * @param dataType - Target data type
   * @returns Converted value or null if conversion fails
   *
   * @example
   * ```typescript
   * ValueConverter.convert('123', 'number')    // 123
   * ValueConverter.convert('true', 'boolean')  // true
   * ValueConverter.convert(123, 'string')      // '123'
   * ```
   */
  static convert(value: any, dataType: DataType): any {
    switch (dataType) {
      case 'boolean':
        return this.toBoolean(value);
      case 'number':
        return this.toNumber(value);
      case 'date':
        return this.toDate(value);
      case 'string':
        return this.toString(value);
      case 'array':
        return Array.isArray(value) ? value : value !== null && value !== undefined ? [value] : [];
      case 'object':
        return typeof value === 'object' ? value : null;
      default:
        return value;
    }
  }
}
