/**
 * JSONata integration for transform utilities
 *
 * Registers all modifiers as JSONata custom functions and provides lookup
 * for post-processing modifier chains.
 *
 * @packageDocumentation
 */

import { StringModifiers, NumberModifiers, DateModifiers, ArrayModifiers } from './Modifiers';
import { PathUtils } from './PathUtils';
import { ValueConverter } from './ValueConverter';

/**
 * JSONata integration utilities
 *
 * Provides methods to register all transform utilities as JSONata custom functions
 * and lookup modifiers for post-processing chains.
 */
export const JsonataIntegration = {
  /**
   * Registers all transform utilities as JSONata custom functions
   *
   * After calling this method, JSONata expressions can use functions like:
   * - $uppercase(str)
   * - $trim(str)
   * - $round(num, decimals)
   * - $formatCurrency(num)
   * - $dateOnly(date)
   * - $unique(array)
   * - $getNestedValue(obj, path)
   *
   * @param expression - JSONata expression instance
   *
   * @example
   * ```typescript
   * import jsonata from 'jsonata';
   * import { JsonataIntegration } from '@zerobias-org/data-utils';
   *
   * const expr = jsonata("$uppercase($trim(firstName))");
   * JsonataIntegration.registerFunctions(expr);
   * const result = expr.evaluate({ firstName: "  john  " });
   * // Result: "JOHN"
   * ```
   */
  registerFunctions(expression: any): void {
    // String modifiers
    expression.registerFunction('uppercase', StringModifiers.uppercase);
    expression.registerFunction('lowercase', StringModifiers.lowercase);
    expression.registerFunction('capitalize', StringModifiers.capitalize);
    expression.registerFunction('trim', StringModifiers.trim);
    expression.registerFunction('reverse', (str: string) => StringModifiers.reverse(str));
    expression.registerFunction('slugify', StringModifiers.slugify);
    expression.registerFunction('padLeft', (str: string, length: number, char?: string) =>
      StringModifiers.padLeft(str, length, char));

    // Number modifiers
    expression.registerFunction('round', (num: number, decimals?: number) =>
      NumberModifiers.round(num, decimals));
    expression.registerFunction('floor', NumberModifiers.floor);
    expression.registerFunction('ceil', NumberModifiers.ceil);
    expression.registerFunction('abs', NumberModifiers.abs);
    expression.registerFunction('formatCurrency', (num: number, currency?: string, locale?: string) =>
      NumberModifiers.formatCurrency(num, currency, locale));
    expression.registerFunction('pow', (num: number, exponent?: number) =>
      NumberModifiers.pow(num, exponent));
    expression.registerFunction('sqrt', NumberModifiers.sqrt);
    expression.registerFunction('log', NumberModifiers.log);
    expression.registerFunction('percentage', (num: number, total?: number, decimals?: number) =>
      NumberModifiers.percentage(num, total, decimals));

    // Date modifiers
    expression.registerFunction('formatDate', (date: Date | string, format?: string) =>
      DateModifiers.formatDate(date, format));
    expression.registerFunction('dateOnly', (date: Date | string) =>
      DateModifiers.dateOnly(date));
    expression.registerFunction('timeOnly', (date: Date | string) =>
      DateModifiers.timeOnly(date));
    expression.registerFunction('toTimestamp', (date: Date | string) =>
      DateModifiers.toTimestamp(date));
    expression.registerFunction('addDays', (date: Date | string, days?: number) =>
      DateModifiers.addDays(date, days));
    expression.registerFunction('subtractDays', (date: Date | string, days?: number) =>
      DateModifiers.subtractDays(date, days));
    expression.registerFunction('extractYear', (date: Date | string) =>
      DateModifiers.extractYear(date));
    expression.registerFunction('extractMonth', (date: Date | string) =>
      DateModifiers.extractMonth(date));
    expression.registerFunction('extractDay', (date: Date | string) =>
      DateModifiers.extractDay(date));

    // Array modifiers
    expression.registerFunction('first', ArrayModifiers.first);
    expression.registerFunction('last', ArrayModifiers.last);
    expression.registerFunction('unique', ArrayModifiers.unique);
    expression.registerFunction('arraySize', ArrayModifiers.size);
    expression.registerFunction('reverseArray', ArrayModifiers.reverse);
    expression.registerFunction('join', (arr: any[], separator?: string) =>
      ArrayModifiers.join(arr, separator));
    expression.registerFunction('slice', (arr: any[], start: number, end?: number) =>
      ArrayModifiers.slice(arr, start, end));

    // Path utilities - bind to preserve static context
    expression.registerFunction('getNestedValue', (obj: any, path: string) =>
      PathUtils.getNestedValue(obj, path));
    expression.registerFunction('getArrayValues', (obj: any, path: string) =>
      PathUtils.getArrayItemValues(obj, path));
    expression.registerFunction('hasPath', (obj: any, path: string) =>
      PathUtils.hasPath(obj, path));

    // Value converters
    expression.registerFunction('toBoolean', ValueConverter.toBoolean);
    expression.registerFunction('toNumber', ValueConverter.toNumber);
    expression.registerFunction('toDate', ValueConverter.toDate);
    expression.registerFunction('toDateString', ValueConverter.toDateString);
    expression.registerFunction('toString', ValueConverter.toString);
  },

  /**
   * Gets a modifier function by name for post-processing chains
   *
   * Used when applying modifiers sequentially outside of JSONata expressions.
   *
   * @param name - Modifier name (e.g., 'uppercase', 'trim', 'round')
   * @returns Modifier function or undefined if not found
   *
   * @example
   * ```typescript
   * const modifiers = ['trim', 'uppercase'];
   * let value = "  hello  ";
   *
   * for (const modifier of modifiers) {
   *   const fn = JsonataIntegration.getModifier(modifier);
   *   if (fn) {
   *     value = fn(value);
   *   }
   * }
   * // Result: "HELLO"
   * ```
   */
  getModifier(name: string): Function | undefined {
    const modifiers: Record<string, Function> = {
      // String modifiers
      'uppercase': StringModifiers.uppercase,
      'lowercase': StringModifiers.lowercase,
      'capitalize': StringModifiers.capitalize,
      'trim': StringModifiers.trim,
      'reverse': StringModifiers.reverse,
      'slugify': StringModifiers.slugify,
      'padLeft': StringModifiers.padLeft,

      // Number modifiers
      'round': NumberModifiers.round,
      'round2': (num: number) => NumberModifiers.round(num, 2),
      'floor': NumberModifiers.floor,
      'ceil': NumberModifiers.ceil,
      'abs': NumberModifiers.abs,
      'formatCurrency': NumberModifiers.formatCurrency,
      'pow': NumberModifiers.pow,
      'sqrt': NumberModifiers.sqrt,
      'log': NumberModifiers.log,
      'percentage': NumberModifiers.percentage,

      // Date modifiers
      'formatDate': DateModifiers.formatDate,
      'dateOnly': DateModifiers.dateOnly,
      'timeOnly': DateModifiers.timeOnly,
      'toTimestamp': DateModifiers.toTimestamp,
      'addDays': DateModifiers.addDays,
      'subtractDays': DateModifiers.subtractDays,
      'extractYear': DateModifiers.extractYear,
      'extractMonth': DateModifiers.extractMonth,
      'extractDay': DateModifiers.extractDay,

      // Array modifiers
      'first': ArrayModifiers.first,
      'last': ArrayModifiers.last,
      'unique': ArrayModifiers.unique,
      'size': ArrayModifiers.size,
      'arraySize': ArrayModifiers.size,
      'reverseArray': ArrayModifiers.reverse,
      'join': ArrayModifiers.join,
      'slice': ArrayModifiers.slice,

      // Path utilities
      'getNestedValue': PathUtils.getNestedValue,
      'getArrayValues': PathUtils.getArrayItemValues,
      'hasPath': PathUtils.hasPath,

      // Value converters
      'toBoolean': ValueConverter.toBoolean,
      'toNumber': ValueConverter.toNumber,
      'toDate': ValueConverter.toDate,
      'toDateString': ValueConverter.toDateString,
      'toString': ValueConverter.toString,
    };

    return modifiers[name];
  },

  /**
   * Gets all available modifier names
   *
   * @returns Array of all registered modifier names
   */
  getModifierNames(): string[] {
    return [
      // String modifiers
      'uppercase', 'lowercase', 'capitalize', 'trim', 'reverse', 'slugify', 'padLeft',
      // Number modifiers
      'round', 'round2', 'floor', 'ceil', 'abs', 'formatCurrency', 'pow', 'sqrt', 'log', 'percentage',
      // Date modifiers
      'formatDate', 'dateOnly', 'timeOnly', 'toTimestamp', 'addDays', 'subtractDays',
      'extractYear', 'extractMonth', 'extractDay',
      // Array modifiers
      'first', 'last', 'unique', 'size', 'arraySize', 'reverseArray', 'join', 'slice',
      // Path utilities
      'getNestedValue', 'getArrayValues', 'hasPath',
      // Value converters
      'toBoolean', 'toNumber', 'toDate', 'toDateString', 'toString',
    ];
  },
};
