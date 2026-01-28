/**
 * DockerManager - Container lifecycle management for module testing
 *
 * Handles building, starting, stopping, and health checking of module containers.
 * Implements the same Docker operations as Hub Node for consistent behavior.
 */

import Docker from 'dockerode';
import getPort from 'get-port';
import https from 'node:https';
import axios, { type AxiosInstance } from 'axios';
import { v4 as uuidv4 } from 'uuid';
import type {
  DockerManagerConfig,
  TestDeployment,
  ContainerStartOptions,
  ContainerStartResult,
  HealthCheckResult,
  ModuleInfo,
  Logger,
  AuthProtocolVersion
} from './types.js';
import { AUTH_HEADERS } from './types.js';

/**
 * Default configuration values
 */
const DEFAULTS = {
  SOCKET_PATH: '/var/run/docker.sock',
  HEALTH_CHECK_TIMEOUT: 60_000, // 60 seconds
  HEALTH_CHECK_INTERVAL: 500, // 500ms between checks
  PULL_TIMEOUT: 300_000, // 5 minutes
  CONTAINER_PORT: 8888, // Module containers listen on this port
  STOP_TIMEOUT: 10 // 10 seconds graceful shutdown
} as const;

/**
 * DockerManager handles Docker container lifecycle for module testing
 */
export class DockerManager {
  private docker: Docker;
  private config: Required<DockerManagerConfig>;
  private logger: Logger;
  private runningContainers: Map<string, string> = new Map(); // deploymentId -> containerId

  constructor(config: DockerManagerConfig = {}, logger?: Logger) {
    this.config = {
      socketPath: config.socketPath ?? DEFAULTS.SOCKET_PATH,
      host: config.host ?? '',
      port: config.port ?? 2375,
      tls: config.tls ?? false,
      pullTimeout: config.pullTimeout ?? DEFAULTS.PULL_TIMEOUT,
      healthCheckTimeout: config.healthCheckTimeout ?? DEFAULTS.HEALTH_CHECK_TIMEOUT
    };

    this.logger = logger ?? this.createDefaultLogger();

    // Initialize Docker client
    this.docker = this.config.host ? new Docker({
        host: this.config.host,
        port: this.config.port,
        protocol: this.config.tls ? 'https' : 'http'
      }) : new Docker({ socketPath: this.config.socketPath });
  }

