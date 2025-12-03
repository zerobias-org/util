/**
 * Hub API Client Base Package
 *
 * Provides base classes and utilities for all Hub API clients.
 * Eliminates code duplication across generated clients.
 *
 * @packageDocumentation
 */

// Base classes
export { BaseApiClient } from './BaseApiClient.js';
export { BaseConnector } from './BaseConnector.js';

// Utilities
export { jwt, apiKey } from './AuthUtils.js';
export { ensureRequestPrototype } from './PipelineUtil.js';

// Observability
export { RequestInspector } from './RequestInspector.js';
export type {
  RequestRecord,
  RequestCallback,
  ResponseCallback,
  ErrorCallback
} from './RequestInspector.js';

// Export local types
export type { ConnectionProfile } from './types.js';

// Re-export commonly used types from dependencies
export type {
  ConnectionMetadata,
  ConnectionStatus,
  ConnectionStatusDef
} from '@zerobias-org/types-core-js';

export type {
  ApiInvoker,
  RequestPrototype,
  ResponsePrototype
} from '@zerobias-org/util-api-invoker-api';
