# @zerobias-org/util-connector

TypeScript connector implementation for hub and modules utilizing hub.

## Installation

```bash
npm install @zerobias-org/util-connector
```

## Usage

### Connector Interface

The `Connector` interface defines the contract for modules that require a connection to an external system:

```typescript
import { Connector } from '@zerobias-org/util-connector';

interface Connector<ProfileType, StateType> {
  connect(connectionProfile: ProfileType, oauthConnectionDetails?: OauthConnectionDetails): Promise<StateType>;
  isConnected(): Promise<boolean>;
  disconnect(): Promise<void>;
  refresh?(connectionProfile: ProfileType, connectionState: StateType, oauthConnectionDetails?: OauthConnectionDetails): Promise<StateType>;
  metadata(): Promise<ConnectionMetadata>;
  isSupported(operationId: string): Promise<OperationSupportStatusDef>;
  httpClient?(): AxiosInstance | undefined;
}
```

### HubConnector

The `HubConnector` class provides a ready-to-use implementation for connecting to hub targets:

```typescript
import { HubConnector } from '@zerobias-org/util-connector';
import { HubConnectionProfile } from '@zerobias-org/types-core-js';

const connector = new HubConnector();

// Connect using a hub connection profile
await connector.connect({
  server: {
    protocol: 'https',
    host: 'api.example.com',
    path: '/v1',
    search: '',
    hash: '',
    relative: false
  },
  targetId: 'my-target-id',
  apiKey: 'your-api-key',
  orgId: 123
});

// Check connection status
const connected = await connector.isConnected();

// Get connection metadata
const metadata = await connector.metadata();

// Access the underlying HTTP client for custom requests
const client = connector.httpClient();

// Disconnect when done
await connector.disconnect();
```

## API

### HubConnector Methods

| Method | Description |
|--------|-------------|
| `connect(profile)` | Establishes connection to the hub target |
| `isConnected()` | Returns whether the connector is currently connected |
| `disconnect()` | Cleanly disconnects from the target service |
| `metadata()` | Returns metadata about the connection |
| `isSupported(operationId)` | Checks if an operation is supported by the target |
| `httpClient()` | Returns the underlying Axios instance |

## Dependencies

- `@zerobias-org/types-core-js` - Core type definitions
- `@zerobias-org/logger` - Logging utilities
- `axios` - HTTP client
