# PlatformEvents SDK Usage Guide

## Installation

```bash
npm install sdk
```

## Quick Start

```typescript
import { newPlatformEvents, PlatformEventsClient } from 'sdk';

// Create client instance
const client = newPlatformEvents();

// Connect with credentials
await client.connect({
  url: 'https://your-server.example.com',
  apiKey: 'your-api-key',
  orgId: 'your-org-id'
});

// Use the API - see Available APIs section below
// Example: const result = await client.getHealthcheckApi().health();

// Disconnect when done
await client.disconnect();
```

## Authentication

### API Key Authentication

```typescript
await client.connect({
  url: 'https://api.zerobias.com',
  apiKey: 'your-api-key',
  orgId: 'your-org-uuid'
});
```

### JWT Token Authentication

```typescript
await client.connect({
  url: 'https://api.zerobias.com',
  jwt: 'your-jwt-token',
  orgId: 'your-org-uuid'
});
```

## Multi-Tenancy

### Setting Organization Context

The `orgId` parameter in the connection profile sets the organization context for all API calls:

```typescript
await client.connect({
  url: 'https://api.zerobias.com',
  apiKey: 'your-api-key',
  orgId: 'org-uuid-1'  // All calls scoped to this org
});
```

### Switching Organizations

To switch organizations, disconnect and reconnect:

```typescript
await client.disconnect();
await client.connect({
  url: 'https://api.zerobias.com',
  apiKey: 'your-api-key',
  orgId: 'org-uuid-2'  // Now scoped to different org
});
```

## Debugging

### Enable Request Inspection

```typescript
// Enable debug mode
client.enableRequestInspection(true);

// Get the inspector
const inspector = client.getRequestInspector();

// Log all requests
inspector.onRequest((config) => {
  console.log(`→ ${config.method?.toUpperCase()} ${config.url}`);
  console.log('  Headers:', config.headers);
  if (config.data) console.log('  Body:', config.data);
});

// Log all responses
inspector.onResponse((response) => {
  console.log(`← ${response.status} ${response.statusText}`);
  console.log(`  Duration: ${response.duration}ms`);
});
```

### View Request History

```typescript
client.enableRequestInspection(true);

// Make some API calls...
await client.getHealthcheckApi().health();

// Get request history
const history = inspector.getRequestHistory();
history.forEach(record => {
  console.log(`${record.method} ${record.url} - ${record.response?.status}`);
});
```

> **Warning:** Request history is stored in memory. Use callbacks (`onRequest`/`onResponse`)
> for production to avoid memory leaks.

## Error Handling

```typescript
import { CoreError } from '@zerobias-org/types-core-js';

try {
  const result = await client.getSomeApi().someMethod();
} catch (error) {
  if (error instanceof CoreError) {
    console.error('API Error:', error.message);
    console.error('Error Code:', error.code);
    console.error('Details:', error.details);
  } else {
    console.error('Unexpected error:', error);
  }
}
```

## Available APIs

### BatchApi

Access via `client.getBatchApi()`

- `triggerBatch()` - Trigger batch to process
- `triggerBatchesForPipelineJob()` - Trigger pipeline jobs ready batches to process
- `triggerDynamoDBIndexBuild()` - Trigger index build from all collected latest versions of objects

### CleanupApi

Access via `client.getCleanupApi()`

- `cleanupBoundary()` - Runs a full hard delete against a boundary and its resources
- `cleanupOrg()` - Runs a full hard delete against an org and its resources

### CronApi

Access via `client.getCronApi()`

- `deleteSchedule()` - Delete a Schedule by its id
- `getSchedule()` - Gets a Schedule by its id
- `schedule()` - Schedules a Cron Job for execution

### EventApi

Access via `client.getEventApi()`

- `handleEvent()` - Handles events

### HealthcheckApi

Access via `client.getHealthcheckApi()`

- `health()` - 

### JobApi

Access via `client.getJobApi()`

- `handleError()` - Callback to report cron job errors
- `linkJobBatches()` - Trigger job to run linker on all batches
- `onComplete()` - Callback to report cron job complete

### PipelineApi

Access via `client.getPipelineApi()`

- `startPreviewRun()` - Starts a preview mode run on a given pipeline

### PrincipalApi

Access via `client.getPrincipalApi()`

- `ensureRequestPrincipal()` - Ensures request user or service account principal on apps pointed database

### SyncApi

Access via `client.getSyncApi()`

- `sync()` - Start a sync
- `syncBoundaries()` - Syncs boundary parties/components/links/roles
- `syncBoundarySecurityGroups()` - Syncs boundary security groups with dana
- `syncBoundarySecurityRoles()` - Syncs boundary security roles
- `syncConnections()` - Syncs connections from hub
- `syncDynamoGsi()` - Updates the dynamodb GSI. Warning this does a full Scan and will update all records in the table.
- `syncObjectVersions()` - Syncs object versions
- `syncPipelines()` - Syncs platform point in time object table
- `syncPitObjectTable()` - Syncs platform point in time object table
- `syncPortal()` - Syncs portal information
- `syncSharedRoles()` - Syncs boundary security roles
- `syncTags()` - Syncs platform tags to dana
- `syncUnionTypes()` - Syncs union type app object tables for org


## Connection Profile Options

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| `url` | string | Yes | Base URL of the API server |
| `apiKey` | string | No* | API key for authentication |
| `jwt` | string | No* | JWT token for authentication |
| `orgId` | string | Yes | Organization ID for multi-tenancy |

*Either `apiKey` or `jwt` is required for authentication.

## TypeScript Support

This SDK is written in TypeScript and includes full type definitions. All models and API
interfaces are exported for use in your TypeScript projects.

```typescript
import {
  PlatformEventsClient,
  ConnectionProfile,
  // Import models as needed
} from 'sdk';
```

## Additional Resources

- [OpenAPI Spec](./api.yml) - Raw OpenAPI specification
- [manifest.json](./generated/api/manifest.json) - Operation metadata for AI/tooling integration

---
*Generated: 2025-12-03T13:27:00Z*
*Codegen Version: 1.0.12*
