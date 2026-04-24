/**
 * Adapter registry management
 */

import type { Adapter } from './types';

/**
 * Registry for adapters
 */
const adapterRegistry = new Map<string, { description: string; adapter: Adapter }>();

/**
 * Registers an adapter for translating expressions to other query languages
 * @param key The adapter key (e.g., "SQL", "DynamoDB")
 * @param description Human-readable description
 * @param adapter The adapter implementation
 */
export function addAdapter(key: string, description: string, adapter: Adapter): void {
  adapterRegistry.set(key, { description, adapter });
}

/**
 * Lists all registered adapters
 * @returns Array of adapter keys and descriptions
 */
export function listAdapters(): Array<{ key: string; description: string }> {
  return Array.from(adapterRegistry.entries()).map(([key, { description }]) => ({
    key,
    description,
  }));
}

/**
 * Gets an adapter by key
 * @param key The adapter key
 * @returns The adapter
 * @throws Error if adapter not found
 */
export function getAdapter(key: string): Adapter {
  const entry = adapterRegistry.get(key);
  if (!entry) {
    throw new Error(`Adapter not found: ${key}`);
  }
  return entry.adapter;
}
