# Hub Module Container Protocol

**Version:** 1.0 (Current Implementation)
**Last Updated:** 2026-01-25

This document describes the protocol for communication between Hub Node and module containers. This is the authoritative reference for community module developers.

## Overview

Hub modules run as Docker containers and expose a REST API over HTTPS. The Hub Node communicates with module containers to:
1. Verify container health
2. Establish connections to remote systems
3. Execute operations against those systems

## Container Configuration

### Port

Modules listen on port **8888** inside the container. The Hub Node maps this to a dynamically allocated host port.

```dockerfile
EXPOSE 8888
```

### Working Directory

Module code is located at `/opt/module/` inside the container:
```
/opt/module/
├── dist/
│   ├── server.js          # Main entry point
│   ├── generated/         # OpenAPI-generated code
│   └── src/               # Module implementation
├── node_modules/
└── package.json
```

### Entry Point

```dockerfile
CMD ["node", "dist/server.js"]
```

## Transport Layer

### HTTPS (Default/Production)

By default, modules run HTTPS with self-signed certificates:
- Certificate generated at startup using `pem` library
- 10-year validity (3650 days)
- Callers must disable certificate verification (`rejectUnauthorized: false`)

```typescript
// Module server startup (secure mode)
const cert = await pem.promisified.createCertificate({ days: 3650, selfSigned: true });
https.createServer({ key: cert.clientKey, cert: cert.certificate }, app).listen(8888);
```

### HTTP (Development Only)

When `HUB_NODE_INSECURE=true` is set, modules run plain HTTP:

```typescript
// Module server startup (insecure mode)
const secure = process.env.HUB_NODE_INSECURE === 'true' ? false : true;
if (!secure) {
  app.listen(8888); // HTTP
}
```

**Warning:** Never use insecure mode in production.

## Authentication

### Docker Secrets (V1 - Current)

Authentication uses a Docker secret named `auditmation-auth`:

**Hub Node creates the secret:**
```bash
echo "${authKey}" | docker secret create auditmation-auth -
```

**Container mounts the secret:**
```bash
docker service create \
  --secret auditmation-auth \
  --publish published=${hostPort},target=8888,mode=host \
  ${image}
```

**Module reads the secret at startup:**
```typescript
const AUTH_SECRET = 'auditmation-auth';
let authKey: string | undefined;

function readSecrets() {
  const secretDir = '/run/secrets';
  if (fs.existsSync(secretDir)) {
    const secretFiles = fs.readdirSync(secretDir);
    secretFiles.forEach(secret => {
      const val = fs.readFileSync(path.join(secretDir, secret), 'utf-8').trim();
      if (secret === AUTH_SECRET) {
        authKey = val;
      }
    });
  }
}
```

### Request Authentication

All requests must include the `auditmation-auth` header:

```http
GET /connections/abc-123/metadata HTTP/1.1
Host: localhost:8001
auditmation-auth: uuid-secret-value
```

**Module validates requests:**
```typescript
app.use((req, res, next) => {
  if (authKey && secure) {
    if (!req.headers['auditmation-auth'] || req.headers['auditmation-auth'] !== authKey) {
      throw new UnauthorizedError();
    }
  }
  next();
});
```

### Environment Variables for Testing

| Variable | Description |
|----------|-------------|
| `HUB_NODE_INSECURE=true` | Disables auth and uses HTTP (dev only) |
| `PORT` | Override default port 8888 |

## REST API Endpoints

### Health Check

**Endpoint:** `GET /`

Used to verify the container is ready. Does NOT require authentication when no secrets are mounted.

**Response:**
```json
{
  "nonsensitiveProfileFields": ["url", "username", "region"]
}
```

The `nonsensitiveProfileFields` array lists connection profile fields that can be safely displayed to users.

### Create Connection

**Endpoint:** `POST /connections`

Establishes a connection to a remote system.

**Request:**
```json
{
  "connectionId": "conn-uuid-123",
  "connectionProfile": {
    "type": "AwsS3ConnectionProfile",
    "accessKeyId": "AKIA...",
    "secretAccessKey": "...",
    "region": "us-east-1"
  },
  "oauthDetails": null
}
```

**Response:** Connection state (varies by module)

### Get Connection Metadata

**Endpoint:** `GET /connections/{connectionId}/metadata`

Returns metadata about an established connection.

**Response:**
```json
{
  "name": "module-aws-s3",
  "version": "1.0.0",
  "capabilities": ["listBuckets", "getObject", "putObject"]
}
```

### Refresh Connection (OAuth modules)

**Endpoint:** `PUT /connections/{connectionId}/refresh`

Refreshes OAuth tokens for a connection.

**Request:**
```json
{
  "connectionProfile": { ... },
  "connectionState": { ... },
  "oauthDetails": { ... }
}
```

