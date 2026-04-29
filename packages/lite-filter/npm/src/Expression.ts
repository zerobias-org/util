import type { Expression as IExpression, Adapter } from './types';
import { Clause } from './Clause';
import { Grouping, LogicalOperator } from './Grouping';
import { ComparisonOperator } from './ComparisonOperator';
import { parseFilter } from './parser';
import * as AdapterRegistry from './adapters';

/**
 * Expression - Main public API entry point
 * Provides factory methods for creating filter expressions
 */
export class Expression {
  // ========== Comparison Operations ==========

  static equals(property: string, value: any): IExpression {
    return new Clause(property, ComparisonOperator.EQUALS, value);
  }

  static notEquals(property: string, value: any): IExpression {
    return new Clause(property, ComparisonOperator.NOT_EQUALS, value);
  }

  static greaterThan(property: string, value: any): IExpression {
    return new Clause(property, ComparisonOperator.GREATER_THAN, value);
  }

  static greaterThanOrEqual(property: string, value: any): IExpression {
    return new Clause(property, ComparisonOperator.GREATER_THAN_OR_EQUAL, value);
  }

  static lessThan(property: string, value: any): IExpression {
    return new Clause(property, ComparisonOperator.LESS_THAN, value);
  }

  static lessThanOrEqual(property: string, value: any): IExpression {
    return new Clause(property, ComparisonOperator.LESS_THAN_OR_EQUAL, value);
  }

  static approxMatch(property: string, value: any): IExpression {
    return new Clause(property, ComparisonOperator.APPROX_MATCH, value);
  }

  static present(property: string): IExpression {
    return new Clause(property, ComparisonOperator.PRESENT, null);
  }

  // ========== String Operations ==========

  static contains(property: string, value: string): IExpression {
    return new Clause(property, ComparisonOperator.CONTAINS, value);
  }

  static startsWith(property: string, value: string): IExpression {
    return new Clause(property, ComparisonOperator.STARTS_WITH, value);
  }

  static endsWith(property: string, value: string): IExpression {
    return new Clause(property, ComparisonOperator.ENDS_WITH, value);
  }

  static matches(property: string, regex: string | RegExp): IExpression {
    return new Clause(property, ComparisonOperator.MATCHES, regex);
  }

  // ========== Null/Empty Checks ==========

  static isNull(property: string): IExpression {
    return new Clause(property, ComparisonOperator.IS_NULL, null);
  }

  static isEmpty(property: string): IExpression {
    return new Clause(property, ComparisonOperator.IS_EMPTY, null);
  }

  // ========== Array Operations ==========

  static includes(property: string, value: any): IExpression {
    return new Clause(property, ComparisonOperator.INCLUDES, value);
  }

  static includesAny(property: string, values: any[]): IExpression {
    return new Clause(property, ComparisonOperator.INCLUDES_ANY, values);
  }

  // ========== Numeric Operations ==========

  static between(property: string, min: number, max: number): IExpression {
    return new Clause(property, ComparisonOperator.BETWEEN, { min, max });
  }

  // ========== Date Operations ==========

  static withinDays(property: string, days: number): IExpression {
    return new Clause(property, ComparisonOperator.WITHIN_DAYS, days);
  }

  static year(property: string, year: number): IExpression {
    return new Clause(property, ComparisonOperator.YEAR, year);
  }

  // ========== Logical Operations ==========

  static and(...expressions: IExpression[]): IExpression {
    return new Grouping(LogicalOperator.AND, expressions);
  }

  static or(...expressions: IExpression[]): IExpression {
    return new Grouping(LogicalOperator.OR, expressions);
  }

  static not(expression: IExpression): IExpression {
    return new Grouping(LogicalOperator.NOT, [expression]);
  }

  // ========== Parser ==========

  /**
   * Parses an RFC4515 filter string into an Expression tree
   * @param filter RFC4515 filter syntax (e.g., "(&(status=active)(age>=18))")
   * @returns The parsed Expression
   * @throws Error if the filter syntax is invalid
   */
  static parse(filter: string): IExpression {
    return parseFilter(filter);
  }

  // ========== Adapter Management ==========

  /**
   * Registers an adapter for translating expressions to other query languages
   * @param key The adapter key (e.g., "SQL", "DynamoDB")
   * @param description Human-readable description
   * @param adapter The adapter implementation
   */
  static addAdapter(key: string, description: string, adapter: Adapter): void {
    AdapterRegistry.addAdapter(key, description, adapter);
  }

  /**
   * Lists all registered adapters
   * @returns Array of adapter keys and descriptions
   */
  static adapters(): Array<{ key: string; description: string }> {
    return AdapterRegistry.listAdapters();
  }

  /**
   * Gets an adapter by key (internal use)
   * @param key The adapter key
   * @returns The adapter
   * @throws Error if adapter not found
   */
  static getAdapter(key: string): Adapter {
    return AdapterRegistry.getAdapter(key);
  }
}
