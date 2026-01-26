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
 * All methods handle undefined gracefully and return undefined for invalid inputs.
 */
export const ValueConverter = {
  /**
   * Converts a value to boolean
   *
   * @param value - Value to convert
   * @returns Boolean value or undefined if conversion fails
   *
   * @example
   * ```typescript
   * ValueConverter.toBoolean('true')       // true
   * ValueConverter.toBoolean('false')      // false
   * ValueConverter.toBoolean(1)            // true
   * ValueConverter.toBoolean(0)            // false
   * ValueConverter.toBoolean(undefined)    // undefined
   * ```
   */
  toBoolean(value: any): boolean | undefined {
    if (!value) {
      return undefined;
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
  },

  /**
   * Converts a value to number
   *
   * Removes common formatting characters ($, commas) before conversion.
   *
   * @param value - Value to convert
   * @returns Number value or undefined if conversion fails
   *
   * @example
   * ```typescript
   * ValueConverter.toNumber('123')       // 123
   * ValueConverter.toNumber('$1,234.56') // 1234.56
   * ValueConverter.toNumber('abc')       // undefined
   * ValueConverter.toNumber(undefined)   // undefined
   * ```
   */
  toNumber(value: any): number | undefined {
    if (!value) {
      return undefined;
    }

    if (typeof value === 'number') {
      return Number.isNaN(value) ? undefined : value;
    }

    if (typeof value === 'string') {
      // Remove common formatting characters
      const cleaned = value.replaceAll(/[$,]/g, '');
      const numValue = Number.parseFloat(cleaned);
      return Number.isNaN(numValue) ? undefined : numValue;
    }

    const numValue = Number(value);
    return Number.isNaN(numValue) ? undefined : numValue;
  },

  /**
   * Converts a value to Date
   *
   * @param value - Value to convert (Date object, ISO string, or timestamp)
   * @returns Date object or undefined if conversion fails
   *
   * @example
   * ```typescript
   * ValueConverter.toDate('2023-01-15')              // Date object
   * ValueConverter.toDate(1673740800000)             // Date from timestamp
   * ValueConverter.toDate(new Date())                // Returns same Date
   * ValueConverter.toDate('invalid')                 // undefined
   * ```
   */
  toDate(value: any): Date | undefined {
    if (!value) {
      return undefined;
    }

    if (value instanceof Date) {
      return Number.isNaN(value.getTime()) ? undefined : value;
    }

    try {
      const date = new Date(value);
      return Number.isNaN(date.getTime()) ? undefined : date;
    } catch {
      return undefined;
    }
  },

  /**
   * Converts a value to ISO date string
   *
   * @param value - Value to convert
   * @returns ISO date string or undefined if conversion fails
   *
   * @example
   * ```typescript
   * ValueConverter.toDateString('2023-01-15')  // '2023-01-15T00:00:00.000Z'
   * ValueConverter.toDateString(new Date())    // ISO string
   * ```
   */
  toDateString(value: any): string | undefined {
    const date = this.toDate(value);
    return date ? date.toISOString() : undefined;
  },

  /**
   * Converts a value to string
   *
   * @param value - Value to convert
   * @returns String representation or empty string for undefined
   *
   * @example
   * ```typescript
   * ValueConverter.toString(123)         // '123'
   * ValueConverter.toString(true)        // 'true'
   * ValueConverter.toString(undefined)   // ''
   * ValueConverter.toString({a: 1})      // '[object Object]'
   * ```
   */
  toString(value: any): string {
    if (!value) {
      return '';
    }

    if (typeof value === 'string') {
      return value;
    }

    return String(value);
  },

  /**
   * Converts a value to the specified data type
   *
   * @param value - Value to convert
   * @param dataType - Target data type
   * @returns Converted value or undefined if conversion fails
   *
   * @example
   * ```typescript
   * ValueConverter.convert('123', 'number')    // 123
   * ValueConverter.convert('true', 'boolean')  // true
   * ValueConverter.convert(123, 'string')      // '123'
   * ```
   */
  convert(value: any, dataType: DataType): any {
    switch (dataType) {
      case 'boolean': {
        return this.toBoolean(value);
      }
      case 'number': {
        return this.toNumber(value);
      }
      case 'date': {
        return this.toDate(value);
      }
      case 'string': {
        return this.toString(value);
      }
      case 'array': {
        return Array.isArray(value) ? value : (value ? [value] : []);
      }
      case 'object': {
        return typeof value === 'object' ? value : undefined;
      }
      default: {
        return value;
      }
    }
  },
};
