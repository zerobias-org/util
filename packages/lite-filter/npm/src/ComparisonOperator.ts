/**
 * ComparisonOperator class - represents all supported comparison operators
 * This is an internal implementation detail
 */
export class ComparisonOperator {
  /**
   * The token as it appears in filter syntax (e.g., "=", ":contains:", ">=")
   */
  readonly token: string;

  /**
   * The programmatic name (e.g., "EQUALS", "CONTAINS", "GREATER_THAN_OR_EQUAL")
   */
  readonly name: string;

  private constructor(token: string, name: string) {
    this.token = token;
    this.name = name;
  }

  // Standard RFC4515 operators (no colons)
  static readonly EQUALS = new ComparisonOperator('=', 'EQUALS');
  static readonly NOT_EQUALS = new ComparisonOperator('!=', 'NOT_EQUALS');
  static readonly GREATER_THAN = new ComparisonOperator('>', 'GREATER_THAN');
  static readonly GREATER_THAN_OR_EQUAL = new ComparisonOperator('>=', 'GREATER_THAN_OR_EQUAL');
  static readonly LESS_THAN = new ComparisonOperator('<', 'LESS_THAN');
  static readonly LESS_THAN_OR_EQUAL = new ComparisonOperator('<=', 'LESS_THAN_OR_EQUAL');
  static readonly APPROX_MATCH = new ComparisonOperator('~=', 'APPROX_MATCH');
  static readonly PRESENT = new ComparisonOperator('=*', 'PRESENT');

  // Custom extensions (with colons)
  static readonly CONTAINS = new ComparisonOperator(':contains:', 'CONTAINS');
  static readonly STARTS_WITH = new ComparisonOperator(':startsWith:', 'STARTS_WITH');
  static readonly ENDS_WITH = new ComparisonOperator(':endsWith:', 'ENDS_WITH');
  static readonly MATCHES = new ComparisonOperator(':matches:', 'MATCHES');
  static readonly IS_NULL = new ComparisonOperator(':isnull:', 'IS_NULL');
  static readonly IS_EMPTY = new ComparisonOperator(':isempty:', 'IS_EMPTY');
  static readonly INCLUDES = new ComparisonOperator(':includes:', 'INCLUDES');
  static readonly INCLUDES_ANY = new ComparisonOperator(':includesAny:', 'INCLUDES_ANY');
  static readonly BETWEEN = new ComparisonOperator(':between:', 'BETWEEN');
  static readonly WITHIN_DAYS = new ComparisonOperator(':withinDays:', 'WITHIN_DAYS');
  static readonly YEAR = new ComparisonOperator(':year:', 'YEAR');

  /**
   * All registered operators
   */
  private static readonly ALL_OPERATORS = [
    ComparisonOperator.EQUALS,
    ComparisonOperator.NOT_EQUALS,
    ComparisonOperator.GREATER_THAN,
    ComparisonOperator.GREATER_THAN_OR_EQUAL,
    ComparisonOperator.LESS_THAN,
    ComparisonOperator.LESS_THAN_OR_EQUAL,
    ComparisonOperator.APPROX_MATCH,
    ComparisonOperator.PRESENT,
    ComparisonOperator.CONTAINS,
    ComparisonOperator.STARTS_WITH,
    ComparisonOperator.ENDS_WITH,
    ComparisonOperator.MATCHES,
    ComparisonOperator.IS_NULL,
    ComparisonOperator.IS_EMPTY,
    ComparisonOperator.INCLUDES,
    ComparisonOperator.INCLUDES_ANY,
    ComparisonOperator.BETWEEN,
    ComparisonOperator.WITHIN_DAYS,
    ComparisonOperator.YEAR,
  ];

  /**
   * Parses a token string and returns the corresponding ComparisonOperator
   * @param token The token to parse (e.g., "=", ":contains:")
   * @returns The matching ComparisonOperator
   * @throws Error if token is not recognized
   */
  static parse(token: string): ComparisonOperator {
    const operator = ComparisonOperator.ALL_OPERATORS.find(op => op.token === token);
    if (!operator) {
      throw new Error(`Unknown comparison operator: ${token}`);
    }
    return operator;
  }
}
