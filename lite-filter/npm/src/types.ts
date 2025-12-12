/**
 * Options for the matches() method
 */
export interface MatchOptions {
  /**
   * Whether string comparisons should be case-sensitive
   * @default false
   */
  caseSensitive?: boolean;
}

/**
 * Adapter interface for translating expressions to other query languages
 */
export interface Adapter {
  /**
   * Converts an Expression to a string representation in the target query language
   * @param expr The expression to convert
   * @returns String representation in the target language
   */
  fromExpression(expr: Expression): string;
}

/**
 * Core Expression interface - represents a filter expression that can test objects
 */
export interface Expression {
  /**
   * Tests if an object matches this expression
   * @param obj The object to test
   * @param options Optional matching options
   * @returns true if the object matches, false otherwise
   */
  matches(obj: any, options?: MatchOptions): boolean;

  /**
   * Converts this expression to another query language using a registered adapter
   * @param key The adapter key (e.g., "SQL", "DynamoDB")
   * @returns String representation in the target language
   * @throws Error if adapter not found
   */
  as(key: string): string;
}
