/**
 * Types for FunctionsApi - function execution and management
 *
 * TODO: Implement function types when FunctionsApi is fully implemented
 */

/**
 * Function definition
 * TODO: Define full function structure based on DataProducer API
 */
export interface FunctionDef {
  /**
   * Function ID
   */
  id: string;

  /**
   * Function name
   */
  name: string;

  /**
   * Function description
   */
  description?: string;

  /**
   * Input parameter definitions
   */
  parameters?: FunctionParameter[];

  /**
   * Return type
   */
  returnType?: string;

  /**
   * Function metadata
   */
  metadata?: Record<string, any>;
}

/**
 * Function parameter definition
 * TODO: Refine based on actual FunctionsApi requirements
 */
export interface FunctionParameter {
  /**
   * Parameter name
   */
  name: string;

  /**
   * Parameter type
   */
  type: string;

  /**
   * Parameter description
   */
  description?: string;

  /**
   * Whether the parameter is required
   */
  required?: boolean;

  /**
   * Default value
   */
  defaultValue?: any;
}

/**
 * Function execution result
 * TODO: Define based on actual FunctionsApi response
 */
export interface FunctionResult {
  /**
   * Execution success status
   */
  success: boolean;

  /**
   * Result data
   */
  data?: any;

  /**
   * Error message if execution failed
   */
  error?: string;

  /**
   * Execution metadata (timing, etc.)
   */
  metadata?: Record<string, any>;
}
