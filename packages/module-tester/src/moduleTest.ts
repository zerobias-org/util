/**
 * moduleTest - Framework entry point for module testing
 *
 * Provides a declarative way to test Hub modules with automatic lifecycle management.
 *
 * @example
 * ```typescript
 * import { moduleTest } from '@zerobias-org/module-tester';
 * import type { GithubTestClient } from './generated/GithubTestClient.js';
 *
 * moduleTest<GithubTestClient>('github', ({ organization }) => {
 *   it('lists organizations', async () => {
 *     const orgs = await organization.listMyOrganizations({ page: 1 });
 *     expect(orgs.items.length).to.be.greaterThan(0);
 *   });
 * });
 * ```
 */

import * as path from 'path';
import * as fs from 'fs';
import { pathToFileURL } from 'url';
import { ModuleTestHarness, createTestHarness } from './ModuleTestHarness.js';
import { TestProfileLoader } from './TestProfileLoader.js';
import { ProfileResolver } from './providers/ProfileResolver.js';
import type { TestProfile, Logger } from './types.js';

/**
 * Options for moduleTest
 */
export interface ModuleTestOptions {
  /** Test profiles directory (default: ./test-profiles) */
  profilesDir?: string;
  /** Specific profile to use (overrides auto-detection) */
  profile?: string;
  /** Container startup timeout in ms (default: 120000) */
  timeout?: number;
  /** Enable debug logging */
  debug?: boolean;
}

/**
 * Test client interface - base type for generated or hand-written clients
 * Typed clients should extend this with specific API groups
 */
// eslint-disable-next-line @typescript-eslint/no-empty-interface
export interface TestClient {
  // Marker interface - actual clients define their API groups
}

/**
 * Client factory function signature
 */
export type ClientFactory<T extends TestClient = TestClient> = (
  harness: ModuleTestHarness,
  connectionId: string
) => T;

/**
 * Internal state for a module test suite
 */
interface ModuleTestState {
  harness: ModuleTestHarness;
  profile: TestProfile;
  deploymentId?: string;
  connectionId?: string;
  client?: TestClient;
}

/**
 * Get profile name from command line args or environment
 */
function getProfileOverride(): string | undefined {
  // Check npm config (npm run test:docker --profile=ci)
  if (process.env.npm_config_profile) {
    return process.env.npm_config_profile;
  }

  // Check command line args (--profile=ci or --profile ci)
  const args = process.argv;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith('--profile=')) {
      return arg.slice('--profile='.length);
    }
    if (arg === '--profile' && args[i + 1]) {
      return args[i + 1];
    }
  }

  return undefined;
}

/**
 * Detect if running in CI environment
 */
function isCi(): boolean {
  return process.env.CI === 'true' || process.env.GITHUB_ACTIONS === 'true';
}

/**
 * Discover and load test profile for a module
 */
async function discoverProfile(
  moduleName: string,
  options: ModuleTestOptions,
  logger: Logger
): Promise<TestProfile> {
  const profilesDir = options.profilesDir ?? './test-profiles';
  const profileOverride = options.profile ?? getProfileOverride();

  const loader = new TestProfileLoader({ profilesDir, logger });

  // If explicit profile specified, load it
  if (profileOverride) {
    logger.info(`Using profile override: ${profileOverride}`);
    return loader.loadProfile(profileOverride);
  }

  // Auto-detect based on environment
  const env = isCi() ? 'ci' : 'local';
  const profileName = `${moduleName}-${env}`;

  logger.info(`Auto-detecting profile: ${profileName}`);

  try {
    return await loader.loadProfile(profileName);
  } catch {
    // Fall back to module name without env suffix
    logger.info(`Profile ${profileName} not found, trying ${moduleName}`);
    return loader.loadProfile(moduleName);
  }
}

/**
 * Load client factory from test directory
 *
 * Loading order:
 * 1. test/client-factory.ts (developer-written, checked in)
 * 2. test/generated/{Module}TestClient.ts (from codegen)
 * 3. Error if neither exists
 */
