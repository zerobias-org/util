/**
 * RFC4515 Filter Parser
 */

import type { Expression as IExpression } from './types';
import { Clause } from './Clause';
import { Grouping, LogicalOperator } from './Grouping';
import { ComparisonOperator } from './ComparisonOperator';

/**
 * Parser for RFC4515 filter syntax
 */
export class Parser {
  private input: string;
  private position: number;

  constructor(input: string) {
    this.input = input.trim();
    this.position = 0;
  }

  /**
   * Parse the filter string
   */
  parse(): IExpression {
    const expr = this.parseExpression();
    if (this.position < this.input.length) {
      throw new Error(`Unexpected characters after end of expression at position ${this.position}`);
    }
    return expr;
  }

  private parseExpression(): IExpression {
    this.skipWhitespace();

    if (this.peek() !== '(') {
      throw new Error(`Expected '(' at position ${this.position}`);
    }

    this.advance(); // consume '('
    this.skipWhitespace();

    const nextChar = this.peek();

    // Check for logical operators
    if (nextChar === '&') {
      return this.parseAnd();
    } else if (nextChar === '|') {
      return this.parseOr();
    } else if (nextChar === '!') {
      return this.parseNot();
    } else {
      // It's a clause
      return this.parseClause();
    }
  }

  private parseAnd(): IExpression {
    this.advance(); // consume '&'
    const expressions: IExpression[] = [];

    this.skipWhitespace();
    while (this.peek() === '(') {
      expressions.push(this.parseExpression());
      this.skipWhitespace();
    }

    if (this.peek() !== ')') {
      throw new Error(`Expected ')' at position ${this.position}`);
    }
    this.advance(); // consume ')'

    if (expressions.length === 0) {
      throw new Error('AND expression requires at least one sub-expression');
    }

    return new Grouping(LogicalOperator.AND, expressions);
  }

  private parseOr(): IExpression {
    this.advance(); // consume '|'
    const expressions: IExpression[] = [];

    this.skipWhitespace();
    while (this.peek() === '(') {
      expressions.push(this.parseExpression());
      this.skipWhitespace();
    }

    if (this.peek() !== ')') {
      throw new Error(`Expected ')' at position ${this.position}`);
    }
    this.advance(); // consume ')'

    if (expressions.length === 0) {
      throw new Error('OR expression requires at least one sub-expression');
    }

    return new Grouping(LogicalOperator.OR, expressions);
  }

  private parseNot(): IExpression {
    this.advance(); // consume '!'
    this.skipWhitespace();

    const expr = this.parseExpression();
    this.skipWhitespace();

    if (this.peek() !== ')') {
      throw new Error(`Expected ')' at position ${this.position}`);
    }
    this.advance(); // consume ')'

    return new Grouping(LogicalOperator.NOT, [expr]);
  }

  private parseClause(): IExpression {
    // Parse: property operator value)
    const property = this.parseProperty();
    const { operator, token } = this.parseOperator();
    const value = this.parseValue(operator);

    this.skipWhitespace();
    if (this.peek() !== ')') {
      throw new Error(`Expected ')' at position ${this.position}`);
    }
    this.advance(); // consume ')'

    // Validate operator-value compatibility
    this.validateOperatorValue(operator, value, token);

    return new Clause(property, operator, value);
  }

  private parseProperty(): string {
    this.skipWhitespace();
    let property = '';

    while (this.position < this.input.length) {
      const char = this.peek();
      if (char === '=' || char === '>' || char === '<' || char === '!' || char === '~' || char === ':') {
        break;
      }
      property += char;
      this.advance();
    }

    property = property.trim();
    if (property.length === 0) {
      throw new Error(`Expected property name at position ${this.position}`);
    }

    return property;
  }

