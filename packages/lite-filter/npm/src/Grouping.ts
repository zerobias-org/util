import type { Expression, MatchOptions } from './types';
import { getAdapter } from './adapters';

/**
 * Logical operators for grouping expressions
 */
export enum LogicalOperator {
  AND = 'AND',
  OR = 'OR',
  NOT = 'NOT',
}

/**
 * Grouping - represents a logical combination of expressions
 * Internal implementation, not exposed in public API
 */
export class Grouping implements Expression {
  constructor(
    public readonly operator: LogicalOperator,
    public readonly expressions: Expression[]
  ) {
    if (operator === LogicalOperator.NOT && expressions.length !== 1) {
      throw new Error('NOT operator requires exactly one expression');
    }
  }

  matches(obj: any, options?: MatchOptions): boolean {
    switch (this.operator) {
      case LogicalOperator.AND:
        return this.expressions.every(expr => expr.matches(obj, options));
      case LogicalOperator.OR:
        return this.expressions.some(expr => expr.matches(obj, options));
      case LogicalOperator.NOT:
        return !this.expressions[0]!.matches(obj, options);
      default:
        throw new Error(`Unknown logical operator: ${this.operator}`);
    }
  }

  as(key: string): string {
    const adapter = getAdapter(key);
    return adapter.fromExpression(this);
  }
}
