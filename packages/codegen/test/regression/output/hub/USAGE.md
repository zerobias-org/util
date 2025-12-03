# HubServer SDK Usage Guide

## Installation

```bash
npm install sdk
```

## Quick Start

```typescript
import { newHubServer, HubServerClient } from 'sdk';

// Create client instance
const client = newHubServer();

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

### AccessRuleApi

Access via `client.getAccessRuleApi()`

- `create()` - Creates a new access rule
- `delete()` - Deletes an existing access rule
- `get()` - Retrieves a detailed view of the given access rule
- `list()` - Retrieves a list of access rules
- `update()` - Updates an existing access rule

### AlertApi

Access via `client.getAlertApi()`

- `createTrigger()` - Create an Alert Trigger
- `getAlert()` - Retrieves a list of alerts
- `getAlertLinkTypes()` - Retrieves all alert/resource linktypes available in this application
- `getTrigger()` - Retrieves a trigger
- `listAlerts()` - Retrieves a list of alerts
- `listLinkedResources()` - Retrieves a list of resources that are linked to the given alert alongside linktype information.  This takes away any link that is an &#x60;impactedBy&#x60; link. Those should be queried using listResourcesImpactedByAlert
- `listResourcesImpactedByAlert()` - Retrieves a list of resources that are impacted by the given alert. This is a recursive search where all children of a resource which may be impacted by this alert will be returned Results are orderd by hierarchy level.
- `listTriggers()` - Retrieves a list of triggers

### ConnectionApi

Access via `client.getConnectionApi()`

- `connect()` - Calls &#39;connect&#39; on this connection. This method is only valid if the connection is manually controlled.
- `delete()` - Deletes a connection by ID
- `disconnect()` - Calls &#39;disconnect&#39; on this connection. This method is only valid if the connection is manually controlled.
- `get()` - Retrieves a connection by ID
- `list()` - Lists all connections
- `reverify()` - Attempts to verify the currently-stored ConnectionProfile
- `search()` - 
- `searchOptions()` - 
- `update()` - Updates the ConnectionProfile for this Connection
- `updateConnectionProfile()` - Updates the ConnectionProfile for this Connection
- `updateConnectionProfileSecrets()` - Updates the ConnectionProfile, writing the secrets to the given Secrets Manager

### DeploymentApi

Access via `client.getDeploymentApi()`

- `createConnection()` - Creates a new connection for this deployment.
- `create()` - Create a new Deployment
- `delete()` - Deletes a deployment by ID
- `getConnectionProfile()` - Returns the ConnectionProfile, if any, for this Deployment
- `getConnectionProfileParameters()` - Returns a denormalized view of the ConnectionProfile, if any, for this Deployment
- `get()` - Retrieves a deployment by ID
- `listConnections()` - Retrieves all connections configured for this deployment
- `list()` - Retrieves all deployments
- `search()` - 
- `searchOptions()` - 
- `update()` - Update a deployment

### ExecutionApi

Access via `client.getExecutionApi()`

- `get()` - Get execution detailed information
- `list()` - List operation execution results

### HealthcheckApi

Access via `client.getHealthcheckApi()`

- `health()` - 
- `searchWaiterOptions()` - 
- `searchWaiters()` - 

### ModuleApi

Access via `client.getModuleApi()`

- `getDependencyReport()` - Determines whether or not the given module specification can be satisfied by any targets in the system
- `get()` - Retrieves a Module by ID
- `getModuleVersion()` - Retrieves a single module version
- `getModuleVersionById()` - Retrieves a single module version
- `list()` - Lists all modules available
- `listOperations()` - Retrieves all the operations available on a given ModuleVersion
- `listVersions()` - Retrieves all versions of a given module
- `storeSync()` - Synchronizes the modules in the database with the store

### NodeApi

Access via `client.getNodeApi()`

- `addTag()` - Adds a new tag to the given Node
- `claimNode()` - Claim a node from lost and found
- `create()` - Create a new Registration
- `createNodeDeployment()` - Creates a new Deployment on this Node
- `delete()` - Deletes an node
- `deleteRegistration()` - Delete an registration by ID or code
- `downloadComplianceReport()` - Download the latest compliance scan summary
- `ensureDeployments()` - Forces a node to ensure it and its child nodes deployments
- `getInfo()` - Retrieve an node&#39;s info
- `get()` - Retrieve an node
- `getNodeAvailableLatestVersion()` - Gets latest node version
- `getRegistration()` - Retrieve an registration by ID or code
- `getWritableSecretPath()` - Requests the writable secret path from the Node
- `identify()` - Retrieves node metadata
- `listConnectionsBySecretId()` - Returns all the connections on a node using a secret
- `listConnections()` - Retrieves all connections for this Node
- `listDeploymentsBySecretId()` - Returns all the deployments on a node using a secret
- `listDeployments()` - Lists deployments for this node
- `listDeploymentsSlim()` - Lists deployments for this node
- `listNodeAvailableVersions()` - Lists node versions
- `list()` - Lists all Nodes
- `listRegistrations()` - Lists all unresolved Node registrations
- `listSecretNodes()` - Returns all Nodes root secret keys if path not given or all Nodes secret keys
- `listSharedSecrets()` - Returns all the shared secrets the node is using
- `migrate()` - Migrate deployments from node to node
- `migrateCheck()` - Check if migrate node will have any complications
- `requestComplianceScan()` - Request the node run a compliance scan and return the results file
- `requestRestart()` - Requests that the Node process restart
- `searchConnections()` - 
- `searchConnectionOptions()` - 
- `search()` - 
- `searchOptions()` - 
- `setEnvVar()` - Set an env var on a hub node appliance
- `setVersion()` - Sets the software version of a given node
- `unsetEnvVar()` - Unset an env var on a hub node appliance
- `update()` - Update a node
- `viewComplianceReport()` - View the latest compliance scan summary

### PermissionApi

Access via `client.getPermissionApi()`

- `listEffective()` - Retrieves a list of permissions that are effective against the currently logged on user  and the given resourceId or resourceType.  Note that, if a resourceId is provied, resourceType will not be evaluated.
- `list()` - Retrieves a list of all available permissions

### PrincipalApi

Access via `client.getPrincipalApi()`

- `principalAccessRuleOptions()` - Retrieves options for access rules search for a principal.
- `searchPrincipalAccessRules()` - Searches for access rules that belong to a principal (directly or indirectly through role assignments).

### ResourceApi

Access via `client.getResourceApi()`

- `getPath()` - Retrieves resource path the given resource is associated with as a source or target
- `getResource()` - Returns a resource by ID
- `getResourceTypes()` - Retrieves all types available in this application
- `getTagsForResource()` - Retrieves all Tags assigned to the given resource
- `linkTypeSearch()` - Searches link types by search filter
- `listAlertsImpactingResource()` - Traverses the alert/resource link tree up the way to retrieve a list of alerts that are impacting this resource.
- `listResourceLinkTypes()` - Retrieves resource link types the given resource can be used to link with other resources
- `listResourceLinks()` - Retrieves resource links the given resource is associated with as a source or target
- `listSubAlertsForResource()` - Traverses the alert/resource link tree down the way to retrieve a list of alerts raised against one or more of its children resources
- `listTaggedResources()` - Retrieves resources the given tag is linked to
- `resourceSearch()` - Searches resources by keywords, type, tags, and payload conditions
- `resourceSearchTags()` - Searches tags available in this application against a given resource id
- `resourceSearchTagsOptions()` - Returns options/filters for tags
- `searchResources()` - Searches resources by keywords type and tags
- `tagResource()` - Adds the provided tags to the specified resource
- `untagResource()` - Removes a tag from a resource

### RoleApi

Access via `client.getRoleApi()`

- `addRoleMembers()` - Adds members to a role
- `createRole()` - Creates a new role
- `deleteRole()` - Deletes a role by id
- `getRole()` - Retrieves a role
- `listRolePrincipals()` - Retrieves principals assigned to this role. A boundaryId must be provided for boundary type role.
- `listRoles()` - Retrieves a list of roles
- `removeRoleMember()` - Removes a principal from a role
- `roleAccessRuleOptions()` - Retrieves options for access rules search.
- `rolePrincipalsOptions()` - Returns options/filters for role principals
- `roleSearchByPrincipalOptions()` - Returns options/filters for role search by principal
- `roleSearchOptions()` - Returns options/filters for role
- `searchRoleAccessRules()` - Searches for access rules that that belong to a given role.
- `searchRolePrincipals()` - Search principals assigned to roles
- `searchRoles()` - 
- `searchRolesByPrincipal()` - 
- `updateRole()` - Updates the given role

### ScopeApi

Access via `client.getScopeApi()`

- `connectScope()` - Calls &#39;connect&#39; on this scope. This method is only valid if the connection is manually controlled.
- `create()` - Create a Scope
- `delete()` - Deletes a scope by ID
- `disconnectScope()` - Calls &#39;disconnect&#39; on this scope. This method is only valid if the connection is manually controlled.
- `get()` - Retrieves a scope by ID
- `getSlim()` - Retrieves a scope by ID
- `listAll()` - Lists scopes for a given connection
- `list()` - Lists scopes for a given connection
- `reverifyScope()` - Attempts to verify the currently-stored ConnectionProfile
- `searchOptions()` - 
- `search()` - Search all scopes
- `update()` - Updates this Scope

### SecretApi

Access via `client.getSecretApi()`

- `createOauthSecret()` - Creates a new OAuth secret
- `create()` - Creates a new secret. New secrets will be created as draft and may only be used once taken out of draft. Use &#x60;updateSecret&#x60; to enable a secret.
- `delete()` - Deletes a secret
- `get()` - Retrieves a secret
- `list()` - Lists all defined secrets
- `listSecretsManagers()` - Lists all secrets managers available for node use
- `patchSecretValues()` - Updates the values for the given Secret, writing the secrets to the given Secrets Manager. Only updates the values provided, leaving other values in the profile alone.
- `update()` - Updates a secret
- `updateSecretValues()` - Updates the values for the given Secret, writing the secrets to the given Secrets Manager

### TagApi

Access via `client.getTagApi()`

- `addResourceTypesToTagType()` - Associates the given ResourceTypes with the given Tag Type
- `getResourceTypesForTagType()` - Retrieves a list of all resource types which are associated with the given tag type.
- `getTagTypes()` - Retrieves all tag types available in this application
- `listTags()` - Retrieves a list of tags available in this application
- `searchTags()` - Searches tags available in this application
- `searchTagsOptions()` - Returns options/filters for tags

### TargetApi

Access via `client.getTargetApi()`

- `execute()` - Executes a request against a target
- `get()` - Get a Target
- `getTargetExecutions()` - Lists all execution info for a target
- `getTargetMetadata()` - Returns the metadata from the Target. If this Target is not a &#x60;Connection&#x60;, then nothing is returned
- `getTargetTags()` - Returns all Tags associated with the Target. This cascades up to include tags on the  Connection, Deployment, and Node.
- `isSupported()` - Checks if a given operation is supported
- `list()` - Lists all targets
- `search()` - 
- `searchOptions()` - 


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
  HubServerClient,
  ConnectionProfile,
  // Import models as needed
} from 'sdk';
```

## Additional Resources

- [OpenAPI Spec](./api.yml) - Raw OpenAPI specification
- [manifest.json](./generated/api/manifest.json) - Operation metadata for AI/tooling integration

---
*Generated: 2025-12-03T13:27:14Z*
*Codegen Version: 1.0.12*
