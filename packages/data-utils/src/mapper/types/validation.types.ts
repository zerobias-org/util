/**
 * Validation types for pre/post-transform validation
 */
export type ValidationType =
  | 'required'
  | 'minLength'
  | 'maxLength'
  | 'min'
  | 'max'
  | 'pattern'
  | 'email'
  | 'url'
  | 'custom';

/**
 * Validation rule for field values
 */
export interface ValidationRule {
  /** Type of validation */
  type: ValidationType;
  /** Configuration for the validation */
  config?: {
    /** For minLength/maxLength - length value */
    length?: number;
    /** For min/max - numeric value */
    value?: number;
    /** For pattern - regex pattern */
    pattern?: string;
    /** For custom - custom validation function name */
    customFunction?: string;
  };
  /** Error message to display when validation fails */
  errorMessage?: string;
  /** Whether to apply this validation (can be conditional) */
  enabled?: boolean;
}

/**
 * When to apply validation rules
 */
export type ValidationTiming = 'pre-transform' | 'post-transform' | 'both';
