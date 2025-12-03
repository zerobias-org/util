# PlatformApi SDK Usage Guide

## Installation

```bash
npm install sdk
```

## Quick Start

```typescript
import { newPlatformApi, PlatformApiClient } from 'sdk';

// Create client instance
const client = newPlatformApi();

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

### ActivityApi

Access via `client.getActivityApi()`

- `get()` - Get activity by id
- `list()` - list all activities
- `listLinkTypes()` - list all link types available for this activity

### AdminApi

Access via `client.getAdminApi()`

- `claimVendor()` - Requests to claim vendor for org
- `createOrgInvitation()` - Add a new organization invitation
- `createOrgProfile()` - Add a new organization profile
- `getOrgInvitation()` - Retrieves an organization invitation
- `getOrgProfile()` - Retrieves an org profile view
- `getOrgUsageMetric()` - Retrieves an organization usage metrics
- `listAuditMetrics()` - Retrieves metrics of the evidence assessments data for all audits of an organization
- `listBoundaryMetrics()` - Retrieves metrics of the data for all boundaries of an organization
- `listOrgInvitations()` - List all organization invitations
- `listOrgMonthlyUsageMetrics()` - List all organization monthly usage metrics
- `listOrgProfiles()` - List all organization profiles
- `listOrgsMonthlyUsageReports()` - List organizations monthly usage report
- `listOrgsMonthlyUsageReportsCsv()` - List organizations monthly usage report
- `listUserInvitations()` - List user invitations for org
- `requestVendor()` - Requests that a public cataloged vendor for this org
- `updateOrgInvitation()` - Update an organization profile
- `updateOrgProfile()` - Update an organization profile

### AlertApi

Access via `client.getAlertApi()`

- `createTrigger()` - Create an Alert Trigger
- `getAlert()` - Retrieves a list of alerts
- `getAlertLinkTypes()` - Retrieves all alert/resource linktypes available in this application
- `getTrigger()` - Retrieves a trigger
- `listAlerts()` - Retrieves a list of alerts
- `listImpactedResourcesOptions()` - Returns options/filters for resources impacted by an alert
- `listLinkedResources()` - Retrieves a list of resources that are linked to the given alert alongside linktype information.  This takes away any link that is an &#x60;impactedBy&#x60; link. Those should be queried using listResourcesImpactedByAlert
- `listLinkedResourcesOptions()` - Returns options/filters for resources associated with an alert
- `listResourcesImpactedByAlert()` - Retrieves a list of resources that are impacted by the given alert. This is a recursive search where all children of a resource which may be impacted by this alert will be returned Results are orderd by hierarchy level.
- `listTriggers()` - Retrieves a list of triggers

### AlertBotApi

Access via `client.getAlertBotApi()`

- `get()` - Get an alert bot
- `update()` - Update alert bot

### ArtifactApi

Access via `client.getArtifactApi()`

- `getArtifact()` - Gets an artifact currently installed on the system and update info
- `getArtifactTask()` - Gets an artifact task by id
- `listArtifactTasks()` - Lists all artifact tasks
- `listArtifactTypes()` - Lists all artifact types the system supports
- `listArtifactUpdates()` - Lists all artifacts installeds update status
- `listArtifacts()` - Lists all artifacts currently installed on the system
- `validateArtifact()` - Validates if an artifact exists for load, with optional version

### AuditApi

Access via `client.getAuditApi()`

- `cloneEvidenceFile()` - Clone evidence files from an audit to another
- `createAssessmentResult()` - Create a new assessment result
- `createAudit()` - Create a new audit
- `createAuditMessage()` - Creates an audit message
- `createEvidenceFile()` - Add a new evidence file to an audit
- `deleteAssessmentResult()` - Deletes an assessment results and their artifacts
- `deleteAudit()` - Deletes an audit and all linked audit messages and evidence assessments
- `deleteEvidenceFile()` - Deletes an evidence file from an audit
- `getAudit()` - Retrieves an audit
- `getAuditEvidenceAssessment()` - Retrieves an audit evidence assessment
- `getAuditMetrics()` - Retrieves metrics of the evidence assessments data for an specific audit
- `listAssessmentResults()` - Retrieves a list of all assessment results
- `listAuditEvidenceAssessments()` - Retrieves a list of and audits evidence assessments
- `listAuditMessages()` - Retrieves a list of all audit messages
- `listAudits()` - Retrieves a list of all audits
- `listEvidenceFiles()` - List all evidence files by an audit id
- `updateAssessmentResult()` - Updates an assessment result
- `updateAudit()` - Updates an audit
- `updateAuditEvidenceAssessmentAssignee()` - Assign or unassign evidence assessment to a user
- `updateEvidenceAssessment()` - Updates an evidence assessment

### BatchApi

Access via `client.getBatchApi()`

- `addBatchItem()` - Adds an item to a batch
- `addBatchItems()` - Add all Batch Items included in this array to the given batch
- `createBatch()` - Creates/Starts a batch
- `createBatchLog()` - Creates a log associated with a batch
- `endBatch()` - Ends a batch import
- `getBatchChainOfCustody()` - Generates a chain of custody for a batch by id
- `listBatchItems()` - Lists batch items by batch ID
- `listBatchLogs()` - Lists batch logs by batch ID
- `listBatches()` - Lists batches in the system, sorted by date
- `listObjectVersions()` - Lists object versions by batch ID
- `markDeleted()` - Mark Batch Item as deleted

### BenchmarkApi

Access via `client.getBenchmarkApi()`

- `browseBenchmarkBaselineElement()` - Browse benchmark baseline element
- `browseBenchmarkBaselineElements()` - Browse benchmark baseline elements
- `browseBenchmarkBaselines()` - Browse benchmark baselines
- `browseBenchmarks()` - Browse benchmarks
- `get()` - Get benchmark by id
- `getBaseline()` - Get baseline by benchmark and baseline id
- `getBaselineElement()` - Get element by benchmark and baseline and element id
- `getElement()` - Get element by benchmark and element id
- `getTestCase()` - Get test case by benchmark and test case id
- `listBaselineElements()` - list all benchmark baseline elements
- `listBaselines()` - list all benchmark baselines
- `listElements()` - list all benchmark elements
- `listTestCases()` - list all benchmark test cases
- `list()` - list all benchmarks

### BoundaryApi

Access via `client.getBoundaryApi()`

- `addCrosswalkVersion()` - Add crosswalk versions to boundary
- `addStandardBaseline()` - Add standard baseline to boundary
- `addStandardBaselineElements()` - Choose elements that are in scope for boundary standard baseline
- `deleteSubscription()` - Removes a subscription from a boundary alert bot
- `addSubscription()` - Adds a subscription to a boundary alert bot
- `boundaryExecuteQuery()` - Executes a query within the given boundary. (not implemented)
- `boundaryKeywordSearch()` - Searches for filters, queries, and keywords within boundary for given keyword
- `boundaryKeywordSearchForClass()` - Searches for keywords within boundary for given class and keyword
- `boundaryObjectCount()` - Retrieves object counts for class given in filter
- `boundaryObjectSearch()` - Search through objects within a boundary
- `boundaryObjectSearchMetadata()` - Search through objects within a boundary and returns metadata about results that would be returned by objectSearch
- `boundarySearch()` - Search accross objects, resources and tags within a boundary
- `createBoundary()` - Create a new boundary
- `createBoundaryEvent()` - Create a new boundary Event
- `createBoundaryEvidence()` - Create a new boundary Event
- `createBoundaryParty()` - Create a new boundary party
- `createBoundaryPartyRole()` - Create new boundary party role
- `createBoundaryProduct()` - Create a new boundary product
- `createBoundaryProductTarget()` - Create a new boundary product target
- `createBoundaryTeam()` - Create a new boundary team
- `createSuggestedProduct()` - Create a new suggested product
- `deleteBoundary()` - Deletes a boundary
- `deleteAlertBot()` - Deletes a boundary query alert bot
- `deleteBoundaryPartyRole()` - Delete boundary party role
- `deleteBoundaryPartyRoles()` - Delete boundary party roles by boundary id
- `deleteBoundaryProductTargets()` - Deletes target for a boundary product
- `deleteBoundaryProducts()` - Deletes products for a boundary
- `deleteBoundaryTeam()` - Deletes a boundary team
- `deleteEventsForBoundary()` - Deletes events for a boundary
- `disableBoundaryTeamScfControlEvidenceDefinition()` - Disables a boundary team scf control evidence definition implementation
- `enableBoundaryTeamScfControlEvidenceDefinition()` - Enables a boundary team scf control evidence definition implementation
- `getAnyBoundaryProduct()` - Retrieves a boundary product
- `getBoundary()` - Retrieves a boundary
- `getBoundaryAlert()` - Retrieves extended information about a boundary alert
- `getBoundaryComponent()` - Get boundary component
- `getBoundaryConnectionOverview()` - Retrieves a boundary product
- `getBoundaryDomainSummary()` - Retrieves domains summary info for a boundary
- `getBoundaryEvidence()` - Retrieves a boundary evidence record
- `getBoundaryMetrics()` - Retrieves metrics of the data for a specific boundary
- `getBoundaryParty()` - Retrieves a party for a boundary
- `getBoundaryPartyRole()` - Get boundary party role
- `getBoundaryProduct()` - Retrieves a boundary product
- `getBoundaryProductConnectionOverview()` - Retrieves a boundary product
- `getBoundaryProductOverview()` - Retrieves a boundary product overview
- `getBoundaryScfControl()` - Retrieves a scf control for a boundary
- `getStandardBaseline()` - Get standard baseline that has been added to a boundary
- `getStandardBaselineFilterTree()` - Get element by standard and baseline and element id
- `getBoundarySuggestedProductOverview()` - Retrieves a boundary suggested product overview
- `getBoundaryTaskMetrics()` - Retrieves task metrics for a specific boundary
- `getBoundaryTeam()` - Retrieves a team for a boundary
- `getBoundaryTeamDomainSummary()` - Retrieves domains summary info for a boundary team
- `getBoundaryTeamMetric()` - Retrieves a teams metrics for a boundary
- `getBoundaryTeamScfControl()` - Retrieves scf control data for a boundary team
- `getBoundaryTeamScfControlDetails()` - Retrieves a scf control defailts within a boundary team
- `getBoundaryTeamScfControlOverview()` - Retrieves a list of scf controls for a boundary in a tree form
- `getBoundaryTeamScfControlTree()` - Retrieves a list of scf controls for a boundary in a tree form
- `getTest()` - List test within a boundary by id
- `listAllBoundaryProducts()` - Retrieves a list of all products for a boundary
- `listBoundaries()` - Retrieves a list of all boundaries
- `listAlertBotAlerts()` - List alerts raised by this bot
- `listBoundaryAlertSubjects()` - Retrieves subjects that may be associated with a Boundary Alert
- `listAlertBotSubscriptions()` - List boundary alert bots subscriptions
- `listAlertBots()` - List boundary alert bots
- `listBoundaryAlerts()` - List all alerts in a boundary
- `listBoundaryAuditMetrics()` - Retrieves audit metrics for a specific boundary
- `listBoundaryAudits()` - Retrieves a list of audits for a boundary
- `listBoundaryComponents()` - Page boundary components
- `listBoundaryComponentsByBoundaryId()` - Page boundary components by boundary id
- `listBoundaryConnections()` - Retrieves a list of all connections for a boundary
- `listBoundaryEvents()` - Retrieves a list of events for a boundary
- `listBoundaryEvidence()` - Retrieves a list of all boundary evidence by boundary id
- `listBoundaryParties()` - Retrieves a list of parties for a boundary
- `listBoundaryPartyRaci()` - Retrieves a boundary party Raci RollUP matrix
- `listBoundaryPartyRoles()` - Retrieves paged list of roles assigned to a party on a boundary
- `listBoundaryPartyRolesByBoundaryId()` - Page boundary party roles by boundary id
- `listBoundaryPipelines()` - List pipelines for a certain boundary
- `listBoundaryProductConnections()` - Retrieves a list of all connections for a boundary
- `listBoundaryProductPipelines()` - Retrieves a boundary product
- `listBoundaryProductsByBoundary()` - Retrieves a list of products for a boundary
- `listBoundaryQueryAlerts()` - List all alerts bound to a query
- `listBoundaryRoles()` - Retrieve paged list of boundary roles and parties if assigned
- `listBoundaryScfControls()` - Retrieves a list of scf controls for a boundary
- `listStandardBaselineElements()` - List standard baselines that have been added to a boundary
- `listStandardBaselines()` - List standard baselines that have been added to a boundary
- `listBoundarySuggestedProducts()` - Retrieves a list of suggested products for a boundary
- `listBoundaryTargetsByProduct()` - Retrieves a list of targets for a boundary
- `listBoundaryTeamMetrics()` - Retrieves a list of teams metrics for a boundary
- `listBoundaryTeamScfControlEvidenceDefintions()` - Retrieves a list of evidence definitions in scope for a boundary team scf control
- `listBoundaryTeamScfControls()` - Retrieves a list of scf control data for a boundary team
- `listBoundaryTeams()` - Retrieves a list of teams for a boundary
- `listTests()` - List tests within a boundary with filters
- `listBoundaryUnmanagedDomains()` - Retrieves a list of scf domains unmanaged for a boundary
- `listFilterBoundaryPartyRoles()` - Page boundary party roles with filters
- `removeCrosswalkVersion()` - Remove crosswalk version from boundary
- `removeStandardBaseline()` - Remove standard baseline from boundary
- `runAlertBot()` - Manually run an alert bot
- `subscribe()` - Subscribe to an Alert Bot&#39;s alerts
- `unsubscribe()` - Unsubscribe from and alert bot&#39;s alerts
- `updateBoundary()` - Updates a boundary
- `updateAlertBot()` - Update an alert bot
- `updateBoundaryEvidence()` - Updates a boundary evidence
- `updateBoundaryProduct()` - Updates a boundary product
- `updateBoundaryScfControl()` - Updates a scf control for a boundary
- `updateBoundaryTeam()` - Updates a boundary team
- `updateBoundaryTeamScfControl()` - Updates a boundary team scf control question
- `updateBoundaryTeamScfControlEvidenceDefinition()` - Updates a boundary team scf control evidence definition implementation
- `upsertAlertBot()` - Creates or Updates an alert bot for a query, query version, and boundary
- `upsertBoundaryProductTargets()` - Updates a boundary product targets
- `upsertBoundaryProducts()` - Updates a boundarys products

### BoundaryRoleApi

Access via `client.getBoundaryRoleApi()`

- `addRoleToBoundary()` - Adds role to a boundary
- `get()` - Get boundary role by id
- `list()` - list all boundary roles
- `listBoundaryRoleActivities()` - List boundary role tasks
- `listBoundaryRoleRaci()` - List boundary role raci rollup
- `listBoundaryRoleTasks()` - List boundary role tasks
- `listUnassignedBoundaryRoles()` - Retrieve paged list of unassigned boundary roles
- `delete()` - Force override delete on boundary role
- `update()` - Update boundary role

### CatalogRoleApi

Access via `client.getCatalogRoleApi()`

- `create()` - Add a new role
- `delete()` - Delete user defined role
- `get()` - Get role by id
- `listRoleCategories()` - list all role categories
- `listRoleJobDuties()` - list all role job duties
- `listRoleQualifications()` - list all role qualifications
- `list()` - list all roles

### ClassApi

Access via `client.getClassApi()`

- `getClass()` - Retrieves a class info
- `getClassGraph()` - Retrieves a graph by class name
- `getClassObjects()` - get objects by class
- `listClassQueries()` - List all queries by the class
- `listClasses()` - Retrieves a list of all classes from the top level along with their linked objects
- `patchFeatures()` - Adds and/or removes features from a class

### CollectorBotApi

Access via `client.getCollectorBotApi()`

- `getCollectorBot()` - Get collector bot by id.

### ComplianceFeatureApi

Access via `client.getComplianceFeatureApi()`

- `create()` - Create a new compliance feature
- `delete()` - Delete compliance feature
- `deleteVersion()` - Delete compliance feature version
- `get()` - Get a compliance feature
- `getVersion()` - Get a compliance feature version
- `listComplianceFeatureTypes()` - Returns compliance feature types
- `listVersions()` - Lists a compliance feature versions
- `list()` - Lists compliance features
- `patch()` - Patches a compliance feature
- `update()` - Updates a compliance features status

### ComponentApi

Access via `client.getComponentApi()`

- `createComponentFilter()` - Create new component filter
- `createComponentParty()` - Create new component party
- `createComponentRole()` - Create new component role
- `createSuggestedComponent()` - Create new suggested component
- `deleteComponentFilter()` - Delete component filter by id
- `deleteComponentParties()` - Delete component parties by component id
- `deleteComponentParty()` - Delete component party
- `deleteComponentRole()` - Delete component role
- `deleteComponentRoles()` - Delete component roles by component id
- `get()` - Get component by id
- `getComponentFilter()` - Get component filter
- `getComponentParty()` - Get component party
- `getComponentRole()` - Get component role
- `listComponentFilters()` - Page component filters
- `listComponentRaci()` - List component raci rollup
- `listComponentTypes()` - List all component types
- `list()` - List all components
- `pageExternalControls()` - Retrieves component external controls
- `pageComponentParties()` - Page component parties
- `pageComponentPartiesByComponentId()` - Page component parties raci by component id
- `pageComponentRoles()` - Page component roles
- `pageComponentRolesByComponentId()` - Page component roles raci by component id
- `pageSubComponents()` - Retrieves component external controls

### ComponentEvidenceApi

Access via `client.getComponentEvidenceApi()`

- `createComponentEvidence()` - Create a component evidence
- `createComponentEvidenceWithBoilerplate()` - Create a component evidence using boiler plate evidence bot
- `createComponentEvidenceWithNoBot()` - Create a component evidence from evidence definition with no bot
- `createSuggestedComponentEvidence()` - Create a component evidence from suggested evidence definition and bot information
- `getComponentEvidence()` - Get component evidence by id
- `listComponentEvidenceBots()` - list unique set of all evidence bots within component evidences
- `listComponentEvidences()` - list all component evidences

### ControlActivityApi

Access via `client.getControlActivityApi()`

- `create()` - Add a new control activity
- `delete()` - Delete control activity by id
- `get()` - Get control activity by id
- `linkImplementationStatement()` - Link a control activity and implementation statement
- `list()` - list all control activities
- `listImplementationStatements()` - List control activity implementation statements
- `patch()` - Patch a control activity
- `unlinkImplementationStatement()` - Unlink control activity from implementation statement

### CrosswalkApi

Access via `client.getCrosswalkApi()`

- `addElement()` - Add a crosswalk version element
- `create()` - Creates a new crosswalk
- `delete()` - Delete crosswalk
- `deleteVersion()` - Delete crosswalk version
- `get()` - Get a crosswalk
- `getVersion()` - Get a crosswalk version
- `removeElement()` - Remove a crosswalk version element
- `update()` - Update crosswalk

### DataTypeApi

Access via `client.getDataTypeApi()`

- `getDataTypeEnumInfoByName()` - Retrieves a data type enum info
- `getDataTypeInfoByName()` - Retrieves a data type info by name
- `listDataTypeEnumInfoByName()` - Retrieves a list of all data type enum info by name
- `listDataTypes()` - Retrieves a list of all data type

### EvidenceBotApi

Access via `client.getEvidenceBotApi()`

- `createEvidenceBot()` - Creates a new evidence bot
- `deleteEvidenceBot()` - Delete evidence bot
- `getEvidenceBot()` - Get an evidence bot
- `listEvidenceBots()` - List evidence bots
- `updateEvidenceBot()` - Update evidence bot

### EvidenceDefinitionApi

Access via `client.getEvidenceDefinitionApi()`

- `createEvidenceDefinition()` - Creates a new evidence definition
- `deleteEvidenceDefinition()` - Delete evidence definition
- `getEvidenceDefinition()` - Get an evidence definition
- `listEvidenceDefinitionFrameworkElements()` - List framework elements that have links to evidence definition
- `listEvidenceDefinitionFrameworkVersions()` - List framework version that have links to evidence definition
- `listEvidenceDefinitions()` - List evidence definitions
- `searchOptions()` - Returns options/filters for evidence definitions
- `search()` - Search all evidence definitions
- `updateEvidenceDefinition()` - Update evidence definition

### EvidenceRequestApi

Access via `client.getEvidenceRequestApi()`

- `createEvidenceRequest()` - Create evidence request
- `deleteEvidenceRequest()` - Deletes evidence request
- `getEvidenceRequest()` - Get an evidence request
- `listEvidenceRequestListsByRequest()` - Get the evidence request list by request code
- `listEvidenceRequests()` - List all evidence requests
- `updateEvidenceRequest()` - Update evidence request

### EvidenceRequestListApi

Access via `client.getEvidenceRequestListApi()`

- `createEvidenceRequestList()` - Creates a new evidence request list
- `deleteEvidenceRequestList()` - Delete evidence request list
- `getEvidenceRequestList()` - Get evidence request list
- `listEvidenceRequestLists()` - List evidence request lists
- `updateEvidenceRequestList()` - Update evidence request list

### FieldApi

Access via `client.getFieldApi()`

- `getField()` - Retrieves a field info by id
- `listFieldProperties()` - Retrieves a fields properties
- `listFields()` - Retrieves a list of all fields with searchable queries

### FindingApi

Access via `client.getFindingApi()`

- `get()` - Get finding
- `list()` - List all findings

### FrameworkApi

Access via `client.getFrameworkApi()`

- `getFramework()` - Retrieves a framework info
- `getFrameworkElement()` - Retrieves a framework version info
- `getFrameworkElementByCode()` - Retrieves a framework element by code
- `getFrameworkElementInfo()` - Retrieves a framework element info
- `getFrameworkVersion()` - Retrieves a framework version info
- `getScfControl()` - Retrieves a Scf control info
- `getScfDomain()` - Retrieves a Scf Domain by code
- `listBrowserFrameworks()` - Retrieves a list of all frameworks
- `listEvidenceDefinitionByFrameworkElementId()` - List evidence definitions that link to given framework element
- `listFrameworkElementTypes()` - Retrieves a list of a framework element types
- `listFrameworkElements()` - Retrieves a list of a framework version elements
- `listFrameworkElementsByCode()` - Retrieves a list of framework versions
- `listFrameworkVersions()` - Retrieves a list of a framework versions
- `listFrameworkVersionsByCode()` - Retrieves a list of framework versions
- `listFrameworks()` - Retrieves a list of all frameworks
- `listScfControls()` - Retrieves a list of all Scf controls
- `listScfDomains()` - Retrieves a list of Scf domains
- `scfSearch()` - Retrieves list of scf domains/controls/assertions searched by text

### GraphqlQueryApi

Access via `client.getGraphqlQueryApi()`

- `create()` - Creates a new graphql query
- `delete()` - Delete graphql query
- `deleteVersion()` - Delete graphql query version
- `get()` - Get a graphql query
- `getVersion()` - Get a graphql query version
- `list()` - List graphql queries
- `listAlertBots()` - List graphql query alert bots
- `listVersions()` - List graphql query versions
- `update()` - Update graphql query
- `validateTemplate()` - Validates a graphql query template

### HealthcheckApi

Access via `client.getHealthcheckApi()`

- `health()` - 

### HelpApi

Access via `client.getHelpApi()`

- `createHelpCase()` - Creates a new help case on Salesforce

### ImplementationStatementApi

Access via `client.getImplementationStatementApi()`

- `create()` - Create a new implementation statement
- `createImplementationStatementParty()` - Create new implementation statement party
- `createImplementationStatementRole()` - Create new implementation statement role
- `delete()` - Delete implementation statement
- `deleteImplementationStatementParties()` - Delete implementation statement parties by implementation statement id
- `deleteImplementationStatementParty()` - Delete implementation statement party
- `deleteImplementationStatementRole()` - Delete implementation statement role
- `deleteImplementationStatementRoles()` - Delete implementation statement roles by implementation statement id
- `get()` - Get implementation statement by id
- `getImplementationStatementParty()` - Get implementation statement party
- `getImplementationStatementRole()` - Get implementation statement role
- `linkPipelines()` - Link pipelines to implementation statements
- `list()` - List all implementation statements
- `listImplementationStatementPipelines()` - List all implementation statement linked pipelines
- `listImplementationStatementRaci()` - List implementation statement raci rollup
- `pageImplementationStatementParties()` - Page implementation statement parties raci by implementation statement id
- `pageImplementationStatementRoles()` - Page implementation statement roles raci by implementation statement id
- `unlinkPipelines()` - Unlink pipelines to implementation statements
- `update()` - Updates an implementation statement

### InternalControlApi

Access via `client.getInternalControlApi()`

- `createInternalControlParty()` - Create new internal control party
- `createInternalControlRole()` - Create new internal control role
- `deleteInternalControlParties()` - Delete internal control parties by internal control id
- `deleteInternalControlParty()` - Delete internal control party
- `deleteInternalControlRole()` - Delete internal control role
- `deleteInternalControlRoles()` - Delete internal control roles by internal control id
- `get()` - Get internal control by id
- `getInternalControlOverview()` - Get internal control overview by id
- `getInternalControlParty()` - Get internal control party
- `getInternalControlRole()` - Get internal control role
- `listInternalControlComponentEvidence()` - List component evidence info by internal control id
- `listInternalControlPipelines()` - list all internal control pipelines
- `listInternalControlRaci()` - List internal controls raci rollup
- `list()` - list all internal controls
- `pageExternalControls()` - Retrieves external controls for this internal control
- `pageInternalControlParties()` - Page internal control parties
- `pageInternalControlPartiesByInternalControlId()` - Page internal control parties raci by internal control id
- `pageInternalControlRoles()` - Page internal control roles
- `pageInternalControlRolesByInternalControlId()` - Page internal control roles raci by internal control id
- `slimList()` - Slim list internal controls
- `updateInternalControl()` - Update an internal control

### InternalDomainApi

Access via `client.getInternalDomainApi()`

- `get()` - Get internal domain by id
- `list()` - list all internal domains

### KbArticleApi

Access via `client.getKbArticleApi()`

- `getKbArticleByCode()` - Get a KB Article
- `listKbArticles()` - List KB Articles

### ObjectApi

Access via `client.getObjectApi()`

- `getObjectGraph()` - Retrieves a graph for an object
- `getVersion()` - Retrieves object version for an object
- `getVersionByObjectIdOrVersionId()` - Retrieves an object version by id, or the latest version if the provide id is an object id.
- `listLinksAsOfDate()` - Retrieves Link information for a given object as of a specific timestamp
- `listObjectVersionsByObjectId()` - Retrieves object version for an object
- `tag()` - Add tags to an object
- `untag()` - Removes a tag from an object

### OnboardingApi

Access via `client.getOnboardingApi()`

- `createCrmCustomer()` - Creates a new customer on CRM

### PartyApi

Access via `client.getPartyApi()`

- `getMyParty()` - Get party for the current principal in the current organization
- `get()` - Get party by id, a principal id may also be provided to get the party for that principal in the current logged on organization
- `list()` - list all parties

### PermissionApi

Access via `client.getPermissionApi()`

- `listEffective()` - Retrieves a list of permissions that are effective against the currently logged on user  and the given resourceId or resourceType.  Note that, if a resourceId is provied, resourceType will not be evaluated.
- `list()` - Retrieves a list of all available permissions

### PipelineApi

Access via `client.getPipelineApi()`

- `addScope()` - Add a pipeline scope
- `create()` - Add new pipeline
- `delete()` - Delete pipelines
- `getAllPipelineJobsByPipeline()` - get all pipeline jobs by pipeline id
- `get()` - Get pipelines by id.
- `getPipelineConnections()` - Get connections by a pipeline id.
- `listImplementationStatements()` - List pipelines implementation statements
- `list()` - get all pipelines
- `performActionOnPipeline()` - Start or stop a pipeline
- `receive()` - Uploads a simple batch to a &#x60;receiver&#x60; pipeline. This will create a job and a batch and populate it with the provided &#x60;data&#x60; and &#x60;markDeleted&#x60; items. All items provided inside of the &#x60;data&#x60; array must conform to the targeted class schema. 
- `update()` - Update app pipelines

### PipelineJobApi

Access via `client.getPipelineJobApi()`

- `createPipelineJob()` - Add new pipeline job
- `deletePipelineJob()` - Delete pipeline job
- `end()` - Inform the system that a pipeline job has completed
- `endWithError()` - Inform the system that a pipeline job has errored
- `getAllPipelineJobs()` - get all pipeline job
- `getObjectVersionsByPipelineJob()` - get all object versions by pipeline job id
- `getPipelineJob()` - Get pipeline job by id.
- `getPipelineJobBatchLogs()` - Gets the last 500 batch logs for a pipeline job by id.
- `getPipelineJobLogEvents()` - Return the raw logs from the bot running the job
- `updatePipelineJob()` - Update app pipelineJobs
- `updatePipelineJobExecutionDetails()` - Update pipeline job execution details

### PrincipalApi

Access via `client.getPrincipalApi()`

- `principalAccessRuleOptions()` - Retrieves options for access rules search for a principal.
- `searchPrincipalAccessRules()` - Searches for access rules that belong to a principal (directly or indirectly through role assignments).

### ProductApi

Access via `client.getProductApi()`

- `create()` - Creates a new product with version
- `createComponent()` - Creates a new product component with version
- `createEdition()` - Creates a new product edition with version
- `delete()` - Delete a product
- `deleteComponent()` - Delete a product component
- `deleteComponentVersion()` - Delete a product component version
- `deleteEdition()` - Delete a product edition
- `deleteEditionVersion()` - Delete a product edition version
- `deleteVersion()` - Delete a product version
- `getByCpe()` - Retrieves a catalog product by its cpe string
- `get()` - Get specific product
- `getComponent()` - Get specific product component
- `getComponentVersion()` - Get specific product component version
- `getProductComponentVersionDirect()` - Get specific product component version
- `getEdition()` - Get specific product edition
- `getEditionVersion()` - Get specific product edition version
- `getProductEditionVersionDirect()` - Get specific product edition version
- `getVersion()` - Get specific product version
- `getProductVersionDirect()` - Get specific product version
- `listCpes()` - List product Cpe Version strings
- `listComponentVersions()` - List product component versions
- `listEditionVersions()` - List product edition versions
- `listVersions()` - List product versions
- `list()` - List products
- `patchEditionComponents()` - Adds and/or removes components from a product edition
- `patch()` - Patch a product
- `patchComponent()` - Patch a product component
- `patchProductComponents()` - Adds and/or removes components from a product
- `patchEdition()` - Patch a product edition
- `patchEditionFeatures()` - Adds and/or removes features from a product edition
- `patchProductEditions()` - Adds and/or removes editions from a product
- `patchSegments()` - Adds and/or removes segments from a product
- `suggestOperation()` - Suggests a new product operation
- `updateComponentStatus()` - Update a product component status
- `updateEditionStatus()` - Update a product edition status
- `updateStatus()` - Update a product status

### ResourceApi

Access via `client.getResourceApi()`

- `deleteResourceLink()` - Removes a resource link
- `getPath()` - Retrieves resource path the given resource is associated with as a source or target
- `getResource()` - Returns a resource by ID
- `getResourceTypes()` - Retrieves all types available in this application
- `getTagsForResource()` - Retrieves all Tags assigned to the given resource
- `linkResources()` - Links two resources together:


  * The source of the link will be set to that of the id provided in this path
  * The target of the link must be provided in the request body
- `linkTypeSearch()` - Searches link types by search filter
- `listAlertsImpactingResource()` - Traverses the alert/resource link tree up the way to retrieve a list of alerts that are impacting this resource.
- `listResourceLinkTypes()` - Retrieves resource link types the given resource can be used to link with other resources
- `listResourceLinks()` - Retrieves resource links the given resource is associated with as a source or target
- `listResourceLinksOptions()` - Returns options/filters for resource links
- `listSubAlertsForResource()` - Traverses the alert/resource link tree down the way to retrieve a list of alerts raised against one or more of its children resources
- `listTaggedResources()` - Retrieves resources the given tag is linked to
- `resourceSearch()` - Searches resources by keywords, type, tags, and payload conditions
- `resourceSearchTags()` - Searches tags available in this application against a given resource id
- `resourceSearchTagsOptions()` - Returns options/filters for tags
- `searchResources()` - Searches resources by keywords type and tags
- `suggestDeleteResourceLink()` - Suggests removal a resource link
- `suggestResourceLink()` - Suggests a new resource link
- `suggestResourceTag()` - Suggests a new resource tag
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

### SegmentApi

Access via `client.getSegmentApi()`

- `create()` - Creates a new segment
- `delete()` - Delete segment
- `deleteVersion()` - Delete segment version
- `get()` - Get a segment
- `getVersion()` - Get a segment version
- `listSegmentTypes()` - Returns segment types
- `listVersions()` - Lists a segments versions
- `list()` - Lists segments
- `patch()` - Patch a segment
- `patchFeatures()` - Adds and/or removes features from a segment
- `patchParentSegments()` - Adds and/or removes parent segments from a segment
- `update()` - Update a segments status

### ServerApi

Access via `client.getServerApi()`

- `getServerSpec()` - Retrieves the server specification OpenAPI file
- `ping()` - Pings the server to make sure it&#39;s live and authentication is successful

### StandardApi

Access via `client.getStandardApi()`

- `browseStandardBaselineElement()` - Browse standard baseline element
- `browseStandardBaselineElements()` - Browse standard baseline elements
- `browseStandardBaselines()` - Browse standard baselines
- `browseStandards()` - Browse standards
- `get()` - Get standard by id
- `getBaseline()` - Get baseline by standard and baseline id
- `getBaselineElement()` - Get element by standard and baseline and element id
- `getBaselineFilterTree()` - Get element by standard and baseline and element id
- `getElement()` - Get element by standard and element id
- `listBaselineElements()` - list all standard baseline elements
- `listBaselines()` - list all standard baselines
- `listElements()` - list all standard elements
- `list()` - list all standards
- `searchElements()` - search standard elements
- `search()` - search standards

### SuggestedActivityApi

Access via `client.getSuggestedActivityApi()`

- `get()` - Get suggested activity by id or code
- `list()` - list all suggested activities

### SuiteApi

Access via `client.getSuiteApi()`

- `listSuites()` - List suites

### TagApi

Access via `client.getTagApi()`

- `addResourceTypesToTagType()` - Associates the given ResourceTypes with the given Tag Type
- `getResourceTypesForTagType()` - Retrieves a list of all resource types which are associated with the given tag type.
- `getTagTypes()` - Retrieves all tag types available in this application
- `listTags()` - Retrieves a list of tags available in this application
- `searchTags()` - Searches tags available in this application
- `searchTagsOptions()` - Returns options/filters for tags
- `suggestTag()` - Suggests a new global tag

### TagRuleApi

Access via `client.getTagRuleApi()`

- `apply()` - Retroactively applies a tag rule to object versions
- `create()` - Creates a tag rule
- `delete()` - Delete a tag rule
- `get()` - get boundary tag rule
- `list()` - List boundary tag rules
- `update()` - Update a tag rule

### TaskApi

Access via `client.getTaskApi()`

- `addAttachment()` - Adds a new task attachment. Note that this operation is idempotent.
  - If an attachment already exists for the specified fileVersionId and taskId 
    the existing attachment metadata will be updated if necessary and returned
- `addComment()` - Adds a new task comment
- `create()` - Add a new task
- `delete()` - Delete a task
- `deleteComment()` - Delete a task comment
- `editComment()` - Updates a task comment
- `get()` - Get task by id
- `listAttachments()` - list all task attachments
- `listComments()` - list all task comments
- `listPriorities()` - list task priorities
- `list()` - list tasks
- `update()` - Update a task
- `updateRank()` - Update the rank of a task

### TeamApi

Access via `client.getTeamApi()`

- `createTeam()` - Add a new team
- `deleteTeam()` - Delete a team
- `getTeam()` - Get team by id
- `listTeams()` - list all teams
- `updateTeam()` - Update a team

### VendorApi

Access via `client.getVendorApi()`

- `createSuggestedVendor()` - Create a new suggested vendor
- `listSuggestedVendors()` - Retrieves a list of suggested vendors
- `listVendors()` - List vendors

### WorkflowApi

Access via `client.getWorkflowApi()`

- `get()` - Get workflow by id
- `list()` - list all workflows


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
  PlatformApiClient,
  ConnectionProfile,
  // Import models as needed
} from 'sdk';
```

## Additional Resources

- [OpenAPI Spec](./api.yml) - Raw OpenAPI specification
- [manifest.json](./generated/api/manifest.json) - Operation metadata for AI/tooling integration

---
*Generated: 2025-12-03T13:26:09Z*
*Codegen Version: 1.0.12*