**Response:** Updated connection state with new tokens

### Check Operation Support

**Endpoint:** `GET /connections/{connectionId}/isSupported/{operationId}`

Checks if a specific operation is supported.

**Response:**
```json
{
  "supported": true,
  "reason": null
}
```

### Execute Operation

**Endpoint:** `POST /connections/{connectionId}/{ApiClass}.{methodName}`

Executes an operation against the connected system.

#### Critical: OpenAPI Spec ≠ Docker API

The OpenAPI specification defines one API, but the Docker container exposes a different REST interface. The test harness must transform between them.

**OpenAPI Spec Example:**
```yaml
paths:
  /organizations:
    get:
      tags:
        - organization
      operationId: listMyOrganizations
      parameters:
        - name: page
          in: query
        - name: perPage
          in: query
```

**Docker Container API:**
```http
POST /connections/{connectionId}/OrganizationApi.listMyOrganizations
Content-Type: application/json

{
  "argMap": {
    "page": 1,
    "perPage": 10
  }
}
```

#### Method Format

The method parameter uses `{ApiClass}.{methodName}` format:

**ApiClass Derivation:**
- OpenAPI `tags` field determines the API class
- Hub codegen converts tag to PascalCase + "Api" suffix
- Examples:
  - `tag: "organization"` → `OrganizationApi`
  - `tag: "objects"` → `ObjectsApi`
  - `tag: "repository"` → `RepositoryApi`

**Method Name:**
- Uses `operationId` from OpenAPI spec
- Examples: `listMyOrganizations`, `getObject`, `getChildren`

#### Parameter Flattening

**All parameters are flattened into the `argMap` object**, regardless of their location in the OpenAPI spec:

| OpenAPI Location | Example | argMap |
|------------------|---------|--------|
| Query parameter | `?page=1&perPage=10` | `{ "page": 1, "perPage": 10 }` |
| Path parameter | `/objects/{objectId}` | `{ "objectId": "/" }` |
| Request body | `{ "name": "foo" }` | `{ "name": "foo" }` |

**Example transformation:**
```yaml
# OpenAPI spec
/objects/{objectId}/children:
  get:
    parameters:
      - name: objectId
        in: path
      - name: pageSize
        in: query
```

```http
# Docker API call
POST /connections/{connId}/ObjectsApi.getChildren
{ "argMap": { "objectId": "/", "pageSize": 100 } }
```

#### Response Format

**Standard Response:**
```json
{
  "id": "obj-123",
  "name": "My Object",
  "properties": { ... }
}
```

**Known Deviation - Pagination Wrapper:**
Many modules wrap array responses in a pagination object, even though the OpenAPI spec returns arrays directly:

**OpenAPI spec:**
```yaml
responses:
  '200':
    content:
      application/json:
        schema:
          type: array
          items:
            $ref: '#/components/schemas/Object'
```

**Actual response from module:**
```json
{
  "items": [
    { "id": "1", "name": "Object 1" },
    { "id": "2", "name": "Object 2" }
  ],
  "count": 2,
  "pageNumber": 1,
  "pageSize": 100
}
```

**Test clients must unwrap this:**
```typescript
const response = await harness.invokeMethod<PagedResponse<Object>>('ObjectsApi', 'getChildren', args, connectionId);
return response.items;  // Unwrap to match interface
```

This deviation affects:
- GitHub module: `OrganizationApi`, `RepositoryApi`, `ObjectsApi`
- SQL module: `ObjectsApi.getChildren`, `ObjectsApi.search`

**Binary/Streaming Response:**
- Content-Type: `application/octet-stream`
- Response is raw stream data (not JSON)

#### Complete Example

**OpenAPI Definition:**
```yaml
paths:
  /objects/{objectId}/children:
    get:
      tags:
        - objects
      operationId: getChildren
      parameters:
        - name: objectId
          in: path
          required: true
          schema:
            type: string
        - name: pageSize
          in: query
          schema:
            type: integer
            default: 100
      responses:
        '200':
          content:
            application/json:
              schema:
                type: array
                items:
                  $ref: '#/components/schemas/Object'
```

**Test Harness Call:**
```typescript
// Using module-tester framework
const children = await harness.invokeMethod<PagedResponse<Object>>(
  'ObjectsApi',           // tag "objects" → "ObjectsApi"
  'getChildren',          // operationId
  {                       // All params in argMap
    objectId: '/',
    pageSize: 10
  },
  connectionId
);

// Unwrap pagination wrapper
return children.items;
```

**Actual HTTP Request:**
```http
POST /connections/conn-123-456/ObjectsApi.getChildren HTTP/1.1
Host: localhost:54321
Content-Type: application/json
auditmation-auth: secret-uuid-value

{
  "argMap": {
    "objectId": "/",
    "pageSize": 10
  }
}
```

