# @zerobias-org/hub-api-client-base

Base classes and utilities for Hub API clients. Provides shared runtime functionality to eliminate code duplication across generated clients.

## Installation

```bash
npm install @zerobias-org/hub-api-client-base
```

## Overview

This package provides two base classes:

- **BaseApiClient** - For Platform API clients (direct HTTP calls)
- **BaseConnector** - For Hub Module connectors (via Hub targets)

Plus utilities:
- **AuthUtils** - JWT/API key formatting
- **PipelineUtil** - Request pipeline utilities
- **RequestInspector** - Debug and observability

## Usage

### Platform API Client (BaseApiClient)

For clients that make direct HTTP calls to platform services:

```typescript
import { BaseApiClient } from '@zerobias-org/hub-api-client-base';
import { AxiosRequestConfig } from 'axios';

export class HubApiClient extends BaseApiClient {
  constructor(axiosConfig?: AxiosRequestConfig) {
    super(axiosConfig);
  }

  async listNodes(): Promise<Node[]> {
    // Use this.apiInvoker to make HTTP requests
    const request = {
      method: 'GET',
      location: {
        protocol: 'https',
        hostname: this.connectionProfile?.url?.hostname,
        path: '/nodes'
      }
    };

    const response = await this.apiInvoker.invoke(request);
    return response.data;
  }
}

// Usage
const client = new HubApiClient();

await client.connect({
  url: {
    hostname: 'ci.zerobias.com',
    protocol: 'https',
    port: 443,
    path: '/api/hub'
  },
  jwt: 'eyJhbGciOiJIUzI1NiIs...',
  orgId: 'org-123'
});

const nodes = await client.listNodes();
```

### Hub Module Connector (BaseConnector)

For connectors that invoke operations through Hub Server:

```typescript
import { BaseConnector } from '@zerobias-org/hub-api-client-base';

export class AwsConnector extends BaseConnector {
  constructor() {
    super();
  }

  async listBuckets(): Promise<Bucket[]> {
    // Implementation invokes Hub target
    // (actual invocation logic provided by generated code)
  }
}

// Usage
const connector = new AwsConnector();
await connector.connect('conn-abc123'); // Hub connection ID
const buckets = await connector.listBuckets();
```

## Features

### Connection Management

```typescript
// Connect
await client.connect({
  url: { hostname: 'api.example.com', protocol: 'https' },
  jwt: 'token'
});

// Check connection
const isConnected = await client.isConnected();

// Get metadata
const metadata = await client.metadata();

// Disconnect
await client.disconnect();
```

### Authentication

Supports JWT and API key authentication:

```typescript
// JWT authentication
await client.connect({
  url: { hostname: 'api.example.com' },
  jwt: 'eyJhbGciOiJIUzI1NiIs...'
});

// API key authentication
await client.connect({
  url: { hostname: 'api.example.com' },
  apiKey: 'abc123'
});
```

### Multi-Tenancy (Org Context)

Switch between organizations:

```typescript
await client.connect({
  url: { hostname: 'api.example.com' },
  jwt: 'token',
  orgId: 'org-123'
});

// Switch org context
client.setOrgId('org-456');
```

### Debug Mode

Enable request inspection:

```typescript
// Enable debug mode
client.enableDebug(true);

// Make requests
await client.someOperation();

// Get request history
const inspector = client.getRequestInspector();
const history = inspector?.getRequestHistory();

history?.forEach(record => {
  console.log(`${record.method} ${record.url}`);
  console.log(`Status: ${record.response?.status}`);
  console.log(`Duration: ${record.response?.duration}ms`);
});

// Get statistics
const stats = inspector?.getStatistics();
console.log(`Total requests: ${stats?.total}`);
console.log(`Success rate: ${stats?.successful}/${stats?.total}`);
console.log(`Average duration: ${stats?.averageDuration}ms`);
```

### Custom Request/Response Callbacks

```typescript
client.enableDebug(true);
const inspector = client.getRequestInspector();

inspector?.onRequest(config => {
  console.log(`➡️  ${config.method} ${config.url}`);
});

inspector?.onResponse(response => {
  console.log(`✅ ${response.status} ${response.config.url}`);
});

inspector?.onError(error => {
  console.error(`❌ Request failed: ${error.message}`);
});
```

### Direct HTTP Client Access

For advanced use cases:

```typescript
const axiosClient = client.httpClient();

if (axiosClient) {
  // Add custom interceptor
  axiosClient.interceptors.request.use(config => {
    config.headers['X-Custom-Header'] = 'value';
    return config;
  });

  // Make direct call
  const response = await axiosClient.get('/custom-endpoint');
}
```

## Utilities

### AuthUtils

```typescript
import { jwt, apiKey } from '@zerobias-org/hub-api-client-base';

// JWT formatting
const token = jwt('eyJhbGciOiJIUzI1NiIs...');
// Returns: 'Bearer eyJhbGciOiJIUzI1NiIs...'

// API key formatting
const key = apiKey('abc123');
// Returns: 'APIKey abc123'
```

### PipelineUtil

```typescript
import { ensureRequestPrototype } from '@zerobias-org/hub-api-client-base';

const request = await ensureRequestPrototype(
  inputRequest,
  originalRequest,
  params,
  connectionProfile,
  '/api/hub'
);
// Request is now configured with:
// - Connection profile URL
// - Authentication headers
// - Org context header
// - Full path constructed
```

## API Reference

### BaseApiClient

#### Properties
- `apiInvoker: ApiInvoker` - HTTP client instance
- `connectionProfile?: ConnectionProfile` - Current connection

#### Methods
- `connect(profile: ConnectionProfile): Promise<void>`
- `disconnect(): Promise<void>`
- `isConnected(): Promise<boolean>`
- `metadata(): Promise<ConnectionMetadata>`
- `httpClient(): AxiosInstance | undefined`
- `enableDebug(enabled: boolean): void`
- `getRequestInspector(): RequestInspector | undefined`
- `setOrgId(orgId: string): void`

### BaseConnector

#### Methods
- `connect(targetId: string): Promise<void>`
- `disconnect(): Promise<void>`
- `isConnected(): Promise<boolean>`
- `metadata(): Promise<ConnectionMetadata>`
- `getTargetId(): string | undefined`

### RequestInspector

#### Methods
- `onRequest(callback: (config: AxiosRequestConfig) => void): void`
- `onResponse(callback: (response: AxiosResponse) => void): void`
- `onError(callback: (error: any) => void): void`
- `getRequestHistory(): RequestRecord[]`
- `clearHistory(): void`
- `getStatistics(): Statistics`

## Development

```bash
# Install dependencies
npm install

# Build
npm run build

# Test
npm test

# Clean
npm run clean
```

## License

ISC

## Related Packages

- `@zerobias-org/hub-api-client-devtools` - Development tooling for client generation
- `@zerobias-org/util-codegen` - Code generation engine
- `@zerobias-org/hub-core` - Core types and interfaces
