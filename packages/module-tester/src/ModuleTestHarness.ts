/**
 * ModuleTestHarness - Main orchestration class for module testing
 *
 * Combines DockerManager, AuthManager, SecretsProvider, and TestProfileLoader
 * to provide a complete test infrastructure for Hub modules.
 *
 * Usage:
 * ```typescript
 * const harness = new ModuleTestHarness();
 * await harness.start('@auditlogic/module-aws-s3', '1.0.0');
 * const client = harness.getClient();
 * const result = await client.post('/operations/listBuckets', {});
 * await harness.stop();
 * ```
 */

import type { AxiosInstance, AxiosResponse } from 'axios';
import { DockerManager, generateDeploymentId, generateAuthKey } from './DockerManager.js';
import { AuthManager } from './AuthManager.js';
import { TestProfileLoader } from './TestProfileLoader.js';
import { createAutoSecretsProvider } from './providers/SecretsProvider.js';
import type {
  ModuleTestHarnessConfig,
  TestDeployment,
  TestProfile,
  ConnectionProfile,
  InvokeRequest,
  InvokeResult,
  SecretsProvider,
  Logger,
  ContainerStartOptions,
  HealthCheckResult
} from './types.js';

/**
 * Default configuration values
 */
const DEFAULTS = {
  CONTAINER_TIMEOUT: 120_000, // 2 minutes
  CLEANUP: true,
  DEBUG: false,
  IS_CI: process.env.CI === 'true' || process.env.GITHUB_ACTIONS === 'true'
} as const;

/**
 * Module connection state
 */
interface ConnectionState {
  deployment: TestDeployment;
  port: number;
  client: AxiosInstance;
  profile?: TestProfile;
  connectionProfile?: ConnectionProfile;
}

/**
 * ModuleTestHarness provides a complete test infrastructure for Hub modules
 */
export class ModuleTestHarness {
  private config: Required<ModuleTestHarnessConfig>;
  private logger: Logger;
  private dockerManager: DockerManager;
  private authManager: AuthManager;
  private profileLoader: TestProfileLoader;
  private secretsProvider: SecretsProvider;
  private connections: Map<string, ConnectionState> = new Map();
  private defaultConnection?: string;

  constructor(config: ModuleTestHarnessConfig = {}) {
    this.logger = config.debug ? this.createDebugLogger() : this.createDefaultLogger();

    this.config = {
      docker: config.docker ?? {},
      secretsProvider: config.secretsProvider ?? createAutoSecretsProvider(this.logger),
      profilesDir: config.profilesDir ?? './test-profiles',
      isCi: config.isCi ?? DEFAULTS.IS_CI,
      containerTimeout: config.containerTimeout ?? DEFAULTS.CONTAINER_TIMEOUT,
      cleanup: config.cleanup ?? DEFAULTS.CLEANUP,
      debug: config.debug ?? DEFAULTS.DEBUG,
      insecure: config.insecure ?? true, // Default to insecure for test harness convenience
      authVersion: config.authVersion ?? 'v1' // Default to V1 (current modules)
    };

    this.secretsProvider = this.config.secretsProvider;
    this.dockerManager = new DockerManager(this.config.docker, this.logger);
    this.authManager = new AuthManager({
      logger: this.logger,
      authVersion: this.config.authVersion
    });
    this.profileLoader = new TestProfileLoader({
      profilesDir: this.config.profilesDir,
      logger: this.logger
    });
  }

  /**
   * Check if Docker is available
   */
  async isDockerAvailable(): Promise<boolean> {
    return this.dockerManager.isAvailable();
  }

