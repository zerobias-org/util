# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

`@zerobias-org/module-tester` is a test harness for Hub modules that enables REST-level testing on Docker containers during local development and CI. It provides language-agnostic testing for Hub modules written in any language (TypeScript, Java, Python, Go) by exercising the complete code path including Docker bindings and REST layer.

**Key Capabilities:**
- Start module containers and manage their lifecycle
- Handle Hub authentication protocol (V1 with `auditmation-auth` header)
- Connect to modules with connection profiles and secrets
- Invoke module operations via REST API
- Declarative test framework with automatic lifecycle management
- Support for both file-based and environment variable secrets
- Profile resolution with Mustache syntax (`{{file.name.key}}`, `{{env.VAR}}`)

## Build & Test Commands

### Building

```bash
# Clean previous build
npm run clean

# Compile TypeScript
npm run transpile
# or
npm run build

# Build outputs to dist/
```

### Testing

```bash
# Run all unit tests (Mocha)
npm run test

# Run tests in watch mode
npm run test:watch

# Run tests for specific file
npx mocha --inline-diffs --reporter=list 'test/unit/ProfileResolver.test.ts'
```

### Linting

```bash
# Lint source code
npm run lint

# Auto-fix linting issues
npm run lint:fix
```

## Architecture

### Core Components

**ModuleTestHarness** (`src/ModuleTestHarness.ts`)
- Main orchestration class combining Docker, auth, secrets, and profile loading
- Manages container lifecycle and connection state
- Provides high-level API for starting modules, invoking operations, and cleanup
- Supports both programmatic usage and test profile loading
- Key methods: `start()`, `startWithProfile()`, `connect()`, `invoke()`, `invokeMethod()`

**DockerManager** (`src/DockerManager.ts`)
- Container lifecycle management (pull, start, stop, health check)
- Uses `dockerode` library for Docker API communication
- Allocates dynamic ports using `get-port`
- Implements health check polling with configurable timeout
- Manages container cleanup with graceful shutdown (10s timeout)

**AuthManager** (`src/AuthManager.ts`)
- Implements Hub's V2 authentication protocol
- Creates per-deployment sessions with unique IDs and auth keys
- Adds `hub-deployment-id` and `hub-module-auth` headers to requests
- Creates authenticated Axios clients with self-signed cert handling

**TestProfileLoader** (`src/TestProfileLoader.ts`)
- Loads YAML test profiles from `test-profiles/` directory
- Supports environment-based profile selection (CI vs local)
- Validates profiles against schema
- Handles `skipCi` and `skipLocal` flags

**ProfileResolver** (`src/providers/ProfileResolver.ts`)
- Resolves secret references in connection profiles using Mustache syntax
- Secret path format: `{{driver.path.key}}`
- Supported drivers:
  - `file`: Loads from `~/.zerobias/secrets/{path}.json` or `.yml`
  - `env`: Loads from environment variable
- Caches loaded secrets for performance
- Deep key navigation (e.g., `{{file.aws.credentials.accessKeyId}}`)

**SecretsProvider** (`src/providers/`)
- Pluggable secret storage abstraction
- `EnvSecretsProvider`: Environment variables
- `FileSecretsProvider`: Local JSON/YAML files
- `CompositeSecretsProvider`: Chains multiple providers

**moduleTest** (`src/moduleTest.ts`)
- Declarative test framework entry point
- Wraps Mocha `describe` block with automatic lifecycle
- Auto-discovers test profiles based on module name
- Loads client factories (hand-written or generated)
- Creates proxy client for deferred initialization
- Handles Docker availability checks and skip conditions

### Test Profile Schema

Test profiles (`test-profiles/*.yml`) define module connection settings:

