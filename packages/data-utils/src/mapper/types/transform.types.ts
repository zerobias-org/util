import { ValidationRule, ValidationTiming } from './validation.types';

/**
 * Transform types available for mapping
 *
 * Core transforms provide essential data mapping functionality.
 * For advanced operations (string manipulation, date math, array operations, etc.),
 * use the 'expression' transform with JSONata expressions.
 */
export type TransformType =
  | 'direct'        // Simple copy from source to destination
  | 'convert'       // Convert data type (string/number/date/boolean)
  | 'combine'       // Combine multiple source fields
  | 'split'         // Split string into array
  | 'expression'    // JSONata expression (for advanced operations)
  | 'default'       // Provide default value for undefined/empty
  | 'conditional'   // If/then/else logic
  | 'lookup';       // Dictionary/mapping table lookup

/**
 * Data types for conversion
 */
export type DataType = 'string' | 'number' | 'date' | 'boolean';

/**
 * Conditional operators for conditional transform
 */
export type ConditionalOperator = 'equals' | 'notEquals' | 'greaterThan' | 'lessThan' | 'contains' | 'isEmpty' | 'isNotEmpty';

/**
 * Logical operators for combining conditions
 */
export type LogicalOperator = 'AND' | 'OR';

/**
 * Advanced conditional logic with support for nested conditions
 */
export interface ConditionalLogic {
  /** Single condition */
  operator?: ConditionalOperator;
  value?: any;
  /** Nested conditions for AND/OR logic */
  logicalOperator?: LogicalOperator;
  conditions?: ConditionalLogic[];
}

/**
 * Post-processing modifiers that can be applied after the main transform
 */
export type ModifierType =
  // String modifiers
  | 'uppercase'
  | 'lowercase'
  | 'capitalize'
  | 'trim'
  | 'reverse'
  | 'padLeft'
  | 'padRight'
  | 'slugify'
  // Number modifiers
  | 'round'
  | 'round2'
  | 'floor'
  | 'ceil'
  | 'abs'
  | 'formatCurrency'
  | 'pow'
  | 'sqrt'
  | 'log'
  | 'percentage'
  // Date modifiers
  | 'formatDate'
  | 'dateOnly'
  | 'timeOnly'
  | 'toTimestamp'
  | 'addDays'
  | 'subtractDays'
  | 'extractYear'
  | 'extractMonth'
  | 'extractDay'
  | 'extractHour'
  | 'extractMinute'
  // Array modifiers
  | 'first'
  | 'last'
  | 'unique'
  | 'length'
  | 'arrayReverse'
  | 'join'
  | 'slice';

/**
 * Parameterized modifier with runtime configuration
 */
export interface ParameterizedModifier {
  /** Type of modifier */
  type: ModifierType;
  /** Parameters for the modifier */
  params?: {
    // String modifier params
    /** For padLeft/padRight - target length */
    length?: number;
    /** For padLeft/padRight - character to pad with */
    padChar?: string;

    // Number modifier params
    /** For round, percentage - number of decimal places */
    decimals?: number;
    /** For pow - exponent value */
    exponent?: number;
    /** For log - logarithm base */
    base?: number;
    /** For percentage - total/base value */
    total?: number;
    /** For formatCurrency - currency code (USD, EUR, etc.) */
    currency?: string;
    /** For formatCurrency - locale (en-US, de-DE, etc.) */
    locale?: string;

    // Date modifier params
    /** For formatDate modifier - date format pattern */
    dateFormat?: string;
    /** For addDays/subtractDays - number of days */
    days?: number;

    // Array modifier params
    /** For join - separator string */
    separator?: string;
    /** For slice - start index */
    start?: number;
    /** For slice - end index */
    end?: number;
  };
}

/**
 * Configuration for a field transformation
 */
export interface TransformConfig {
  /** Type of transformation to apply */
  type: TransformType;
  /** Additional options specific to the transform type */
  options?: {
    // === CONVERT transform ===
    /** Target data type for 'convert' transform */
    dataType?: DataType;

    // === COMBINE transform ===
    /** Separator string for 'combine' transform (e.g., " ", ", ", "-") */
    combineWith?: string;

    // === SPLIT transform ===
    /** Delimiter string for 'split' transform (e.g., ",", "|") */
    splitOn?: string;

    // === EXPRESSION transform ===
    /** JSONata expression for 'expression' transform */
    expression?: string;

    // === DEFAULT transform ===
    /** Default value for 'default' transform */
    defaultValue?: any;
    /** Apply default on null values */
    applyOnNull?: boolean;
    /** Apply default on empty strings */
    applyOnEmpty?: boolean;

    // === CONDITIONAL transform ===
    /** Conditional operator for 'conditional' transform */
    conditionOperator?: ConditionalOperator;
    /** Value to compare against for conditional */
    conditionValue?: any;
    /** Value to use when condition is true */
    trueValue?: any;
    /** Value to use when condition is false */
    falseValue?: any;
    /** Advanced conditional logic with nested conditions */
    advancedCondition?: ConditionalLogic;
    /** Switch/case-style mapping */
    switchCases?: Array<{ condition: any; value: any }>;
    /** Default value for switch (when no cases match) */
    switchDefault?: any;

    // === LOOKUP transform ===
    /** Lookup table for 'lookup' transform */
    lookupTable?: Record<string, any>;
    /** Default value when lookup key not found */
    lookupDefault?: any;
  };
  /** Post-processing modifiers applied after main transform */
  modifiers?: ModifierType[];
  /** Parameterized modifiers with runtime configuration */
  parameterizedModifiers?: ParameterizedModifier[];
  /** Validation rules to apply */
  validationRules?: ValidationRule[];
  /** When to apply validation */
  validationTiming?: ValidationTiming;
}
