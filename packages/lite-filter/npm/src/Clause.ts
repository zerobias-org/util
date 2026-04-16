import type { Expression, MatchOptions } from './types';
import { ComparisonOperator } from './ComparisonOperator';
import { getAdapter } from './adapters';
import {
  getProperty,
  coerceValue,
  compareStrings,
  wildcardToRegex,
  isNullOrUndefined,
  isEmptyArray,
  parseDate,
  isWithinDays,
  getYear,
} from './utils';
import { search } from 'fast-fuzzy';

/**
 * Clause - represents a single comparison operation
 * Internal implementation, not exposed in public API
 */
export class Clause implements Expression {
  constructor(
    public readonly property: string,
    public readonly operator: ComparisonOperator,
    public readonly value: any
  ) {}

  matches(obj: any, options?: MatchOptions): boolean {
    const caseSensitive = options?.caseSensitive ?? false;
    const propValue = getProperty(obj, this.property);

    switch (this.operator) {
      case ComparisonOperator.EQUALS:
        return this.matchEquals(propValue, this.value, caseSensitive);

      case ComparisonOperator.NOT_EQUALS:
        return !this.matchEquals(propValue, this.value, caseSensitive);

      case ComparisonOperator.GREATER_THAN:
        return this.matchComparison(propValue, this.value, '>');

      case ComparisonOperator.GREATER_THAN_OR_EQUAL:
        return this.matchComparison(propValue, this.value, '>=');

      case ComparisonOperator.LESS_THAN:
        return this.matchComparison(propValue, this.value, '<');

      case ComparisonOperator.LESS_THAN_OR_EQUAL:
        return this.matchComparison(propValue, this.value, '<=');

      case ComparisonOperator.APPROX_MATCH:
        return this.matchApproximate(propValue, this.value);

      case ComparisonOperator.PRESENT:
        return this.matchPresent(propValue);

      case ComparisonOperator.CONTAINS:
        return this.matchContains(propValue, this.value, caseSensitive);

      case ComparisonOperator.STARTS_WITH:
        return this.matchStartsWith(propValue, this.value, caseSensitive);

      case ComparisonOperator.ENDS_WITH:
        return this.matchEndsWith(propValue, this.value, caseSensitive);

      case ComparisonOperator.MATCHES:
        return this.matchRegex(propValue, this.value);

      case ComparisonOperator.IS_NULL:
        return isNullOrUndefined(propValue);

      case ComparisonOperator.IS_EMPTY:
        return isEmptyArray(propValue);

      case ComparisonOperator.INCLUDES:
        return this.matchIncludes(propValue, this.value);

      case ComparisonOperator.INCLUDES_ANY:
        return this.matchIncludesAny(propValue, this.value);

      case ComparisonOperator.BETWEEN:
        return this.matchBetween(propValue, this.value);

      case ComparisonOperator.WITHIN_DAYS:
        return this.matchWithinDays(propValue, this.value);

      case ComparisonOperator.YEAR:
        return this.matchYear(propValue, this.value);

      default:
        throw new Error(`Unknown operator: ${this.operator.name}`);
    }
  }

  private matchEquals(propValue: any, targetValue: any, caseSensitive: boolean): boolean {
    // Handle wildcards in targetValue
    if (typeof targetValue === 'string' && targetValue.includes('*')) {
      const regex = wildcardToRegex(targetValue);
      const strValue = String(propValue);
      if (caseSensitive) {
        return regex.test(strValue);
      }
      return regex.test(strValue.toLowerCase()) || regex.test(strValue);
    }

    // Coerce types for comparison
    const coerced = coerceValue(propValue, targetValue);

    // String comparison
    if (typeof coerced === 'string' && typeof targetValue === 'string') {
      return compareStrings(coerced, targetValue, caseSensitive);
    }

    return coerced === targetValue;
  }