  private parseOperator(): { operator: ComparisonOperator; token: string } {
    this.skipWhitespace();
    let token = '';

    // Check for custom extension operators (start with :)
    if (this.peek() === ':') {
      token = this.parseCustomOperator();
    } else {
      // Standard operators
      const char = this.peek();
      if (char === '=') {
        this.advance();
        // Check for =*
        if (this.peek() === '*') {
          this.advance();
          token = '=*';
        } else {
          token = '=';
        }
      } else if (char === '!') {
        this.advance();
        if (this.peek() === '=') {
          this.advance();
          token = '!=';
        } else {
          throw new Error(`Expected '=' after '!' at position ${this.position}`);
        }
      } else if (char === '>') {
        this.advance();
        if (this.peek() === '=') {
          this.advance();
          token = '>=';
        } else {
          token = '>';
        }
      } else if (char === '<') {
        this.advance();
        if (this.peek() === '=') {
          this.advance();
          token = '<=';
        } else {
          token = '<';
        }
      } else if (char === '~') {
        this.advance();
        if (this.peek() === '=') {
          this.advance();
          token = '~=';
        } else {
          throw new Error(`Expected '=' after '~' at position ${this.position}`);
        }
      } else {
        throw new Error(`Unknown operator at position ${this.position}`);
      }
    }

    try {
      const operator = ComparisonOperator.parse(token);
      return { operator, token };
    } catch (error) {
      throw new Error(`Unknown operator: ${token}`);
    }
  }

  private parseCustomOperator(): string {
    let token = '';
    // Custom operators are in format :name:
    while (this.position < this.input.length) {
      const char = this.peek();
      token += char;
      this.advance();

      if (char === ':' && token.length > 1) {
        // Found closing :
        break;
      }
    }

    if (!token.endsWith(':') || token.length < 3) {
      throw new Error(`Invalid custom operator format at position ${this.position}`);
    }

    return token;
  }

  private parseValue(operator: ComparisonOperator): any {
    this.skipWhitespace();
    let value = '';

    // Special handling for operators that don't use values
    if (operator === ComparisonOperator.IS_NULL || operator === ComparisonOperator.IS_EMPTY) {
      // Skip to closing paren
      while (this.position < this.input.length && this.peek() !== ')') {
        this.advance();
      }
      return null;
    }

    // Read until closing parenthesis
    while (this.position < this.input.length && this.peek() !== ')') {
      value += this.peek();
      this.advance();
    }

    value = value.trim();

    // Parse value based on operator
    return this.parseValueByOperator(operator, value);
  }

  private parseValueByOperator(operator: ComparisonOperator, value: string): any {
    // BETWEEN requires special parsing
    if (operator === ComparisonOperator.BETWEEN) {
      const parts = value.split(',').map(p => p.trim());
      if (parts.length !== 2) {
        throw new Error('BETWEEN operator requires two comma-separated values');
      }
      const min = Number(parts[0]);
      const max = Number(parts[1]);
      if (isNaN(min) || isNaN(max)) {
        throw new Error('BETWEEN operator requires numeric values');
      }
      return { min, max };
    }

    // INCLUDES_ANY requires array parsing
    if (operator === ComparisonOperator.INCLUDES_ANY) {
      return value.split(',').map(v => v.trim());
    }

    // WITHIN_DAYS and YEAR require numeric values
    if (operator === ComparisonOperator.WITHIN_DAYS || operator === ComparisonOperator.YEAR) {
      const num = Number(value);
      if (isNaN(num)) {
        throw new Error(`${operator.name} operator requires a numeric value`);
      }
      return num;
    }

    // For numeric comparisons, try to parse as number
    if (
      operator === ComparisonOperator.GREATER_THAN ||
      operator === ComparisonOperator.GREATER_THAN_OR_EQUAL ||
      operator === ComparisonOperator.LESS_THAN ||
      operator === ComparisonOperator.LESS_THAN_OR_EQUAL
    ) {
      const num = Number(value);
      if (!isNaN(num)) {
        return num;
      }
    }

    // Try to parse as boolean
    if (value.toLowerCase() === 'true') {
      return true;
    }
    if (value.toLowerCase() === 'false') {
      return false;
    }

    // Return as string
    return value;
  }

  private validateOperatorValue(operator: ComparisonOperator, value: any, token: string): void {
    // Validate MATCHES operator has valid regex
    if (operator === ComparisonOperator.MATCHES) {
      try {
        new RegExp(value);
      } catch (error) {
        throw new Error(`Invalid regex pattern for ${token}: ${value}`);
      }
    }

    // Additional validations can be added here
  }

  private peek(): string {
    if (this.position >= this.input.length) {
      return '';
    }
    return this.input[this.position] ?? '';
  }

  private advance(): void {
    this.position++;
  }

  private skipWhitespace(): void {
    while (this.position < this.input.length && /\s/.test(this.peek())) {
      this.advance();
    }
  }
}

/**
 * Parse an RFC4515 filter string
 * @param filter The filter string
 * @returns The parsed Expression
 */
export function parseFilter(filter: string): IExpression {
  const parser = new Parser(filter);
  return parser.parse();
}