```yaml
name: module-name-env               # Profile identifier
module: "@auditlogic/module-aws-s3" # Module package name
version: "1.0.0"                    # Module version
image: pkg.ci.zerobias.com/...      # Docker image (optional, derived from module)
skipCi: false                       # Skip in CI environment
skipLocal: false                    # Skip in local environment

connection:
  profileType: AwsConnectionProfile # Connection profile type
  profile:                          # Connection configuration
    region: us-east-1               # Literal value
    accessKeyId: "{{file.aws.credentials.accessKeyId}}"     # File secret
    secretAccessKey: "{{env.AWS_SECRET_ACCESS_KEY}}"        # Env secret

operations:                         # Operations to test (optional)
  - listBuckets
  - getBucketPolicy

environment:                        # Container env vars (optional)
  DEBUG: "true"
```

### Hub Module Container Protocol

Modules run as Docker containers and expose a REST API:

**Container Configuration:**
- Listen on port 8888 inside container
- Working directory: `/opt/module/`
- Entry point: `node dist/server.js`

**Authentication:**
- V1 (current): Docker secret `auditmation-auth` mounted at `/run/secrets/`
- Requests include `auditmation-auth` header
- V2 (future): Per-deployment secrets with `hub-deployment-id` and `hub-module-auth` headers

**REST Endpoints:**
- `GET /` - Health check (returns `nonsensitiveProfileFields`)
- `POST /connections` - Create connection
- `GET /connections/{id}/metadata` - Get connection metadata
- `POST /connections/{id}/{ApiClass}.{methodName}` - Execute operation

**Critical: OpenAPI vs Docker API Mismatch**

The OpenAPI spec defines one API, but the Docker container exposes a different REST interface. The test harness must transform between them:

**OpenAPI Spec:**
```yaml
paths:
  /organizations:
    get:
      tags: [organization]
      operationId: listMyOrganizations
      parameters:
        - name: page
          in: query
```

**Docker Container API:**
```http
POST /connections/{connId}/OrganizationApi.listMyOrganizations
Content-Type: application/json

{
  "argMap": {
    "page": 1,
    "perPage": 10
  }
}
```

**All parameters are flattened into `argMap`** regardless of OpenAPI location (query, path, body).

**ApiClass Derivation:**
- OpenAPI `tags` field → PascalCase + "Api" suffix
- `tag: "organization"` → `OrganizationApi`
- `tag: "objects"` → `ObjectsApi`

**Known Deviation - Pagination Wrapper:**
Many modules wrap array responses in pagination objects even though OpenAPI spec returns arrays directly. Test clients must unwrap:

```typescript
const response = await harness.invokeMethod<PagedResponse<Object>>('ObjectsApi', 'getChildren', args, connectionId);
return response.items;  // Unwrap to match interface
```

See `PROTOCOL.md` for complete protocol specification.

## Usage Patterns

### Programmatic Usage

```typescript
import { ModuleTestHarness } from '@zerobias-org/module-tester';

const harness = new ModuleTestHarness({ debug: true });

// Start container
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

// Connect
await harness.connect();

// Invoke operations
const result = await harness.invoke({
  operationId: 'listBuckets'
});

// Clean up
await harness.stopAll();
```

### Using Test Profiles

```typescript
import { createTestHarness } from '@zerobias-org/module-tester';

const harness = createTestHarness();

// Load profile and start
await harness.startWithProfile('aws-s3');
await harness.connect();

// Run tests
const result = await harness.invoke({ operationId: 'listBuckets' });
```

### Declarative Test Framework

```typescript
import { moduleTest } from '@zerobias-org/module-tester';
import type { GithubTestClient } from './generated/GithubTestClient.js';

moduleTest<GithubTestClient>('github', ({ organization }) => {
  it('lists organizations', async () => {
    const orgs = await organization.listMyOrganizations({ page: 1 });
    expect(orgs.items.length).to.be.greaterThan(0);
  });
});
```

The framework:
1. Auto-discovers profile `test-profiles/github-{env}.yml`
2. Starts container and waits for health
3. Creates connection using profile secrets
4. Loads client factory (`test/client-factory.ts` or `test/generated/{Module}TestClient.ts`)
5. Runs tests with typed client
6. Cleans up containers automatically

