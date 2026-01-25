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

**Endpoint:** `POST /connections/{connectionId}/{operationId}`

Executes an operation against the connected system.

**Request:**
```json
{
  "argMap": {
    "bucketName": "my-bucket",
    "prefix": "data/"
  }
}
```

**Response:** Operation result (varies by operation)
- Content-Type: `application/json` for structured data
- Content-Type: `application/octet-stream` for binary/streaming data

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

For testing modules without a full Hub Server deployment:

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
