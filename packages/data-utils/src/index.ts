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
export * from './schema/index.js';

// Validation utilities
export * from './validation/index.js';

// Transform utilities
export * from './transform/index.js';

// Data mapper (framework-agnostic)
// Export core mapper class
export { DataMapper } from './mapper/DataMapper.js';
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
} from './mapper/types/index.js';

// DataProducer client (framework-agnostic)
export * from './data-producer/index.js';

// Types
export * from './types/index.js';
