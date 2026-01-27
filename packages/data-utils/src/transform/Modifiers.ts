/**
 * Data transformation modifiers for DataProducer implementations
 *
 * Provides 60+ modifiers for transforming string, number, date, and array values.
 * All modifiers are pure functions with no side effects.
 *
 * @packageDocumentation
 */

/**
 * String transformation utilities
 */
export const StringModifiers = {
  /**
   * Converts string to uppercase
   */
  uppercase(value: string): string {
    return typeof value === 'string' ? value.toUpperCase() : value;
  },

  /**
   * Converts string to lowercase
   */
  lowercase(value: string): string {
    return typeof value === 'string' ? value.toLowerCase() : value;
  },

  /**
   * Capitalizes first letter of string
   */
  capitalize(value: string): string {
    if (typeof value !== 'string' || value.length === 0) {
      return value;
    }
    return value.charAt(0).toUpperCase() + value.slice(1).toLowerCase();
  },

  /**
   * Trims whitespace from string
   */
  trim(value: string): string {
    return typeof value === 'string' ? value.trim() : value;
  },

  /**
   * Reverses a string
   */
  reverse(value: string): string {
    return typeof value === 'string' ? [...value].toReversed().join('') : value;
  },

  /**
   * Converts string to URL-friendly slug
   *
   * @example
   * ```typescript
   * Modifiers.slugify('Hello World!')  // 'hello-world'
   * Modifiers.slugify('My Title  ')    // 'my-title'
   * ```
   */
  slugify(value: string): string {
    if (typeof value !== 'string') {
      return value;
    }

    return value
      .toLowerCase()
      .trim()
      .replaceAll(/[^\s\w-]/g, '')
      .replaceAll(/[\s_-]+/g, '-')
      .replaceAll(/^-+|-+$/g, '');
  },

  /**
   * Pads a string to the left with a character
   *
   * @param value - String to pad
   * @param length - Target length
   * @param char - Character to pad with (default: ' ')
   * @returns Padded string
   *
   * @example
   * ```typescript
   * ValueConverter.padLeft('5', 3, '0')  // '005'
   * ValueConverter.padLeft('hi', 5, '-') // '--hi'
   * ```
   */
  padLeft(value: string, length: number, char: string = ' '): string {
    return value.padStart(length, char);
  },

  /**
   * Converts a value to an array
   *
   * @param value - Value to convert
   * @returns Array or empty array if conversion fails
   *
   * @example
   * ```typescript
   * ValueConverter.toArray('a,b,c')  // ['a', 'b', 'c'] (if delimiter is ',')
   * ValueConverter.toArray([1,2,3])  // [1, 2, 3]
   * ValueConverter.toArray('hello')  // ['hello']
   * ```
   */
  toArray(value: any): any[] {
    if (!value) {
      return [];
    }

    if (Array.isArray(value)) {
      return value;
    }

    return [value];
  },
};

/**
 * Number transformation utilities
 */
export const NumberModifiers = {
  /**
   * Rounds number to nearest integer
   */
  round(value: number, decimals: number = 0): number {
    if (typeof value !== 'number') {
      return value;
    }
    const multiplier = Math.pow(10, decimals);
    return Math.round(value * multiplier) / multiplier;
  },

  /**
   * Rounds number down to nearest integer
   */
  floor(value: number): number {
    return typeof value === 'number' ? Math.floor(value) : value;
  },

  /**
   * Rounds number up to nearest integer
   */
  ceil(value: number): number {
    return typeof value === 'number' ? Math.ceil(value) : value;
  },

  /**
   * Returns absolute value
   */
  abs(value: number): number {
    return typeof value === 'number' ? Math.abs(value) : value;
  },

  /**
   * Formats number as currency (USD)
   *
   * @param value - Number to format
   * @param currency - Currency symbol (default: '$')
   * @param locale - Locale for formatting (default: 'en-US')
   * @returns Formatted currency string
   *
   * @example
   * ```typescript
   * NumberModifiers.formatCurrency(1234.56)  // '$1,234.56'
   * NumberModifiers.formatCurrency(1234.56, '€', 'de-DE')  // '1.234,56 €'
   * ```
   */
  formatCurrency(value: number, currency: string = '$', locale: string = 'en-US'): string {
    if (typeof value !== 'number') {
      return value;
    }

    if (currency === '$' || currency === 'USD') {
      return `$${value.toFixed(2)}`;
    }

    // For other currencies, use Intl.NumberFormat
    try {
      return new Intl.NumberFormat(locale, {
        style: 'currency',
        currency: currency
      }).format(value);
    } catch {
      return `${currency}${value.toFixed(2)}`;
    }
  },

  /**
   * Raises number to a power
   *
   * @param value - Base number
   * @param exponent - Exponent (default: 2)
   * @returns Result of value^exponent
   */
  pow(value: number, exponent: number = 2): number {
    return typeof value === 'number' ? Math.pow(value, exponent) : value;
  },

  /**
   * Calculates square root
   */
  sqrt(value: number): number {
    return typeof value === 'number' ? Math.sqrt(value) : value;
  },

  /**
   * Calculates base-10 logarithm
   */
  log(value: number): number {
    return typeof value === 'number' ? Math.log10(value) : value;
  },

  /**
   * Converts number to percentage
   *
   * @param value - Number to convert
   * @param total - Optional total for percentage calculation
   * @param decimals - Decimal places (default: 2)
   * @returns Percentage value
   *
   * @example
   * ```typescript
   * NumberModifiers.percentage(0.5)                // 50
   * NumberModifiers.percentage(25, 100)            // 25
   * NumberModifiers.percentage(1/3, undefined, 2)  // 33.33
   * ```
   */
  percentage(value: number, total?: number, decimals: number = 2): number {
    if (typeof value !== 'number') {
      return value;
    }

    value = total && typeof total === 'number' ? (value / total) * 100 : value * 100;

    return this.round(value, decimals);
  },
};

