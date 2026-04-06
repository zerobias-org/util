export { Stack } from './Stack.js';
export { StackManager } from './StackManager.js';
export { StackEnvironment } from './StackEnvironment.js';
export { StackWatcher } from './StackWatcher.js';

export type {
  StackManifest,
  StackIdentity,
  DependencySpec,
  SubstackConfig,
  StateFieldSchema,
  CollectionStateConfig,
  LifecycleConfig,
  HealthCheckConfig,
  LogSourceConfig,
  SecretSchemaConfig,
  ImportAlias,
} from '../config.js';

export { isCollectionState } from '../config.js';

export type {
  Resolution,
  StackManifestEntry,
  ImportSpec,
  ExplainResult,
  StackStatus,
} from './types.js';
