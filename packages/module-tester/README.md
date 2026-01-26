# @zerobias-org/module-tester

Test harness for Hub modules - enables REST-level testing on Docker containers during local development and CI.

## Overview

The Module Test Harness allows Hub module developers to validate their modules using the REST interface on Docker containers. This provides:

- **Language-agnostic testing** - Works for modules in any language (TypeScript, Java, Python, Go)
- **Full runtime validation** - Exercises complete code path including Docker bindings and REST layer
- **Standardized approach** - Universal testing pattern for all modules
- **Environment flexibility** - Works in local dev, CI, and remote environments

## Installation

```bash
npm install @zerobias-org/module-tester
```

## Quick Start

### Basic Usage

```typescript
import { ModuleTestHarness, createTestHarness } from '@zerobias-org/module-tester';

// Create harness with automatic cleanup
const harness = createTestHarness({ debug: true });

// Start a module container
const deploymentId = await harness.start(
  '@auditlogic/module-aws-s3',
  '1.0.0'
);

// Set connection profile
harness.setConnectionProfile({
  type: 'AwsConnectionProfile',
  region: 'us-east-1',
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
});

// Connect to the service
await harness.connect();

// Invoke operations
const result = await harness.invoke({
  operationId: 'listBuckets'
});

console.log('Buckets:', result.data);

// Clean up
await harness.stopAll();
```

### Using Test Profiles

Create a test profile in `test-profiles/aws-s3.yml`:

```yaml
name: aws-s3-integration
module: "@auditlogic/module-aws-s3"
version: "1.0.0"

connection:
  profileType: AwsConnectionProfile
  secretsPath: "aws/test-credentials"

operations:
  - listBuckets
  - getBucketPolicy
```

Use the profile in your tests:

```typescript
import { createTestHarness } from '@zerobias-org/module-tester';
import { describe, it, before, after } from 'mocha';
import { expect } from 'chai';

describe('AWS S3 Module', () => {
  let harness;

  before(async function() {
    this.timeout(120000); // Container startup timeout

    harness = createTestHarness();

    if (!(await harness.isDockerAvailable())) {
      this.skip();
      return;
    }

    await harness.startWithProfile('aws-s3');
    await harness.connect();
  });

  after(async () => {
    if (harness) {
      await harness.stopAll();
    }
  });

  it('should list buckets', async () => {
    const result = await harness.invoke({ operationId: 'listBuckets' });

    expect(result.success).to.be.true;
    expect(result.data).to.be.an('array');
  });
});
```

## Secrets Management

The harness supports multiple secret providers for different environments:

### Environment Variables (CI)

Set secrets as environment variables:

```bash
# JSON format
export MODULE_TEST_SECRET_AWS_TEST_CREDENTIALS='{"accessKeyId":"AKIA...","secretAccessKey":"..."}'

# Or individual keys
export MODULE_TEST_SECRET_AWS_TEST_CREDENTIALS_ACCESS_KEY_ID=AKIA...
export MODULE_TEST_SECRET_AWS_TEST_CREDENTIALS_SECRET_ACCESS_KEY=...
```

### File-based Secrets (Local Dev)

Create secrets in `.secrets/` directory:

```
.secrets/
  aws/
    test-credentials.json
  github/
    token.json
```

File contents (`.secrets/aws/test-credentials.json`):

```json
{
  "accessKeyId": "AKIA...",
  "secretAccessKey": "...",
  "region": "us-east-1"
}
```

Reference in profile:

```yaml
connection:
  profileType: AwsConnectionProfile
  secretsPath: "aws/test-credentials"
```

## API Reference

### ModuleTestHarness

Main orchestration class.

```typescript
const harness = new ModuleTestHarness(config?: ModuleTestHarnessConfig);
```

#### Configuration

```typescript
interface ModuleTestHarnessConfig {
  docker?: DockerManagerConfig;    // Docker connection config
  secretsProvider?: SecretsProvider; // Custom secrets provider
  profilesDir?: string;            // Test profiles directory
  isCi?: boolean;                  // Running in CI?
  containerTimeout?: number;       // Startup timeout (ms)
  cleanup?: boolean;               // Auto cleanup on exit
  debug?: boolean;                 // Enable debug logging
}
```

#### Methods