  private matchComparison(propValue: any, targetValue: any, op: '>' | '>=' | '<' | '<='): boolean {
    const coerced = coerceValue(propValue, targetValue);

    if (typeof coerced === 'number' && typeof targetValue === 'number') {
      switch (op) {
        case '>':
          return coerced > targetValue;
        case '>=':
          return coerced >= targetValue;
        case '<':
          return coerced < targetValue;
        case '<=':
          return coerced <= targetValue;
      }
    }

    // String comparison (lexicographic)
    if (typeof coerced === 'string' && typeof targetValue === 'string') {
      switch (op) {
        case '>':
          return coerced > targetValue;
        case '>=':
          return coerced >= targetValue;
        case '<':
          return coerced < targetValue;
        case '<=':
          return coerced <= targetValue;
      }
    }

    return false;
  }

  private matchApproximate(propValue: any, targetValue: any): boolean {
    if (isNullOrUndefined(propValue)) {
      return false;
    }

    const strValue = String(propValue);
    const strTarget = String(targetValue);

    // Use fast-fuzzy library for approximate matching
    const results = search(strTarget, [strValue]);
    return results.length > 0;
  }

  private matchPresent(propValue: any): boolean {
    if (Array.isArray(propValue)) {
      return !isEmptyArray(propValue);
    }
    return !isNullOrUndefined(propValue);
  }

  private matchContains(propValue: any, targetValue: string, caseSensitive: boolean): boolean {
    if (isNullOrUndefined(propValue)) {
      return false;
    }

    const strValue = String(propValue);
    if (caseSensitive) {
      return strValue.includes(targetValue);
    }
    return strValue.toLowerCase().includes(targetValue.toLowerCase());
  }

  private matchStartsWith(propValue: any, targetValue: string, caseSensitive: boolean): boolean {
    if (isNullOrUndefined(propValue)) {
      return false;
    }

    const strValue = String(propValue);
    if (caseSensitive) {
      return strValue.startsWith(targetValue);
    }
    return strValue.toLowerCase().startsWith(targetValue.toLowerCase());
  }

  private matchEndsWith(propValue: any, targetValue: string, caseSensitive: boolean): boolean {
    if (isNullOrUndefined(propValue)) {
      return false;
    }

    const strValue = String(propValue);
    if (caseSensitive) {
      return strValue.endsWith(targetValue);
    }
    return strValue.toLowerCase().endsWith(targetValue.toLowerCase());
  }

  private matchRegex(propValue: any, targetValue: string | RegExp): boolean {
    if (isNullOrUndefined(propValue)) {
      return false;
    }

    const strValue = String(propValue);
    const regex = typeof targetValue === 'string' ? new RegExp(targetValue) : targetValue;

    try {
      return regex.test(strValue);
    } catch (error) {
      throw new Error(`Invalid regex pattern: ${targetValue}`);
    }
  }

  private matchIncludes(propValue: any, targetValue: any): boolean {
    if (!Array.isArray(propValue)) {
      return false;
    }

    return propValue.includes(targetValue);
  }

  private matchIncludesAny(propValue: any, targetValues: any[]): boolean {
    if (!Array.isArray(propValue)) {
      return false;
    }

    return targetValues.some(target => propValue.includes(target));
  }

  private matchBetween(propValue: any, range: { min: number; max: number }): boolean {
    const coerced = coerceValue(propValue, range.min);

    if (typeof coerced !== 'number') {
      return false;
    }

    return coerced >= range.min && coerced <= range.max;
  }

  private matchWithinDays(propValue: any, days: number): boolean {
    const date = parseDate(propValue);
    if (!date) {
      return false;
    }

    return isWithinDays(date, days);
  }

  private matchYear(propValue: any, targetYear: number): boolean {
    const date = parseDate(propValue);
    if (!date) {
      return false;
    }

    return getYear(date) === targetYear;
  }

  as(key: string): string {
    const adapter = getAdapter(key);
    return adapter.fromExpression(this);
  }
}