  /**
   * Check if Docker is available
   */
  async isAvailable(): Promise<boolean> {
    try {
      await this.docker.ping();
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Pull a Docker image
   */
  async pullImage(image: string): Promise<void> {
    this.logger.info(`Pulling image: ${image}`);

    return new Promise((resolve, reject) => {
      this.docker.pull(image, (err: Error | null, stream: NodeJS.ReadableStream) => {
        if (err) {
          reject(new Error(`Failed to pull image ${image}: ${err.message}`));
          return;
        }

        // Follow the pull progress
        this.docker.modem.followProgress(
          stream,
          (pullErr: Error | null) => {
            if (pullErr) {
              reject(new Error(`Failed to pull image ${image}: ${pullErr.message}`));
            } else {
              this.logger.info(`Successfully pulled image: ${image}`);
              resolve();
            }
          },
          (event: { status?: string; progress?: string }) => {
            if (event.status) {
              this.logger.debug(`Pull progress: ${event.status} ${event.progress ?? ''}`);
            }
          }
        );
      });
    });
  }

  /**
   * Check if an image exists locally
   */
  async imageExists(image: string): Promise<boolean> {
    try {
      const img = this.docker.getImage(image);
      await img.inspect();
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Start a module container
   */
  async startContainer(
    deployment: TestDeployment,
    options: ContainerStartOptions = {}
  ): Promise<ContainerStartResult> {
    const { module: moduleName, version, image, authKey, id: deploymentId } = deployment;
    // Default to insecure mode for test harness convenience
    const insecure = options.insecure ?? true;

    this.logger.info(`Starting container for ${moduleName}:${version} (${insecure ? 'HTTP' : 'HTTPS'})`);

    // Allocate a port
    const port = await getPort();

    // Ensure image exists
    if (options.forcePull || !(await this.imageExists(image))) {
      await this.pullImage(image);
    }

    // Prepare environment variables
    const env = this.buildEnvironment(deploymentId, authKey, insecure, options.environment);

    // Create the container
    const container = await this.docker.createContainer({
      Image: image,
      name: `module-test-${deploymentId}`,
      Env: env,
      Labels: {
        'hub.deployment.id': deploymentId,
        'hub.module': moduleName,
        'hub.version': version,
        'hub.test': 'true',
        'hub.insecure': insecure ? 'true' : 'false'
      },
      ExposedPorts: {
        [`${DEFAULTS.CONTAINER_PORT}/tcp`]: {}
      },
      HostConfig: {
        PortBindings: {
          [`${DEFAULTS.CONTAINER_PORT}/tcp`]: [{ HostPort: port.toString() }]
        },
        AutoRemove: false // We handle cleanup ourselves
      }
    });

    const containerId = container.id;
    this.runningContainers.set(deploymentId, containerId);

    // Start the container
    await container.start();
    this.logger.info(`Container started: ${containerId.slice(0, 12)} on port ${port}`);

    // Wait for health check - use HTTP in insecure mode, HTTPS otherwise
    const healthTimeout = options.healthCheckTimeout ?? this.config.healthCheckTimeout;
    const healthInterval = options.healthCheckInterval ?? DEFAULTS.HEALTH_CHECK_INTERVAL;

    await this.waitForHealthy(deployment, port, healthTimeout, healthInterval, !insecure);

    return {
      containerId,
      port,
      image
    };
  }

  /**
   * Stop a container by deployment ID
   */
  async stopContainer(deploymentId: string): Promise<void> {
    const containerId = this.runningContainers.get(deploymentId);
    if (!containerId) {
      this.logger.warn(`No container found for deployment: ${deploymentId}`);
      return;
    }

    try {
      const container = this.docker.getContainer(containerId);
      await container.stop({ t: DEFAULTS.STOP_TIMEOUT });
      await container.remove();
      this.runningContainers.delete(deploymentId);
      this.logger.info(`Container stopped and removed: ${containerId.slice(0, 12)}`);
    } catch (error) {
      // Container might already be stopped
      this.logger.warn(`Error stopping container ${containerId}: ${error}`);
      this.runningContainers.delete(deploymentId);
    }
  }

  /**
   * Stop all running test containers
   */
  async stopAll(): Promise<void> {
    const deploymentIds = [...this.runningContainers.keys()];
    for (const deploymentId of deploymentIds) {
      await this.stopContainer(deploymentId);
    }
  }

  /**
   * Perform a health check on a running container
   * Uses the root endpoint (/) which returns nonsensitiveProfileFields when ready
   *
   * @param deployment - Deployment to check
   * @param port - Container port
   * @param options - Health check options
   * @param options.useHttps - Use HTTPS (default: false for insecure mode)
   */
  async healthCheck(
    deployment: TestDeployment,
    port: number,
    options: { useHttps?: boolean } = {}
  ): Promise<HealthCheckResult> {
    const startTime = Date.now();
    const { useHttps = false } = options;

    this.logger.debug(`Health check using ${useHttps ? 'HTTPS' : 'HTTP'} on port ${port}`);

    try {
      const client = this.createAxiosClient(deployment, port, { useHttps });
      const response = await client.get<ModuleInfo>('/', { timeout: 5000 });

      // Verify the response has the expected structure
      if (response.data && 'nonsensitiveProfileFields' in response.data) {
        return {
          healthy: true,
          moduleInfo: response.data,
          responseTimeMs: Date.now() - startTime
        };
      }

      return {
        healthy: false,
        error: 'Unexpected response format - missing nonsensitiveProfileFields',
        responseTimeMs: Date.now() - startTime
      };
    } catch (error: unknown) {
      const axiosError = error as { response?: { status: number; data?: unknown }; message: string };
      if (axiosError.response?.status === 401) {
        return {
          healthy: false,
          error: 'Authentication failed - deployment auth mismatch',
          responseTimeMs: Date.now() - startTime
        };
      }

      // Include response data in error if available
      let errorMsg = axiosError.message;
      if (axiosError.response?.data) {
        try {
          errorMsg += ` - Response: ${JSON.stringify(axiosError.response.data)}`;
        } catch {
          errorMsg += ` - Response data could not be serialized`;
        }
      }

      return {
        healthy: false,
        error: errorMsg,
        responseTimeMs: Date.now() - startTime
      };
    }
  }

  /**
   * Create an Axios client configured with auth headers
   *
   * @param deployment - Deployment info with auth key
   * @param port - Container port
   * @param options - Client options
   * @param options.useHttps - Use HTTPS (default: false for insecure mode)
   * @param options.authVersion - Auth protocol version (default: 'v1')
   */
  createAxiosClient(
    deployment: TestDeployment,
    port: number,
    options: { useHttps?: boolean; authVersion?: AuthProtocolVersion } = {}
  ): AxiosInstance {
    const { useHttps = false, authVersion = 'v1' } = options;
    const baseURL = useHttps ? `https://localhost:${port}` : `http://localhost:${port}`;

    // Build auth headers based on protocol version
    const headers: Record<string, string> = {};
    if (authVersion === 'v1') {
      // V1: Single header 'auditmation-auth'
      headers[AUTH_HEADERS.V1_AUTH] = deployment.authKey;
    } else {
      // V2: Two headers (future)
      headers[AUTH_HEADERS.V2_DEPLOYMENT_ID] = deployment.id;
      headers[AUTH_HEADERS.V2_MODULE_AUTH] = deployment.authKey;
    }

    const config: Parameters<typeof axios.create>[0] = {
      baseURL,
      headers
    };

    if (useHttps) {
      config.httpsAgent = new https.Agent({
        rejectUnauthorized: false // Modules use self-signed certs
      });
    }

    return axios.create(config);
  }

  /**
   * Get container logs
   */
  async getLogs(deploymentId: string, tail?: number): Promise<string> {
    const containerId = this.runningContainers.get(deploymentId);
    if (!containerId) {
      throw new Error(`No container found for deployment: ${deploymentId}`);
    }

    const container = this.docker.getContainer(containerId);
    const logs = await container.logs({
      stdout: true,
      stderr: true,
      tail: tail ?? 100
    });

    return logs.toString();
  }

  /**
   * Wait for container to become healthy
   */
  private async waitForHealthy(
    deployment: TestDeployment,
    port: number,
    timeout: number,
    interval: number,
    useHttps: boolean = false
  ): Promise<void> {
    const startTime = Date.now();
    let lastError = '';

    while (Date.now() - startTime < timeout) {
      const result = await this.healthCheck(deployment, port, { useHttps });

      if (result.healthy) {
        this.logger.info(
          `Container healthy after ${Date.now() - startTime}ms`,
          result.moduleInfo
        );
        return;
      }

      // Auth failure is fatal - don't retry
      if (result.error?.includes('Authentication failed')) {
        throw new Error(`Health check failed: ${result.error}`);
      }

      lastError = result.error ?? 'Unknown error';
      await this.sleep(interval);
    }

    throw new Error(`Container failed to become healthy within ${timeout}ms: ${lastError}`);
  }

  /**
   * Build environment variables for container
   *
   * @param deploymentId - Deployment ID for reference
   * @param authKey - Auth key for reference
   * @param insecure - Run in insecure mode (HTTP, no auth)
   * @param extra - Additional environment variables
   */
  private buildEnvironment(
    deploymentId: string,
    authKey: string,
    insecure: boolean,
    extra?: Record<string, string>
  ): string[] {
    const env: Record<string, string> = {
      // For reference/debugging
      HUB_TEST_AUTH_KEY: authKey,
      HUB_TEST_DEPLOYMENT_ID: deploymentId,
      ...extra
    };

    if (insecure) {
      // Insecure mode: disable auth and use HTTP
      env.HUB_NODE_INSECURE = 'true';
      // Allow module to skip cert verification
      env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
    }

    return Object.entries(env).map(([key, value]) => `${key}=${value}`);
  }

  /**
   * Create a default console logger
   */
  private createDefaultLogger(): Logger {
    return {
      debug: (msg: string, ...args: unknown[]) => console.debug(`[DockerManager] ${msg}`, ...args),
      info: (msg: string, ...args: unknown[]) => console.info(`[DockerManager] ${msg}`, ...args),
      warn: (msg: string, ...args: unknown[]) => console.warn(`[DockerManager] ${msg}`, ...args),
      error: (msg: string, ...args: unknown[]) => console.error(`[DockerManager] ${msg}`, ...args)
    };
  }

  /**
   * Sleep for specified milliseconds
   */
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

/**
 * Generate a new deployment ID
 */
export function generateDeploymentId(): string {
  return `test-dep-${uuidv4()}`;
}

/**
 * Generate a new auth key
 */
export function generateAuthKey(): string {
  return uuidv4();
}