async function loadClientFactory<T extends TestClient>(
  moduleName: string,
  logger: Logger
): Promise<ClientFactory<T>> {
  const testDir = './test';
  const pascalName = moduleName
    .split('-')
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');

  // 1. Try test/client-factory.ts (developer-written)
  const factoryPath = path.resolve(testDir, 'client-factory.js');
  if (fs.existsSync(factoryPath)) {
    logger.info(`Loading client factory from: ${factoryPath}`);
    const module = await import(pathToFileURL(factoryPath).href);
    if (typeof module.createTestClient === 'function') {
      return module.createTestClient as ClientFactory<T>;
    }
    throw new Error(`${factoryPath} must export createTestClient function`);
  }

  // Also check for .ts with ts-node
  const factoryTsPath = path.resolve(testDir, 'client-factory.ts');
  if (fs.existsSync(factoryTsPath)) {
    logger.info(`Loading client factory from: ${factoryTsPath}`);
    const module = await import(pathToFileURL(factoryTsPath).href);
    if (typeof module.createTestClient === 'function') {
      return module.createTestClient as ClientFactory<T>;
    }
    throw new Error(`${factoryTsPath} must export createTestClient function`);
  }

  // 2. Try test/generated/{Module}TestClient.ts
  const generatedPath = path.resolve(testDir, 'generated', `${pascalName}TestClient.js`);
  if (fs.existsSync(generatedPath)) {
    logger.info(`Loading generated client from: ${generatedPath}`);
    const module = await import(pathToFileURL(generatedPath).href);
    if (typeof module.createTestClient === 'function') {
      return module.createTestClient as ClientFactory<T>;
    }
    throw new Error(`${generatedPath} must export createTestClient function`);
  }

  // Also check for .ts
  const generatedTsPath = path.resolve(testDir, 'generated', `${pascalName}TestClient.ts`);
  if (fs.existsSync(generatedTsPath)) {
    logger.info(`Loading generated client from: ${generatedTsPath}`);
    const module = await import(pathToFileURL(generatedTsPath).href);
    if (typeof module.createTestClient === 'function') {
      return module.createTestClient as ClientFactory<T>;
    }
    throw new Error(`${generatedTsPath} must export createTestClient function`);
  }

  // 3. Neither exists - error
  throw new Error(
    `No client factory found for module "${moduleName}".\n` +
    `Create one of:\n` +
    `  - test/client-factory.ts (export function createTestClient(harness, connectionId))\n` +
    `  - Run 'npm run generate:test-client' to generate test/generated/${pascalName}TestClient.ts`
  );
}

/**
 * Resolve secrets in connection profile
 */
async function resolveConnectionProfile(
  profile: TestProfile,
  logger: Logger
): Promise<Record<string, unknown>> {
  const resolver = new ProfileResolver({ logger });

  if (profile.connection.profile) {
    // Resolve any secret references in the profile
    const resolved = await resolver.resolve(profile.connection.profile);
    return {
      ...resolved,
      type: profile.connection.profileType
    };
  }

  throw new Error(`Profile ${profile.name} has no connection configuration`);
}

/**
 * moduleTest - Framework entry point
 *
 * @param moduleName - Module short name (matches profile: test-profiles/{name}*.yml)
 * @param testFn - Test function receiving typed client
 */
export function moduleTest<T extends TestClient = TestClient>(
  moduleName: string,
  testFn: (client: T) => void
): void;

/**
 * moduleTest - Framework entry point with options
 *
 * @param moduleName - Module short name
 * @param options - Test options
 * @param testFn - Test function receiving typed client
 */
export function moduleTest<T extends TestClient = TestClient>(
  moduleName: string,
  options: ModuleTestOptions,
  testFn: (client: T) => void
): void;

/**
 * moduleTest implementation
 */
