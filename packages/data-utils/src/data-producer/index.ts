/**
 * DataProducer Client Module
 *
 * Framework-agnostic DataProducer client for accessing hierarchical objects,
 * tabular collections, and schema definitions.
 *
 * This module provides a unified interface for interacting with DataProducer APIs
 * and can be used in any JavaScript/TypeScript environment (Node.js, browsers, etc.).
 *
 * @example
 * ```typescript
 * import { DataProducerClient } from '@zerobias-org/data-utils';
 *
 * const client = new DataProducerClient({
 *   server: 'https://api.example.com',
 *   targetId: 'node-123',
 *   scopeId: 'boundary-456'
 * });
 *
 * await client.connect();
 * const root = await client.objects.getRoot();
 * const collections = await client.collections.getCollections();
 * await client.disconnect();
 * ```
 *
 * @packageDocumentation
 */

// Core client
export * from './DataProducerClient';

// API modules
export * from './apis';

// Type definitions
export * from './types';
