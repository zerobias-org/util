# PortalApi SDK Usage Guide

## Installation

```bash
npm install sdk
```

## Quick Start

```typescript
import { newPortalApi, PortalApiClient } from 'sdk';

// Create client instance
const client = newPortalApi();

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

### AlertBotApi

Access via `client.getAlertBotApi()`

- `get()` - Get alert bot
- `list()` - list all alertBots
- `options()` - Returns options/filters for alert bots
- `usageSearch()` - Search alertBot usage
- `usageOptions()` - Returns options/filters for alert bots
- `search()` - Search alertBots

### AlertBotVersionApi

Access via `client.getAlertBotVersionApi()`

- `get()` - Get alert bot Version
- `search()` - Search alertBotVersions
- `options()` - Returns options/filters for alert bot versions

### AttackPatternApi

Access via `client.getAttackPatternApi()`

- `get()` - Returns given attack pattern by id
- `searchOptions()` - Returns options/filters for attack patterns
- `search()` - Search all catalog attack patterns

### AuditgraphApi

Access via `client.getAuditgraphApi()`

- `boundaryObjectSearchByClassColumns()` - Get column information for boundary object search for a class
- `boundaryObjectSearchByClass()` - Search through objects within a boundary for a specific class
- `getAuditGraphHomePage()` - Lists auditgraph home page folders with queries/classes and object counts

### BenchmarkApi

Access via `client.getBenchmarkApi()`

- `getBenchmarkElementCrosswalkChain()` - Get benchmark element crosswalk chain
- `getBenchmarkElementOverview()` - Get benchmark element overview
- `getOverview()` - Get benchmark overview
- `list()` - list all benchmarks
- `searchBenchmarkElementCrosswalkElementOptions()` - Returns options/filters for benchmark elements crosswalk elements
- `searchBenchmarkElementCrosswalkElements()` - Search benchmark element crosswalk elements
- `searchElementOptions()` - Returns options/filters for benchmark elements
- `searchBenchmarkElements()` - search benchmark elements within a benchmark
- `searchOptions()` - Returns options/filters for benchmarks
- `search()` - search benchmarks

### BoundaryApi

Access via `client.getBoundaryApi()`

- `listProducts()` - Retrieves a list of products in a boundary with pipeline info

### BoundaryAlertApi

Access via `client.getBoundaryAlertApi()`

- `get()` - Get boundary alert
- `options()` - Returns options/filters for boundary alerts
- `boundaryAlertSubjectOptions()` - Returns options/filters for boundary alert subjects
- `searchSubjects()` - Search a boundaryAlert&#39;s subjects
- `search()` - Search boundaryAlerts

### BoundaryAlertBotApi

Access via `client.getBoundaryAlertBotApi()`

- `get()` - Get boundary alert bot
- `options()` - Returns options/filters for alert bots
- `search()` - Search boundaryAlertBots

### BoundaryClassApi

Access via `client.getBoundaryClassApi()`

- `get()` - Get boundary classes
- `options()` - Returns options/filters for boundary classes
- `search()` - Search boundary classes

### BoundaryGraphqlQueryApi

Access via `client.getBoundaryGraphqlQueryApi()`

- `get()` - Get boundary graphql queries
- `search()` - Search boundary graphql queries
- `options()` - Returns options/filters for boundary graphql queries

### CatalogApi

Access via `client.getCatalogApi()`

- `searchClasses()` - Search all catalog classes
- `searchSchemas()` - Search all catalog schemas
- `createRequest()` - Create a new catalog request
- `createRequestComment()` - Create a comment on a catalog request
- `deleteRequestComment()` - Delete a comment on a catalog request
- `getOverviewCounts()` - Returns overview counts info for auditlogic catalog
- `getOverviewSkeleton()` - Returns overview skeleton info for auditlogic catalog
- `getRequest()` - Get a catalog request
- `getSchema()` - Returns overview info for auditlogic catalog
- `listRequestComments()` - List a catalog request&#39;s comments
- `listRequests()` - List catalog requests
- `objectSearchByClassColumns()` - Get column information for object search for a class
- `objectSearchByClass()` - Search through objects within the catalog for a specific class
- `objectSearchMetadataByClass()` - Search through objects within the catalog for a class and returns metadata about results that would be returned by objectSearch
- `removeRequestUpvote()` - Remove a catalog request upvote
- `searchRequests()` - Search catalog requests
- `searchRequestsOptions()` - Returns options/filters for catalog requests
- `updateRequestComment()` - Update a comment on a catalog request
- `upvoteRequest()` - Upvote a catalog request

### ClassApi

Access via `client.getClassApi()`

- `get()` - Get class by id or name
- `list()` - List classes
- `search()` - Search all catalog classes
- `searchClassesOptions()` - Returns options/filters for classes

### CollectorBotApi

Access via `client.getCollectorBotApi()`

- `get()` - Get collector bot by id
- `listVersions()` - Page versions for specified collector bot
- `search()` - Search all catalog collector bots
- `searchCollectorBotsOptions()` - Returns options/filters for collector bots

### ComplianceFeatureApi

Access via `client.getComplianceFeatureApi()`

- `get()` - Get compliance feature by id
- `getVersion()` - Get a compliance feature version
- `listComplianceFeatureTypes()` - Returns compliance feature types
- `listVersionsSlim()` - List a compliance features versions slim
- `list()` - List all compliance features
- `search()` - Search compliance features
- `searchColumnOptions()` - Returns search options for compliance features by columnName and search
- `searchComplianceFeaturesOptions()` - Returns options/filters for compliance features

### ComplianceServiceApi

Access via `client.getComplianceServiceApi()`

- `get()` - Get compliance service
- `search()` - list all catalog compliance services
- `searchComplianceServicesOptions()` - Returns options/filters for compliance services

### CountermeasureApi

Access via `client.getCountermeasureApi()`

- `get()` - Returns extended view of countermeasure given
- `searchCountermeasureOptions()` - Returns options/filters for countermeasures
- `search()` - Search all countermeasures

### CrosswalkApi

Access via `client.getCrosswalkApi()`

- `get()` - Get a crosswalk
- `getVersion()` - Get a crosswalk version
- `searchOptions()` - Returns options/filters for crosswalks
- `searchVersionElementOptions()` - Returns options/filters for crosswalk version element search
- `searchVersionElements()` - Search crosswalk version elements
- `searchVersionOptions()` - Returns options/filters for crosswalk versions
- `searchVersions()` - Search crosswalk versions
- `search()` - Search crosswalks
- `suggestZerobiasElement()` - Suggested a new crosswalk element

### CyberArtifactApi

Access via `client.getCyberArtifactApi()`

- `get()` - Returns extended view of cyber artifact given
- `searchCyberArtifactOptions()` - Returns options/filters for cyber artifacts
- `search()` - Search all cyber artifacts

### EvidenceBotApi

Access via `client.getEvidenceBotApi()`

- `get()` - Get evidence bot
- `list()` - List evidenceBots
- `search()` - Search all evidence bots
- `searchOptions()` - Returns options/filters for evidence bots

### FindingApi

Access via `client.getFindingApi()`

- `getFindingExtended()` - Get finding overview
- `listFindings()` - List all findings
- `searchFindings()` - Search findings
- `searchFindingsOptions()` - Returns options/filters for finding

### FrameworkApi

Access via `client.getFrameworkApi()`

- `getFrameworkElementCrosswalkChain()` - Get framework element crosswalk chain
- `getFrameworkElementOverview()` - Get framework element overview
- `getOverview()` - Get framework overview
- `list()` - list all frameworks
- `searchFrameworkElementCrosswalkElementOptions()` - Returns options/filters for framework elements crosswalk elements
- `searchFrameworkElementCrosswalkElements()` - Search framework element crosswalk elements
- `searchElementOptions()` - Returns options/filters for framework elements
- `searchFrameworkElements()` - search framework elements within a framework
- `searchOptions()` - Returns options/filters for frameworks
- `search()` - search frameworks

### GraphqlQueryApi

Access via `client.getGraphqlQueryApi()`

- `search()` - search graphql queries
- `searchOptions()` - Returns options/filters for graphql queries
- `usageSearch()` - Search graphql query usage
- `usageOptions()` - Returns options/filters for graphql queries

### GraphqlQueryVersionApi

Access via `client.getGraphqlQueryVersionApi()`

- `get()` - Get a graphql query version

### HealthcheckApi

Access via `client.getHealthcheckApi()`

- `health()` - 

### InternalControlApi

Access via `client.getInternalControlApi()`

- `list()` - List internal controls for UI given a boundary and internal domain id

### KbArticleApi

Access via `client.getKbArticleApi()`

- `searchOptions()` - Returns options/filters for kb articles
- `search()` - search kb articles

### MitigationApi

Access via `client.getMitigationApi()`

- `get()` - Returns extended view of mitigation given
- `searchMitigationOptions()` - Returns options/filters for mitigations
- `search()` - Search all mitigations

### NavigationApi

Access via `client.getNavigationApi()`

- `getCMDBData()` - Retrieves needed values for organization/user handling
- `getNavigationItems()` - Retrieves navigation items

### OrchestrationApi

Access via `client.getOrchestrationApi()`

- `createPortalOrganization()` - Creates a new portal organization
- `createUserInvite()` - Creates a new user invite

### PartyApi

Access via `client.getPartyApi()`

- `get()` - Get boundary party
- `searchBoundary()` - Search for parties within a boundary
- `searchBoundaryPartiesOptions()` - Returns options/filters for parties in a boundary

### PipelineApi

Access via `client.getPipelineApi()`

- `searchPipelines()` - Search pipelines
- `searchPipelinesOptions()` - Returns options/filters for pipeline

### PolicyApi

Access via `client.getPolicyApi()`

- `list()` - List policy evidence file information for a policy evidence definition

### ProductApi

Access via `client.getProductApi()`

- `compareComplianceFeatures()` - Compare compliance features and supported controls to product editions that support them within a product
- `get()` - Get product
- `getVersion()` - Get a product version
- `listVersionsSlim()` - List a products versions slim
- `list()` - List products
- `searchComplianceFeatures()` - Search compliance features by product version
- `searchColumnOptions()` - Returns search options for compliance features by columnName and search
- `searchComplianceFeaturesOptions()` - Returns options/filters for compliance features
- `searchComponents()` - Search a products components
- `searchComponentsOptions()` - Returns options/filters for product components
- `searchEditions()` - Search a products editions
- `searchEditionsOptions()` - Returns options/filters for product editions
- `search()` - Search products
- `searchProductsOptions()` - Returns options/filters for product

### ResourceApi

Access via `client.getResourceApi()`

- `getLink()` - Get resource link for a resource

### SchemaApi

Access via `client.getSchemaApi()`

- `get()` - Returns overview info for auditlogic catalog
- `search()` - Search all catalog schemas
- `searchSchemasOptions()` - Returns options/filters for schemas

### SegmentApi

Access via `client.getSegmentApi()`

- `compareComplianceFeatures()` - Compare compliance features and supported controls to products and their editions that support them within a segment
- `get()` - Get segment
- `getVersion()` - Get a segment version
- `listSegmentTypes()` - Returns segment types
- `listVersionsSlim()` - List a segments versions slim
- `searchComplianceFeatures()` - Search compliance features by segment version
- `searchColumnOptions()` - Returns search options for compliance features by columnName and search
- `searchComplianceFeaturesOptions()` - Returns options/filters for compliance features
- `search()` - list all catalog segments
- `searchSegmentsOptions()` - Returns options/filters for segments

### ServerApi

Access via `client.getServerApi()`

- `getServerSpec()` - Retrieves the server specification OpenAPI file
- `ping()` - Pings the server to make sure it&#39;s live and authentication is successful

### SlimApi

Access via `client.getSlimApi()`

- `listBoundaryProducts()` - List all boundary products slim

### StandardApi

Access via `client.getStandardApi()`

- `elementCrosswalkGraph()` - Returns standard elements crosswalk graph
- `getBoundaryStandardBaselineControlTree()` - Get boundary standard baseline control tree
- `getBoundaryStandardBaselineFilterTree()` - Get standard filter tree
- `getBoundaryStandardBaselineMetrics()` - List boundary standard baseline metrics
- `getElementCrosswalkChain()` - Get element crosswalk chain
- `get()` - Get standard by id
- `getElement()` - Get standard element by id
- `getFilterTree()` - Get standard filter tree
- `getFilters()` - Get standard filters
- `searchElementComplianceFeatureColumnOptions()` - Returns search options for standard element compliance features by columnName and search
- `searchElementComplianceFeatureOptions()` - Returns options/filters for standard element compliance features
- `searchElementComplianceFeatures()` - Search element compliance features
- `searchElementCrosswalkElementOptions()` - Returns options/filters for standard elements crosswalk elements
- `searchElementCrosswalkElements()` - Search element crosswalk elements
- `searchElementOptions()` - Returns options/filters for standard elements
- `searchElements()` - search elements within a standard
- `search()` - search standards
- `searchByType()` - search standards by type
- `searchStandardsByTypeOptions()` - Returns options/filters for standards by type
- `searchStandardsOptions()` - Returns options/filters for standards

### SuiteApi

Access via `client.getSuiteApi()`

- `deleteSuggested()` - Delete a suggested suite
- `get()` - Get suite
- `list()` - List suites
- `patchSuggested()` - Patch a suggested suite
- `publishSuggested()` - Publish a suggested suite
- `search()` - Search suites
- `searchSuitesOptions()` - Returns options/filters for suite
- `suggest()` - Suggested a new suite

### TacticApi

Access via `client.getTacticApi()`

- `get()` - Returns extended view of tactic given
- `searchTacticOptions()` - Returns options/filters for tactics
- `search()` - Search all tactics

### TagRuleApi

Access via `client.getTagRuleApi()`

- `get()` - Get tag rule
- `options()` - Returns options/filters for tag rules
- `search()` - Search Tag Rules

### TaskApi

Access via `client.getTaskApi()`

- `get()` - Get task
- `listPhases()` - list task status phases
- `listStatuses()` - list task statuses with phase and rank information
- `myTasks()` - list tasks related to current authenticated user
- `myTasksOptions()` - Returns options/filters for current user&#39;s tasks
- `search()` - list all tasks
- `searchTasksOptions()` - Returns options/filters for tasks

### TechniqueApi

Access via `client.getTechniqueApi()`

- `get()` - Returns extended view of technique given
- `searchTechniqueOptions()` - Returns options/filters for techniques
- `search()` - Search all techniques

### TestCaseApi

Access via `client.getTestCaseApi()`

- `get()` - Get test case
- `getFilters()` - Get test_case filters
- `list()` - list all catalog test cases
- `search()` - list all catalog test cases
- `searchTestCasesOptions()` - Returns options/filters for test case

### TestSuiteApi

Access via `client.getTestSuiteApi()`

- `get()` - Get test case
- `getFilters()` - Get test suite filters
- `list()` - list all catalog test suites
- `searchOptions()` - Returns options/filters for test suites
- `searchTestCases()` - list test cases within a test suite
- `search()` - list all catalog test suites

### VendorApi

Access via `client.getVendorApi()`

- `deleteSuggested()` - Delete a suggested vendor
- `get()` - Get vendor
- `list()` - List vendors
- `patchSuggested()` - Patch a suggested vendor
- `publishSuggested()` - Publish a suggested vendor
- `search()` - Search vendors
- `searchVendorsOptions()` - Returns options/filters for vendor
- `suggest()` - Suggested a new vendor

### VulnerabilityApi

Access via `client.getVulnerabilityApi()`

- `get()` - Returns overview info for auditlogic catalog
- `search()` - Search all catalog vulnerabilitys
- `searchVulnerabilitysOptions()` - Returns options/filters for vulnerabilitys

### WeaknessApi

Access via `client.getWeaknessApi()`

- `get()` - Returns overview info for auditlogic catalog
- `search()` - Search all catalog weaknesss
- `searchWeaknesssOptions()` - Returns options/filters for weaknesss


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
  PortalApiClient,
  ConnectionProfile,
  // Import models as needed
} from 'sdk';
```

## Additional Resources

- [OpenAPI Spec](./api.yml) - Raw OpenAPI specification
- [manifest.json](./generated/api/manifest.json) - Operation metadata for AI/tooling integration

---
*Generated: 2025-12-03T13:26:40Z*
*Codegen Version: 1.0.12*