| Method | Description |
|--------|-------------|
| `start(module, version, image?, options?)` | Start a module container |
| `startWithProfile(profile)` | Start using a test profile |
| `connect(deploymentId?)` | Connect to module (call connect operation) |
| `disconnect(deploymentId?)` | Disconnect from module |
| `invoke(request, deploymentId?)` | Invoke a module operation |
| `getClient(deploymentId?)` | Get HTTP client for direct calls |
| `getDeployment(deploymentId?)` | Get deployment info |
| `getPort(deploymentId?)` | Get allocated port |
| `healthCheck(deploymentId?)` | Perform health check |
| `getLogs(deploymentId?, tail?)` | Get container logs |
| `stop(deploymentId?)` | Stop a container |
| `stopAll()` | Stop all containers |
| `isDockerAvailable()` | Check if Docker is available |
| `isCi()` | Check if running in CI |

### DockerManager

Container lifecycle management.

```typescript
const docker = new DockerManager(config?: DockerManagerConfig);

await docker.pullImage(image);
await docker.startContainer(deployment, options);
await docker.stopContainer(deploymentId);
await docker.healthCheck(deployment, port);
await docker.getLogs(deploymentId, tail);
```

### AuthManager

V2 authentication protocol.

```typescript
const auth = new AuthManager();

const session = auth.createSession();
const headers = auth.getAuthHeaders(deploymentId);
const client = auth.createClient(deployment, baseURL);
```

### TestProfileLoader

YAML profile loading.

```typescript
const loader = new TestProfileLoader({ profilesDir: './test-profiles' });

const profile = await loader.loadProfile('my-profile');
const allProfiles = await loader.loadAllProfiles();
const ciProfiles = await loader.loadProfilesForEnvironment(true);
```

### SecretsProvider

```typescript
interface SecretsProvider {
  getSecret(path: string): Promise<Record<string, unknown>>;
  supports(path: string): boolean;
}
```

Built-in providers:
- `EnvSecretsProvider` - Environment variables
- `FileSecretsProvider` - Local files

## Test Profile Schema

```yaml
# Required
name: string              # Profile identifier
module: string            # Module package name

# Optional
version: string           # Module version (default: 'latest')
image: string             # Docker image (derived from module if not set)
skipCi: boolean           # Skip in CI environment
skipLocal: boolean        # Skip in local environment
operations: string[]      # Operations to test (all if not specified)
environment: object       # Container environment variables

# Connection (required)
connection:
  profileType: string     # Connection profile type name
  secretsPath: string     # Path to secrets (for SecretsProvider)
  # OR
  profile: object         # Inline profile (for non-sensitive data)
```

## Authentication Protocol

The harness implements Hub's V2 authentication protocol:

1. Generate unique deployment ID and auth key per test run
2. Inject auth key via container environment variable
3. Add auth headers to all HTTP requests:
   - `hub-deployment-id`: Deployment identifier
   - `hub-module-auth`: Authentication key (UUID)

## Best Practices

### 1. Check Docker Availability

```typescript
before(async function() {
  if (!(await harness.isDockerAvailable())) {
    console.warn('Docker not available, skipping tests');
    this.skip();
  }
});
```

### 2. Set Appropriate Timeouts

```typescript
before(async function() {
  this.timeout(120000); // Container startup can be slow
});
```

### 3. Clean Up After Tests

```typescript
after(async () => {
  if (harness) {
    await harness.stopAll();
  }
});
```

### 4. Use Test Profiles for Credentials

Never hardcode credentials. Use profiles with `secretsPath`:

```yaml
connection:
  profileType: AwsConnectionProfile
  secretsPath: "aws/credentials"  # Loaded from secrets provider
```

### 5. Handle CI vs Local Differences

```yaml
# test-profiles/local-only.yml
skipCi: true  # This test needs local resources
```

## Troubleshooting

### Docker not available

```
Error: Docker is not available. Please ensure Docker is running.
```

Ensure Docker Desktop or Docker Engine is running.

### Container fails to start

Check container logs:

```typescript
const logs = await harness.getLogs();
console.log(logs);
```

### Authentication failures

Verify the auth key is being passed correctly:

```typescript
const deployment = harness.getDeployment();
console.log('Auth key:', deployment.authKey);
```

### Secret not found

Verify your secrets setup:

```typescript
// For env vars
console.log(process.env.MODULE_TEST_SECRET_AWS_TEST_CREDENTIALS);

// For files
ls -la .secrets/aws/
```

## License

UNLICENSED - Internal use only
