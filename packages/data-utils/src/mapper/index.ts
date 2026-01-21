/**
 * Data Mapper Module
 *
 * Framework-agnostic data mapping and transformation library.
 *
 * Main export for Node.js, React, Vue, and other frameworks:
 * ```typescript
 * import { DataMapper, MappingRule, SourceField } from '@zerobias-org/data-utils';
 * ```
 *
 * For Angular applications, use the angular export:
 * ```typescript
 * import { DataMapperService } from '@zerobias-org/data-utils/angular';
 * ```
 */

// Core mapper class
export { DataMapper } from './DataMapper';

// Export all types
export * from './types';