### invokeMethod vs invoke

**Use `invokeMethod`** when you need to call module operations using the Docker container API format:
- Requires ApiClass, method name, argMap, and connectionId
- Maps to `POST /connections/{connId}/{ApiClass}.{method}`
- Used by generated test clients

**Use `invoke`** for operations that don't require a connection:
- Simple operationId-based invocation
- Maps to `POST /operations/{operationId}` or `GET /operations/{operationId}`
- Used for connect/disconnect operations

## Secrets Management

### File Secrets (Local Development)

Store secrets in `~/.zerobias/secrets/`:

```bash
mkdir -p ~/.zerobias/secrets
echo '{"apiToken": "ghp_xxx"}' > ~/.zerobias/secrets/github.json
```

Reference in profile:
```yaml
apiToken: "{{file.github.apiToken}}"
```

### Environment Secrets (CI)

Set environment variables:
```bash
export GITHUB_API_TOKEN='ghp_xxx'
```

Reference in profile:
```yaml
apiToken: "{{env.GITHUB_API_TOKEN}}"
```

### Secret Path Format

Secret references use Mustache `{{...}}` syntax:
- `{{file.{filename}.{key}.{subkey}...}}` - Nested file secret
- `{{env.{VAR_NAME}}}` - Environment variable

**Literal values don't use braces:**
```yaml
tokenType: Bearer                        # Literal
region: us-east-1                        # Literal
apiToken: "{{file.github.apiToken}}"     # Secret reference
```

## Important Implementation Details

### Container Startup Sequence

1. Generate deployment ID and auth key (UUIDs)
2. Pull Docker image if needed
3. Start container with:
   - Port mapping: 8888 → dynamic host port
   - Environment: `HUB_NODE_INSECURE=true` (for test mode)
   - Secret: `auditmation-auth` (mounted at `/run/secrets/`)
4. Poll `GET /` until healthy (max 60s)
5. Create authenticated Axios client

### HTTPS vs HTTP

**Test harness defaults to insecure mode** (`insecure: true`):
- Uses HTTP instead of HTTPS
- Skips authentication
- Sets `HUB_NODE_INSECURE=true` in container
- Only for local development/testing

**Production mode** (`insecure: false`):
- Uses HTTPS with self-signed certificates
- Requires authentication headers
- Container generates certificate at startup

### Client Factory Pattern

Test clients are created by factory functions:

**Hand-written** (`test/client-factory.ts`):
```typescript
export function createTestClient(harness, connectionId) {
  return {
    organization: {
      async listMyOrganizations(args) {
        return harness.invokeMethod('OrganizationApi', 'listMyOrganizations', args, connectionId);
      }
    }
  };
}
```

**Generated** (`test/generated/{Module}TestClient.ts`):
- Auto-generated from OpenAPI spec
- Derives ApiClass from tags
- Flattens parameters into argMap
- Handles pagination wrapper unwrapping

## Testing Best Practices

1. **Check Docker availability** in `before()` hook and skip if not available
2. **Set appropriate timeouts** - Container startup can take 60-120s
3. **Always clean up** in `after()` hook using `harness.stopAll()`
4. **Never hardcode credentials** - Use test profiles with secret references
5. **Use environment-specific profiles** - Separate `module-{env}.yml` for CI vs local
6. **Handle CI differences** - Use `skipCi` flag for tests requiring local resources

## Related Documentation

- **[README.md](README.md)** - User-facing API documentation and examples
- **[PROTOCOL.md](PROTOCOL.md)** - Complete Hub Module Container Protocol specification
- **[../../com/hub/Architecture.md](../../com/hub/Architecture.md)** - Hub three-tier architecture
- **[../../auditlogic/module/CLAUDE.md](../../auditlogic/module/CLAUDE.md)** - Hub module development guide
- **[templates/test-profile.yml](templates/test-profile.yml)** - Test profile template
