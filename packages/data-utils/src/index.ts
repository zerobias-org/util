/**
 * @zerobias-org/data-utils
 *
 * Utility library for DataProducer implementations and data mapping.
 * Provides schema generation, validation, type mapping, and data transformation utilities.
 *
 * @packageDocumentation
 */

/** Package version */
export const VERSION = '0.6.0-rc.5';

// Schema utilities
export * from './schema';

// Validation utilities
export * from './validation';

// Transform utilities
export * from './transform';

// Data mapper (framework-agnostic)
// Export core mapper class
export { DataMapper } from './mapper/DataMapper';
// Export mapper types explicitly to avoid conflicts with transform types
export type {
  SourceField,
  DestinationField,
  MappingRule,
  MappingResult,
  ErrorHandlingStrategy,
  TransformType,
  TransformConfig,
  ModifierType,
  ParameterizedModifier,
  ConditionalLogic,
  ConditionalOperator,
  LogicalOperator,
  ValidationRule,
  ValidationType,
  ValidationTiming
} from './mapper/types';

// DataProducer client (framework-agnostic)
export * from './data-producer';

// Types
export * from './types';