**Actual HTTP Response:**
```http
HTTP/1.1 200 OK
Content-Type: application/json

{
  "items": [
    { "id": "/org1", "name": "Organization 1", "objectClass": ["container"] },
    { "id": "/org2", "name": "Organization 2", "objectClass": ["container"] }
  ],
  "count": 2,
  "pageNumber": 1,
  "pageSize": 10
}
```

## Error Handling

Modules return errors in a standard format:

```json
{
  "key": "NOT_FOUND",
  "timestamp": "2026-01-25T12:00:00.000Z",
  "message": "Connection abc-123 not found",
  "args": {},
  "template": "Connection {connectionId} not found",
  "statusCode": 404
}
```

**Common HTTP Status Codes:**
- `200` - Success
- `401` - Unauthorized (missing or invalid auth)
- `404` - Not found (connection, operation)
- `500` - Internal error

## Container Lifecycle

### Startup Sequence

1. Node.js starts `dist/server.js`
2. Secrets are read from `/run/secrets/`
3. Express server configured with auth middleware
4. Certificate generated (if secure mode)
5. Server listens on port 8888
6. Hub Node polls `GET /` until healthy

### Health Check Polling

Hub Node waits for the container to become healthy:

```typescript
while (retries < 30) {
  try {
    const response = await client.get('/');
    if (response.data.nonsensitiveProfileFields) {
      return; // Healthy!
    }
  } catch (error) {
    // Keep retrying
  }
  await sleep(1000);
}
throw new Error('Container did not become healthy within 30 seconds');
```

### Shutdown

Containers are stopped gracefully with a 10-second timeout:
```bash
docker service rm ${serviceId}
# or
docker stop -t 10 ${containerId}
```

## Test Harness Configuration

For testing modules without a full Hub Server deployment.

### Test Profiles

Test profiles are YAML files that define module connection settings. They support both literal values and secret references using the `${...}` syntax:

```yaml
# test-profiles/github-local.yml
name: github-local
module: '@auditlogic/module-github-github'
version: '1.0.0'
image: 'pkg.ci.zerobias.com/auditlogic-module-github-github:1.0.0'

# Skip conditions
skipCi: true      # Skip in CI environment
skipLocal: false  # Run in local development

# Connection profile with secret references
connectionProfile:
  tokenType: Bearer           # Literal value
  url: https://github.com     # Literal value
  apiToken: ${file.github.apiToken}  # Secret reference
```

### Secret Path Syntax

Values are either literals or secret references using Mustache `{{...}}` syntax:

| Value | Type | Description |
|-------|------|-------------|
| `Bearer` | Literal | Used as-is |
| `https://github.com` | Literal | Used as-is |
| `{{file.name.key}}` | File secret | Key from `~/.zerobias/secrets/name.json` |
| `{{env.VAR}}` | Env secret | Value from environment variable |

Each secret path resolves to a single scalar value (string, number, or boolean).

**File Secrets** are loaded from `~/.zerobias/secrets/` (or `FILE_SECRET_ROOT`):
```bash
# Create secret file
mkdir -p ~/.zerobias/secrets
echo '{"apiToken": "ghp_xxx"}' > ~/.zerobias/secrets/github.json
```
```yaml
# Reference in profile - gets the apiToken key value
apiToken: "{{file.github.apiToken}}"
```

**Environment Secrets** are loaded directly from environment variables:
```bash
# Set env var (CI)
export GITHUB_API_TOKEN='ghp_xxx'
```
```yaml
# Reference in profile
apiToken: "{{env.GITHUB_API_TOKEN}}"
```

### Local Development (HTTP)

```typescript
const harness = createTestHarness({
  insecure: true  // Uses HTTP, skips auth
});
await harness.start('@my-org/my-module', '1.0.0', 'my-image:1.0.0');
```

### CI/Production (HTTPS)

```typescript
const harness = createTestHarness({
  insecure: false  // Uses HTTPS with self-signed cert handling
});
await harness.start('@my-org/my-module', '1.0.0', 'my-image:1.0.0');
```

## Future: V2 Protocol

A V2 authentication protocol is planned with per-deployment secrets:
- Secret name: `{deploymentId}`
- Headers: `hub-deployment-id`, `hub-module-auth`

This is documented in `com/hub/MODULE_AUTH_V2.md` but not yet implemented in the container generator.

## References

- [Hub Architecture](../../../../com/hub/Architecture.md)
- [Module Development Guide](../../../../auditlogic/module/CLAUDE.md)
- [Container Generator Templates](../../../../auditlogic/module/utils/container-generator-esm/templates/)