  /**
   * Start a module container
   *
   * @param module Module package name (e.g., "@auditlogic/module-aws-s3")
   * @param version Module version
   * @param image Docker image (optional, derived from module if not specified)
   * @param options Container start options
   * @returns Deployment ID
   */
  async start(
    module: string,
    version: string,
    image?: string,
    options: ContainerStartOptions = {}
  ): Promise<string> {
    // Check Docker availability
    if (!(await this.isDockerAvailable())) {
      throw new Error('Docker is not available. Please ensure Docker is running.');
    }

    // Generate deployment ID and auth key
    const deploymentId = generateDeploymentId();
    const authKey = generateAuthKey();

    // Derive image from module if not specified
    const resolvedImage = image ?? this.deriveImageFromModule(module, version);

    // Create deployment
    const deployment: TestDeployment = {
      id: deploymentId,
      type: 'container',
      module,
      version,
      image: resolvedImage,
      authKey,
      status: 'pending'
    };

    this.logger.info(`Starting module: ${module}@${version}`);

    // Start container - use insecure mode from config
    const result = await this.dockerManager.startContainer(deployment, {
      ...options,
      healthCheckTimeout: options.healthCheckTimeout ?? this.config.containerTimeout,
      insecure: this.config.insecure
    });

    deployment.port = result.port;
    deployment.containerId = result.containerId;
    deployment.status = 'up';

    // Create authenticated client - use HTTP in insecure mode, HTTPS otherwise
    const protocol = this.config.insecure ? 'http' : 'https';
    const client = this.authManager.createClient(deployment, `${protocol}://localhost:${result.port}`);

    // Store connection state
    const state: ConnectionState = {
      deployment,
      port: result.port,
      client
    };

    this.connections.set(deploymentId, state);

    // Set as default if first connection
    if (!this.defaultConnection) {
      this.defaultConnection = deploymentId;
    }

    this.logger.info(`Module started: ${module}@${version} on port ${result.port}`);

    return deploymentId;
  }

  /**
   * Start a module using a test profile
   *
   * @param profileName Profile name or TestProfile object
   * @returns Deployment ID
   */
  async startWithProfile(profileName: string | TestProfile): Promise<string> {
    // Load profile if string
    const profile = typeof profileName === 'string'
      ? await this.profileLoader.loadProfile(profileName)
      : profileName;

    // Resolve connection profile from secrets if needed
    let connectionProfile: ConnectionProfile;

    if (profile.connection.secretsPath) {
      const secrets = await this.secretsProvider.getSecret(profile.connection.secretsPath);
      connectionProfile = {
        ...secrets,
        type: profile.connection.profileType
      } as ConnectionProfile;
    } else if (profile.connection.profile) {
      connectionProfile = {
        ...profile.connection.profile,
        type: profile.connection.profileType
      } as ConnectionProfile;
    } else {
      throw new Error(`Profile ${profile.name} has no connection configuration`);
    }

    // Start the container
    const deploymentId = await this.start(
      profile.module,
      profile.version ?? 'latest',
      profile.image,
      { environment: profile.environment }
    );

    // Store profile and connection info
    const state = this.connections.get(deploymentId)!;
    state.profile = profile;
    state.connectionProfile = connectionProfile;

    return deploymentId;
  }

  /**
   * Connect to a running module (call the connect operation)
   *
   * @param deploymentId Deployment ID (optional, uses default)
   * @returns Connection result
   */
  async connect(deploymentId?: string): Promise<InvokeResult> {
    const state = this.getState(deploymentId);

    if (!state.connectionProfile) {
      throw new Error('No connection profile available. Use startWithProfile() or set connectionProfile manually.');
    }

    return this.invoke({
      operationId: 'connect',
      body: state.connectionProfile
    }, deploymentId);
  }

  /**
   * Disconnect from a module (call the disconnect operation)
   *
   * @param deploymentId Deployment ID (optional, uses default)
   */
  async disconnect(deploymentId?: string): Promise<InvokeResult> {
    return this.invoke({
      operationId: 'disconnect'
    }, deploymentId);
  }

