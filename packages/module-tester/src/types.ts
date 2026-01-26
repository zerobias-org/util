/**
 * Module Tester Types
 *
 * These types are defined inline to avoid dependency on com/hub packages,
 * making the module-tester available to open-source developers.
 */

/**
 * Authentication header constants
 *
 * V1 (Current): Single header 'auditmation-auth'
 * V2 (Future): Two headers 'hub-deployment-id' + 'hub-module-auth'
 */
export const AUTH_HEADERS = {
  // V1 Auth (current implementation)
  V1_AUTH: 'auditmation-auth',
  V1_SECRET_NAME: 'auditmation-auth',

  // V2 Auth (future - not yet implemented in modules)
  V2_DEPLOYMENT_ID: 'hub-deployment-id',
  V2_MODULE_AUTH: 'hub-module-auth'
} as const;

/**
 * Auth protocol version
 */
export type AuthProtocolVersion = 'v1' | 'v2';

/**
 * Deployment type - how the module is deployed
 */
export type DeploymentType = 'container' | 'npm';

/**
 * Operational status of a deployment
 */
export type OperationalStatus = 'up' | 'down' | 'degraded' | 'pending';

/**
 * Minimal deployment information needed for testing
 */
export interface TestDeployment {
  /** Unique deployment ID */
  id: string;
  /** Deployment type */
  type: DeploymentType;
  /** Module package name (e.g., "@auditlogic/module-aws-s3") */
  module: string;
  /** Module version */
  version: string;
  /** Docker image reference */
  image: string;
  /** Authentication key for this deployment */
  authKey: string;
  /** Allocated port */
  port?: number;
  /** Container ID (when running) */
  containerId?: string;
  /** Current status */
  status: OperationalStatus;
}

/**
 * Container health check result
 */
export interface HealthCheckResult {
  /** Whether the container is healthy */
  healthy: boolean;
  /** Module info if healthy (from root endpoint) */
  moduleInfo?: ModuleInfo;
  /** Error message if unhealthy */
  error?: string;
  /** Response time in milliseconds */
  responseTimeMs?: number;
}

/**
 * Module info returned from root endpoint (/)
 * This is used for health checks to verify the container is ready
 */
export interface ModuleInfo {
  /** Non-sensitive profile fields that can be displayed */
  nonsensitiveProfileFields: string[];
}

/**
 * Module metadata returned from /connections/{id}/metadata endpoint
 */
export interface ModuleMetadata {
  /** Module package name */
  name: string;
  /** Module version */
  version: string;
  /** OpenAPI specification (optional) */
  openapi?: string;
  /** Additional metadata */
  [key: string]: unknown;
}

/**
 * Container start options
 */
export interface ContainerStartOptions {
  /** Pull image even if it exists locally */
  forcePull?: boolean;
  /** Environment variables to set */
  environment?: Record<string, string>;
  /** Health check timeout in milliseconds */
  healthCheckTimeout?: number;
  /** Health check interval in milliseconds */
  healthCheckInterval?: number;
  /**
   * Run in insecure mode (HTTP, no auth).
   * Sets HUB_NODE_INSECURE=true in container.
   * Default: true for test harness
   */
  insecure?: boolean;
}

/**
 * Container start result
 */
export interface ContainerStartResult {
  /** Container ID */
  containerId: string;
  /** Allocated port */
  port: number;
  /** Full image reference */
  image: string;
}

/**
 * Connection profile for a module
 * This is the configuration passed to the module's connect() operation
 */
export interface ConnectionProfile {
  /** Profile type identifier */
  type: string;
  /** Profile configuration (varies by module) */
  [key: string]: unknown;
}

/**
 * Test profile configuration loaded from YAML
 */
export interface TestProfile {
  /** Profile name */
  name: string;
  /** Module package name */
  module: string;
  /** Module version (optional, defaults to 'latest') */
  version?: string;
  /** Docker image (optional, derived from module if not specified) */
  image?: string;
  /** Skip this profile in CI */
  skipCi?: boolean;
  /** Skip this profile locally */
  skipLocal?: boolean;
  /** Connection configuration */
  connection: {
    /** Connection profile type */
    profileType: string;
    /** Path to secrets (for SecretsProvider) */
    secretsPath?: string;
    /** Inline profile configuration (for non-sensitive data, type is added from profileType) */
    profile?: Record<string, unknown>;
  };
  /** Operations to test (if empty, test all) */
  operations?: string[];
  /** Environment variables for the container */
  environment?: Record<string, string>;
}

/**
 * Module invocation request
 */
export interface InvokeRequest {
  /** Operation ID (from OpenAPI spec) */
  operationId: string;
  /** Operation parameters */
  parameters?: Record<string, unknown>;
  /** Request body */
  body?: unknown;
}

/**
 * Module invocation result
 */
export interface InvokeResult<T = unknown> {
  /** Whether the operation succeeded */
  success: boolean;
  /** Response data */
  data?: T;
  /** Error message if failed */
  error?: string;
  /** HTTP status code */
  statusCode: number;
  /** Response time in milliseconds */
  responseTimeMs: number;
}

/**
 * Docker manager configuration
 */
export interface DockerManagerConfig {
  /** Docker socket path (default: /var/run/docker.sock) */
  socketPath?: string;
  /** Docker host (alternative to socket) */
  host?: string;
  /** Docker port (when using host) */
  port?: number;
  /** Use TLS */
  tls?: boolean;
  /** Pull timeout in milliseconds */
  pullTimeout?: number;
  /** Default health check timeout */
  healthCheckTimeout?: number;
}

/**
 * Secrets provider interface
 */
export interface SecretsProvider {
  /**
   * Get secret values at the given path
   * @param path Secret path/key
   * @returns Secret values as key-value pairs
   */
  getSecret(path: string): Promise<Record<string, unknown>>;

  /**
   * Check if this provider supports the given path
   * @param path Secret path/key
   * @returns Whether this provider can handle the path
   */
  supports(path: string): boolean;
}

/**
 * Test harness configuration
 */
export interface ModuleTestHarnessConfig {
  /** Docker manager configuration */
  docker?: DockerManagerConfig;
  /** Secrets provider (default: auto-detect) */
  secretsProvider?: SecretsProvider;
  /** Test profiles directory (default: ./test-profiles) */
  profilesDir?: string;
  /** Whether running in CI environment */
  isCi?: boolean;
  /** Default container timeout in milliseconds */
  containerTimeout?: number;
  /** Clean up containers on test completion */
  cleanup?: boolean;
  /** Enable debug logging */
  debug?: boolean;
  /**
   * Run in insecure mode (HTTP, no auth).
   * Sets HUB_NODE_INSECURE=true in containers.
   * Only use for local development/testing.
   * Default: true (for test harness convenience)
   */
  insecure?: boolean;
  /**
   * Auth protocol version to use.
   * Default: 'v1' (auditmation-auth header)
   */
  authVersion?: AuthProtocolVersion;
}

/**
 * Logger interface for test harness
 */
export interface Logger {
  debug(message: string, ...args: unknown[]): void;
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
}