export function moduleTest<T extends TestClient = TestClient>(
  moduleName: string,
  optionsOrTestFn: ModuleTestOptions | ((client: T) => void),
  maybeTestFn?: (client: T) => void
): void {
  // Parse overloaded arguments
  const options: ModuleTestOptions = typeof optionsOrTestFn === 'function' ? {} : optionsOrTestFn;
  const testFn = typeof optionsOrTestFn === 'function' ? optionsOrTestFn : maybeTestFn!;

  // Create logger
  const logger: Logger = options.debug
    ? {
        debug: (msg, ...args) => console.debug(`[moduleTest] ${msg}`, ...args),
        info: (msg, ...args) => console.info(`[moduleTest] ${msg}`, ...args),
        warn: (msg, ...args) => console.warn(`[moduleTest] ${msg}`, ...args),
        error: (msg, ...args) => console.error(`[moduleTest] ${msg}`, ...args)
      }
    : {
        debug: () => {},
        info: (msg, ...args) => console.info(`[moduleTest] ${msg}`, ...args),
        warn: (msg, ...args) => console.warn(`[moduleTest] ${msg}`, ...args),
        error: (msg, ...args) => console.error(`[moduleTest] ${msg}`, ...args)
      };

  // State shared across hooks
  const state: Partial<ModuleTestState> = {};

  // Create a proxy that defers property access until the client is ready
  // This allows destructuring in the test function even though client isn't set yet
  const clientProxy = new Proxy({} as T, {
    get(_target, prop: string) {
      // Return another proxy for the API group that defers method calls
      return new Proxy({}, {
        get(_target, method: string) {
          // Return a function that calls the actual method when invoked
          return async (...args: unknown[]) => {
            if (!state.client) {
              throw new Error(`Client not initialized. Ensure tests run after before() hook.`);
            }
            const apiGroup = (state.client as Record<string, Record<string, unknown>>)[prop];
            if (!apiGroup) {
              throw new Error(`Unknown API group: ${prop}`);
            }
            const fn = apiGroup[method];
            if (typeof fn !== 'function') {
              throw new Error(`Unknown method: ${prop}.${method}`);
            }
            return fn(...args);
          };
        }
      });
    }
  });

  // Wrap in Mocha describe block
  describe(`Module: ${moduleName}`, function () {
    // Set timeout for container operations
    this.timeout(options.timeout ?? 180000);

    before(async function () {
      // 1. Create harness
      state.harness = createTestHarness({
        debug: options.debug,
        cleanup: true,
        insecure: false,  // Always use HTTPS in production
        profilesDir: options.profilesDir
      });

      // 2. Check Docker availability
      const dockerAvailable = await state.harness.isDockerAvailable();
      if (!dockerAvailable) {
        logger.warn('Docker not available, skipping module tests');
        this.skip();
        return;
      }

      // 3. Discover and load profile
      try {
        state.profile = await discoverProfile(moduleName, options, logger);
      } catch (err) {
        logger.error(`Failed to load profile: ${(err as Error).message}`);
        this.skip();
        return;
      }

      // 4. Check skip conditions
      if (isCi() && state.profile.skipCi) {
        logger.info(`Skipping in CI: ${state.profile.name}`);
        this.skip();
        return;
      }
      if (!isCi() && state.profile.skipLocal) {
        logger.info(`Skipping locally: ${state.profile.name}`);
        this.skip();
        return;
      }

      // 5. Start container
      logger.info(`Starting module: ${state.profile.module}@${state.profile.version}`);
      state.deploymentId = await state.harness.start(
        state.profile.module,
        state.profile.version ?? 'latest',
        state.profile.image,
        { environment: state.profile.environment }
      );

      // 6. Wait for health
      const health = await state.harness.healthCheck(state.deploymentId);
      if (!health.healthy) {
        throw new Error(`Container unhealthy: ${health.error}`);
      }

      // 7. Resolve connection profile and connect
      const connectionProfile = await resolveConnectionProfile(state.profile, logger);
      state.connectionId = `conn-${Date.now()}`;

      logger.info(`Creating connection: ${state.connectionId}`);
      const httpClient = state.harness.getClient(state.deploymentId);
      const response = await httpClient.post('/connections', {
        connectionId: state.connectionId,
        connectionProfile
      });

      if (response.status !== 200) {
        throw new Error(`Connection failed: ${response.status}`);
      }

      // 8. Load and create typed client
      const factory = await loadClientFactory<T>(moduleName, logger);
      state.client = factory(state.harness, state.connectionId);

      logger.info('Module ready for testing');
    });

    after(async function () {
      if (state.harness && state.deploymentId) {
        logger.info('Cleaning up...');
        await state.harness.stop(state.deploymentId);
      }
    });

    // Run user's tests with the proxy client
    // The proxy defers actual calls until the real client is ready
    testFn(clientProxy);
  });
}
