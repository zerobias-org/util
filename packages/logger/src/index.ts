// New hierarchical logger API (v2.0.0)
export { LoggerEngine } from './LoggerEngine.js';
export { LogLevel, LOG_LEVEL_METADATA } from './LogLevel.js';
export type { LoggerOptions, LogEvent, TransportOptions } from './types.js';
export { ParentTransport } from './ParentTransport.js';

// Deprecated - will be removed in v3.0.0
export { Logger } from './Logger.js';