  /**
   * Invoke a module method via REST API
   *
   * Used by generated/hand-written test clients to translate typed method calls
   * to REST calls: client.organization.listMyOrganizations({ page: 1 })
   *   -> invokeMethod('OrganizationApi', 'listMyOrganizations', { page: 1 }, connectionId)
   *
   * @param apiClass API class name (e.g., 'OrganizationApi')
   * @param method Method name (e.g., 'listMyOrganizations')
   * @param argMap Method arguments
   * @param connectionId Connection ID for the request
   * @param deploymentId Deployment ID (optional, uses default)
   * @returns Method result
   */
  async invokeMethod<T = unknown>(
    apiClass: string,
    method: string,
    argMap: Record<string, unknown>,
    connectionId: string,
    deploymentId?: string
  ): Promise<T> {
    const state = this.getState(deploymentId);
    const url = `/connections/${connectionId}/${apiClass}.${method}`;

    this.logger.debug(`Invoking: ${apiClass}.${method}`);

    try {
      const response = await state.client.post<T>(url, { argMap });

      // Handle streaming or JSON response
      if (typeof response.data === 'string') {
        try {
          return JSON.parse(response.data) as T;
        } catch {
          return response.data as T;
        }
      }
      return response.data;
    } catch (error: unknown) {
      const axiosError = error as {
        response?: { status: number; data?: unknown };
        message: string;
      };

      // Re-throw with more context
      const errorMsg = axiosError.response?.data
        ? JSON.stringify(axiosError.response.data)
        : axiosError.message;
      throw new Error(`${apiClass}.${method} failed: ${errorMsg}`);
    }
  }

  /**
   * Invoke a module operation
   *
   * @param request Invocation request
   * @param deploymentId Deployment ID (optional, uses default)
   * @returns Invocation result
   */
  async invoke<T = unknown>(
    request: InvokeRequest,
    deploymentId?: string
  ): Promise<InvokeResult<T>> {
    const state = this.getState(deploymentId);
    const startTime = Date.now();

    try {
      const url = `/operations/${request.operationId}`;
      let response: AxiosResponse<T>;

      response = await (request.body === undefined ? state.client.get<T>(url, {
          params: request.parameters
        }) : state.client.post<T>(url, request.body, {
          params: request.parameters
        }));

      return {
        success: true,
        data: response.data,
        statusCode: response.status,
        responseTimeMs: Date.now() - startTime
      };
    } catch (error: unknown) {
      const axiosError = error as {
        response?: { status: number; data?: unknown };
        message: string;
      };

      return {
        success: false,
        error: axiosError.message,
        statusCode: axiosError.response?.status ?? 0,
        responseTimeMs: Date.now() - startTime,
        data: axiosError.response?.data as T | undefined
      };
    }
  }

  /**
   * Get the HTTP client for direct API calls
   *
   * @param deploymentId Deployment ID (optional, uses default)
   */
  getClient(deploymentId?: string): AxiosInstance {
    return this.getState(deploymentId).client;
  }

  /**
   * Get the deployment info
   *
   * @param deploymentId Deployment ID (optional, uses default)
   */
  getDeployment(deploymentId?: string): TestDeployment {
    return this.getState(deploymentId).deployment;
  }

  /**
   * Get the allocated port
   *
   * @param deploymentId Deployment ID (optional, uses default)
   */
  getPort(deploymentId?: string): number {
    return this.getState(deploymentId).port;
  }

  /**
   * Perform a health check
   *
   * @param deploymentId Deployment ID (optional, uses default)
   */
  async healthCheck(deploymentId?: string): Promise<HealthCheckResult> {
    const state = this.getState(deploymentId);
    return this.dockerManager.healthCheck(state.deployment, state.port, { useHttps: !this.config.insecure });
  }

  /**
   * Get container logs
   *
   * @param deploymentId Deployment ID (optional, uses default)
   * @param tail Number of lines to return
   */
  async getLogs(deploymentId?: string, tail?: number): Promise<string> {
    const state = this.getState(deploymentId);
    return this.dockerManager.getLogs(state.deployment.id, tail);
  }