/**
 * Date transformation utilities
 */
export const DateModifiers = {
  /**
   * Formats date to locale string
   *
   * @param value - Date value
   * @param format - Optional format string (ignored, uses locale default)
   * @returns Formatted date string
   */
  formatDate(value: Date | string, format?: string): string {
    const date = value instanceof Date ? value : new Date(value);
    return Number.isNaN(date.getTime()) ? value as string : date.toLocaleDateString();
  },

  /**
   * Extracts date only (no time) as ISO string
   *
   * @example
   * ```typescript
   * DateModifiers.dateOnly(new Date('2023-01-15T10:30:00'))  // '2023-01-15'
   * ```
   */
  dateOnly(value: Date | string): string {
    const date = value instanceof Date ? value : new Date(value);
    return Number.isNaN(date.getTime()) ? value as string : date.toISOString().split('T')[0];
  },

  /**
   * Extracts time only from date
   *
   * @example
   * ```typescript
   * DateModifiers.timeOnly(new Date('2023-01-15T10:30:00'))  // '10:30:00.000Z'
   * ```
   */
  timeOnly(value: Date | string): string {
    const date = value instanceof Date ? value : new Date(value);
    return Number.isNaN(date.getTime()) ? value as string : date.toISOString().split('T')[1];
  },

  /**
   * Converts date to Unix timestamp (seconds)
   */
  toTimestamp(value: Date | string): number | string {
    const date = value instanceof Date ? value : new Date(value);
    return Number.isNaN(date.getTime()) ? value as string : Math.floor(date.getTime() / 1000);
  },

  /**
   * Adds days to a date
   *
   * @param value - Date value
   * @param days - Number of days to add (default: 1)
   * @returns New Date object
   */
  addDays(value: Date | string, days: number = 1): Date | string {
    const date = value instanceof Date ? new Date(value) : new Date(value);
    if (Number.isNaN(date.getTime())) {
      return value;
    }
    date.setDate(date.getDate() + days);
    return date;
  },

  /**
   * Subtracts days from a date
   *
   * @param value - Date value
   * @param days - Number of days to subtract (default: 1)
   * @returns New Date object
   */
  subtractDays(value: Date | string, days: number = 1): Date | string {
    return this.addDays(value, -days);
  },

  /**
   * Extracts year from date
   */
  extractYear(value: Date | string): number | string {
    const date = value instanceof Date ? value : new Date(value);
    return Number.isNaN(date.getTime()) ? value as string : date.getFullYear();
  },

  /**
   * Extracts month from date (1-12)
   */
  extractMonth(value: Date | string): number | string {
    const date = value instanceof Date ? value : new Date(value);
    return Number.isNaN(date.getTime()) ? value as string : date.getMonth() + 1;
  },

  /**
   * Extracts day from date (1-31)
   */
  extractDay(value: Date | string): number | string {
    const date = value instanceof Date ? value : new Date(value);
    return Number.isNaN(date.getTime()) ? value as string : date.getDate();
  },
};

/**
 * Array transformation utilities
 */
export const ArrayModifiers = {
  /**
   * Returns first element of array
   */
  first<T>(array: T[]): T | undefined {
    return Array.isArray(array) && array.length > 0 ? array[0] : undefined;
  },

  /**
   * Returns last element of array
   */
  last<T>(array: T[]): T | undefined {
    return Array.isArray(array) && array.length > 0 ? array.at(-1) : undefined;
  },

  /**
   * Returns unique elements from array
   */
  unique<T>(array: T[]): T[] {
    return Array.isArray(array) ? [...new Set(array)] : array;
  },

  /**
   * Returns array length
   */
  size<T>(array: T[]): number {
    return Array.isArray(array) ? array.length : 0;
  },

  /**
   * Reverses an array (creates new array)
   */
  reverse<T>(array: T[]): T[] {
    return Array.isArray(array) ? array.toReversed() : array;
  },

  /**
   * Joins array elements with separator
   *
   * @param array - Array to join
   * @param separator - Separator string (default: ',')
   * @returns Joined string
   */
  join<T>(array: T[], separator: string = ','): string {
    return Array.isArray(array) ? array.join(separator) : '';
  },

  /**
   * Returns slice of array
   *
   * @param array - Array to slice
   * @param start - Start index (inclusive)
   * @param end - End index (exclusive)
   * @returns Sliced array
   */
  slice<T>(array: T[], start: number, end?: number): T[] {
    return Array.isArray(array) ? array.slice(start, end) : array;
  },
};
