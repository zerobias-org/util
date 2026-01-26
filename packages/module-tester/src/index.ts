/**
 * @zerobias-org/module-tester
 *
 * Test harness for Hub modules - enables REST-level testing on Docker containers.
 *
 * @example Basic usage
 * ```typescript
 * import { ModuleTestHarness } from '@zerobias-org/module-tester';
 *
 * const harness = new ModuleTestHarness();
 *
 * // Start a module container
 * const deploymentId = await harness.start('@auditlogic/module-aws-s3', '1.0.0');
 *
 * // Get the HTTP client
 * const client = harness.getClient();
 *
 * // Invoke operations
 * const result = await harness.invoke({ operationId: 'listBuckets' });
 *
 * // Clean up
 * await harness.stop();
 * ```
 *
 * @example Using test profiles
 * ```typescript
 * import { ModuleTestHarness } from '@zerobias-org/module-tester';
 *
 * const harness = new ModuleTestHarness();
 *
 * // Load and start with a profile
 * await harness.startWithProfile('aws-s3');
 *
 * // Connect using profile's credentials
 * await harness.connect();
 *
 * // Run tests...
 *
 * await harness.stopAll();
 * ```
 *
 * @packageDocumentation
 */

// Framework entry point
export { moduleTest } from './moduleTest.js';
export type { ModuleTestOptions, TestClient, ClientFactory } from './moduleTest.js';

// Main classes
export { ModuleTestHarness, createTestHarness } from './ModuleTestHarness.js';
export { DockerManager, generateDeploymentId, generateAuthKey } from './DockerManager.js';
export { AuthManager, parseAuthHeaders } from './AuthManager.js';
export type { AuthSession, AuthManagerConfig } from './AuthManager.js';
export { TestProfileLoader, ProfileValidationError, createTestProfile } from './TestProfileLoader.js';
export type { TestProfileLoaderConfig } from './TestProfileLoader.js';

// Secrets providers
export {
  CompositeSecretsProvider,
  createAutoSecretsProvider
} from './providers/SecretsProvider.js';
export type { SecretsProvider } from './providers/SecretsProvider.js';

export { EnvSecretsProvider, setEnvSecret, clearEnvSecret } from './providers/EnvSecretsProvider.js';
export type { EnvSecretsProviderConfig } from './providers/EnvSecretsProvider.js';

export { FileSecretsProvider, createSecretFile, deleteSecretFile } from './providers/FileSecretsProvider.js';
export type { FileSecretsProviderConfig } from './providers/FileSecretsProvider.js';

export { ProfileResolver, createProfileResolver } from './providers/ProfileResolver.js';
export type { ProfileResolverConfig } from './providers/ProfileResolver.js';

// Types
export type {
  AuthProtocolVersion,
  DeploymentType,
  OperationalStatus,
  TestDeployment,
  HealthCheckResult,
  ModuleInfo,
  ModuleMetadata,
  ContainerStartOptions,
  ContainerStartResult,
  ConnectionProfile,
  TestProfile,
  InvokeRequest,
  InvokeResult,
  DockerManagerConfig,
  ModuleTestHarnessConfig,
  Logger
} from './types.js';

export { AUTH_HEADERS } from './types.js';
