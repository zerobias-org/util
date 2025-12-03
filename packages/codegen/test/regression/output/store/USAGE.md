# StoreApi SDK Usage Guide

## Installation

```bash
npm install sdk
```

## Quick Start

```typescript
import { newStoreApi, StoreApiClient } from 'sdk';

// Create client instance
const client = newStoreApi();

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

### ConnectionProfileApi

Access via `client.getConnectionProfileApi()`

- `get()` - Retrieves a Connection profile
- `listModules()` - List modules that use the connection profile

### EventApi

Access via `client.getEventApi()`

- `get()` - Retrieves an event by id. Every event represents a business event that may have been sent via notifications/subscriptions. All events will have additional properties that may used to filter the results: * resourceId : The id of the resource affected by this event * resourceType: The type of resource affected by this event * keywords/packageNames: set for resources that include those properties. i.e. (vendor/suite/product for keywords, operations/module/product/order for packageNames) * The event payload may be retried via the &#x60;payload&#x60; property.
- `list()` - Retrieves a list of events. Every event represents a business event that may have been sent via notifications/subscriptions. All events will have additional properties that may used to filter the results: * resourceId : The id of the resource affected by this event * resourceType: The type of resource affected by this event * keywords/packageNames: set for resources that include those properties. i.e. (vendor/suite/product for keywords, operations/module/product/order for packageNames) * The event payload may be retried via the &#x60;payload&#x60; property.

### HealthcheckApi

Access via `client.getHealthcheckApi()`

- `health()` - 

### ModuleApi

Access via `client.getModuleApi()`

- `getDependencyReport()` - Generates a report that describes the given Module and Version Range.
- `get()` - Retrieves a module
- `getVersion()` - Retrieves a module version for a given module
- `listOperations()` - Retrieves a list of operations for the given module. The list of operations will contain: * Orderable and Ordered catalog operations. * Active Api operations. * Ordered Operations that have been activated are taken away from this view. * Additionally, Active operations will contain information about operations the ordered operations they are linked to. In most cases, this will be an array of size 1, however this will not always be the case. Operations may be searched by name, using keywords search. The search will match against any operation name or their simbling&#39;s (ordered operations linked to api operations) If &#x60;latest&#x60; is set to true, only Active operations associated with the latest module version will be returned.
- `listModuleVersionOperations()` - Retrieves a list of operations that were published by the given module version * All operations returned by this endpoint are &#x60;active&#x60; api operations. Operations may be searched by name, using keywords search. The search will match against any operation name or their simbling&#39;s (catalog operations linked to api operations)
- `listVersions()` - Retrieves a list of module versions for a given module
- `list()` - Retrieves a list of modules
- `searchOptions()` - Returns options/filters for modules
- `search()` - search modules

### ModuleVersionApi

Access via `client.getModuleVersionApi()`

- `get()` - Retrieves a module version by id
- `listModuleVersionScopes()` - Retrieves a list of scopes for a module version by id

### OperationApi

Access via `client.getOperationApi()`

- `get()` - Retrieves a detailed operation with examples and content type
- `list()` - Retrieves a list of operations The list of operations will contain:

  * Orderable and Ordered catalog operations.
  * Active Api operations.
  * Ordered Operations that have been activated are taken away from this view.
  * Additionally, Active operations will contain information about operations the ordered operations they are linked to.
    In most cases, this will be an array of size 1, however this will not always be the case.
Operations may be searched by name, using keywords search. The search will match against any operation name or their simbling&#39;s (ordered operations linked to api operations). If &#x60;latest&#x60; is set to true, only Active operations associated with the latest module version(s) will be returned.

### OrderApi

Access via `client.getOrderApi()`

- `addItems()` - Adds an item to an order. This is currently only supported for product orders which may contain a single product id.
- `create()` - Create an order. One of 3 order types may be requested:
  * product: A low fidelity product order
  * catalog: Cataloging request for an existing verified product
  * operation: Operations from an active cataloged product

An Operation order is a high fidelity order that may contain up to 10 operations that belong to the same module.
  * Operation orders may only contain &#x60;orderable&#x60; operations. 
  * Any order containing operations that aren&#39;t &#x60;orderable&#x60; will be vetoed.
A Product order is a low fidelity order that may contain information on a new product and its vendor and suite parent(s)
  * The output of such an order is one or more products in the &#x60;verified&#x60; status
A catalog order is a request to catalog a newly verified product.
  * The output of such an order is a fully cataloged product with a new module that can connect to the given product
  * Catalog orders have to go through business and lab analysis in order to lay out cost.

All order types may be provided a custom json context that is set by the customer.
- `get()` - Retrieves details about the given order
- `list()` - Retrieves a list of orders
- `removeItems()` - Removes items from an order.
- `patch()` - Updates an order

### ProductApi

Access via `client.getProductApi()`

- `getModuleCompatibilityMatrix()` - Retrieves a products compatibility matrix.
- `get()` - Retrieves detailed information about a product
- `getProductCompatibilityMatrix()` - Retrieves a products compatibility matrix. This operation has been deprecated and will be replaced by getModuleCompatibilityMatrix &#x60;/products/{packageName}/moduleCompatibility&#x60;
- `listVersions()` - Retrieves a product
- `list()` - Retrieves a list of products

### ReportApi

Access via `client.getReportApi()`

- `getCatalogSummary()` - Generates a catalog summary report.

### ResourceApi

Access via `client.getResourceApi()`

- `getResource()` - Returns a resource by ID
- `getResourceTypes()` - Retrieves all types available in this application
- `getTagsForResource()` - Retrieves all Tags assigned to the given resource
- `resourceSearch()` - Searches resources by keywords, type, tags, and payload conditions
- `searchResources()` - Searches resources by keywords type and tags
- `tagResource()` - Adds the provided tags to the specified resource
- `untagResource()` - Removes a tag from a resource

### SuiteApi

Access via `client.getSuiteApi()`

- `get()` - Retrieves a suites details by vendor and suite
- `listProducts()` - Retrieves products associated with a vendor and suite
- `list()` - Retrieves a list of suites

### TagApi

Access via `client.getTagApi()`

- `addResourceTypesToTagType()` - Associates the given ResourceTypes with the given Tag Type
- `getResourceTypesForTagType()` - Retrieves a list of all resource types which are associated with the given tag type.
- `getTagTypes()` - Retrieves all tag types available in this application
- `listTags()` - Retrieves a list of tags available in this application

### VendorApi

Access via `client.getVendorApi()`

- `get()` - Retrieves a vendor
- `listProducts()` - Retrieves products associated with a vendor
- `listSuites()` - Retrieves product suites associated with a vendor
- `list()` - Retrieves a list of vendors


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
  StoreApiClient,
  ConnectionProfile,
  // Import models as needed
} from 'sdk';
```

## Additional Resources

- [OpenAPI Spec](./api.yml) - Raw OpenAPI specification
- [manifest.json](./generated/api/manifest.json) - Operation metadata for AI/tooling integration

---
*Generated: 2025-12-03T13:25:02Z*
*Codegen Version: 1.0.12*
