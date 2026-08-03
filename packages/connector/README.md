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
| `configureRetry(config)` | Overrides the retry policy; must be called before `connect()` |

### Static members

| Member | Description |
|--------|-------------|
| `HubConnector.hasNativeRetry` | `true` — this build retries transient failures itself |
| `HubConnector.onInstance(cb)` | Fires `cb` for every current and future connector instance |
| `HubConnector.removeOnInstance(cb)` | Removes a previously registered callback |

## Transient failure retry

`connect()` installs a retry interceptor on the axios instance it creates, so every module
built on `HubConnector` gets it — including the metadata call `connect()` itself makes.

Two failure classes share one budget:

- **Transport** — nothing came back off the wire (`ECONNRESET`, `ETIMEDOUT`, …). Usually a
  reused idle socket the peer had already closed, so the first retry is free and immediate.
- **Unavailability** — the target is temporarily gone. Walks an exponential ladder with full
  jitter; jitter matters because one node blip fails many callers at once.

Triggering is deliberately **not** status-based. Hub answers some dispatch failures with HTTP
200 plus `hub-error` / `hub-error-status` headers, so the retry derives an effective status
from those headers. That bucket also holds genuine module failures, which are not safe to
replay, so an `hub-error` response must *also* name a self-resolving condition (a dropped node,
a waiter timeout, a container still starting) before it is retried.

Only idempotent methods are replayed — `POST` and `PATCH` are excluded, because a reset can
arrive after the server already applied the request. Bodies consumed by the first attempt
(streams, `FormData`) are never replayed. `retry-after` is honoured when present, capped.

Defaults match what hub-client's runtime patch already ran with in production. The ladder's
floor (~34s) is sized to outlast a node reconnect, which fires on a 30s timer with ±2.5s jitter.

| Variable | Default | Purpose |
|---|---|---|
| `HUB_CONNECTOR_RETRY_ATTEMPTS` | `6` | Total attempts including the first; `1` disables retrying |
| `HUB_CONNECTOR_RETRY_BASE_MS` | `4000` | Backoff base |
| `HUB_CONNECTOR_RETRY_MAX_MS` | `20000` | Backoff ceiling |
| `HUB_CONNECTOR_RETRY_IMMEDIATE_FIRST` | `true` | Free 0ms first retry for transport failures |
| `HUB_CONNECTOR_RETRY_STATUSES` | `502,503,504,598` | Statuses treated as unavailability |
| `HUB_CONNECTOR_RETRY_METHODS` | `GET,HEAD,OPTIONS,PUT,DELETE` | Methods eligible for replay |
| `HUB_CONNECTOR_RETRY_BREAKER_THRESHOLD` | `5` | Consecutive failures before a target fails fast; `0` disables |

The equivalent `HUB_CLIENT_*` names are accepted as a fallback, so deployments already tuning
hub-client's patch keep their settings. Per-connector overrides go through `configureRetry()`.

### Telling a transport blip from a server answer

`HubConnector` normalizes every failure into a `CoreError` so that circular axios references
never reach anything serialized. `CoreError.from()` discards the underlying system code in the
process, so the signal is re-attached to the resulting error and can be read with a predicate
rather than by matching message text:

```typescript
import { isTransportFailure } from '@zerobias-org/util-connector';

try {
  await client.getUsers();
} catch (error) {
  if (isTransportFailure(error)) {
    // a dropped socket, not the module's answer — (error as any).code is e.g. 'ECONNRESET'
  }
}
```

The marker is two non-enumerable primitives (`transient`, `code`). It is in-process only: it
does not change `toJSON()` and does not survive an HTTP hop.

## Dependencies

- `@zerobias-org/types-core-js` - Core type definitions
- `@zerobias-org/logger` - Logging utilities
- `axios` - HTTP client