  /**
   * Stop a module container
   *
   * @param deploymentId Deployment ID (optional, stops default)
   */
  async stop(deploymentId?: string): Promise<void> {
    const id = deploymentId ?? this.defaultConnection;

    if (!id) {
      this.logger.warn('No deployment to stop');
      return;
    }

    const state = this.connections.get(id);
    if (!state) {
      this.logger.warn(`Deployment not found: ${id}`);
      return;
    }

    this.logger.info(`Stopping deployment: ${id}`);

    await this.dockerManager.stopContainer(id);
    this.authManager.removeSession(id);
    this.connections.delete(id);

    if (this.defaultConnection === id) {
      // Set new default to first remaining connection
      this.defaultConnection = this.connections.keys().next().value;
    }
  }

  /**
   * Stop all running containers
   */
  async stopAll(): Promise<void> {
    const deploymentIds = [...this.connections.keys()];

    for (const id of deploymentIds) {
      await this.stop(id);
    }
  }

  /**
   * Clean up all resources (called automatically if cleanup is enabled)
   */
  async cleanup(): Promise<void> {
    if (this.config.cleanup) {
      await this.stopAll();
    }
  }

  /**
   * Set the connection profile for a deployment
   *
   * @param connectionProfile Connection profile
   * @param deploymentId Deployment ID (optional, uses default)
   */
  setConnectionProfile(connectionProfile: ConnectionProfile, deploymentId?: string): void {
    const state = this.getState(deploymentId);
    state.connectionProfile = connectionProfile;
  }

  /**
   * Load all test profiles
   */
  async loadProfiles(): Promise<TestProfile[]> {
    return this.profileLoader.loadProfilesForEnvironment(this.config.isCi);
  }

  /**
   * Check if running in CI environment
   */
  isCi(): boolean {
    return this.config.isCi;
  }

  /**
   * Get active deployment IDs
   */
  getActiveDeployments(): string[] {
    return [...this.connections.keys()];
  }

  /**
   * Get the state for a deployment
   */
  private getState(deploymentId?: string): ConnectionState {
    const id = deploymentId ?? this.defaultConnection;

    if (!id) {
      throw new Error('No deployment specified and no default deployment available');
    }

    const state = this.connections.get(id);

    if (!state) {
      throw new Error(`Deployment not found: ${id}`);
    }

    return state;
  }

  /**
   * Derive Docker image from module name
   * Convention: @scope/module-name -> pkg.ci.zerobias.com/scope-module-name:version
   */
  private deriveImageFromModule(module: string, version: string): string {
    // Remove @ prefix and replace / with -
    const imageName = module
      .replace(/^@/, '')
      .replaceAll('/', '-');

    return `pkg.ci.zerobias.com/${imageName}:${version}`;
  }

  /**
   * Create debug logger (verbose)
   */
  private createDebugLogger(): Logger {
    return {
      debug: (msg: string, ...args: unknown[]) => console.debug(`[Harness] ${msg}`, ...args),
      info: (msg: string, ...args: unknown[]) => console.info(`[Harness] ${msg}`, ...args),
      warn: (msg: string, ...args: unknown[]) => console.warn(`[Harness] ${msg}`, ...args),
      error: (msg: string, ...args: unknown[]) => console.error(`[Harness] ${msg}`, ...args)
    };
  }

  /**
   * Create default logger (info and above)
   */
  private createDefaultLogger(): Logger {
    return {
      debug: () => {}, // No-op
      info: (msg: string, ...args: unknown[]) => console.info(`[Harness] ${msg}`, ...args),
      warn: (msg: string, ...args: unknown[]) => console.warn(`[Harness] ${msg}`, ...args),
      error: (msg: string, ...args: unknown[]) => console.error(`[Harness] ${msg}`, ...args)
    };
  }
}

/**
 * Create a test harness with automatic cleanup on process exit
 */
export function createTestHarness(config?: ModuleTestHarnessConfig): ModuleTestHarness {
  const harness = new ModuleTestHarness(config);

  // Register cleanup handlers
  const cleanup = async () => {
    await harness.cleanup();
  };

  process.on('exit', () => {
    // Sync cleanup on exit
    harness.stopAll().catch(() => {});
  });

  process.on('SIGINT', async () => {
    await cleanup();
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    await cleanup();
    process.exit(0);
  });

  return harness;
}
