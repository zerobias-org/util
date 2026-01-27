# @zerobias-org/data-utils

**Version:** 1.0.0

Framework-agnostic utilities for working with DataProducers, including:
- **DataProducer Client** - Connect to and interact with DataProducer APIs
- **Data Mapping & Transformation** - Execute field mappings with 8 transform types and 60+ modifiers
- **Schema Generation** - Transform OpenAPI specs or TypeScript interfaces into DataProducer schemas
- **Transform Utilities** - Value conversion, modifiers, and JSONata integration

## Installation

```bash
npm install @zerobias-org/data-utils
```

**Dependencies:**
- `@zerobias-org/module-interface-dataproducer`
- `jsonata` (if using JSONata expressions or data mapping)

## Table of Contents

- [DataProducer Client](#dataproducer-client)
  - [Quick Start](#quick-start)
  - [Connection Management](#connection-management)
  - [Working with Objects](#working-with-objects)
  - [Working with Collections](#working-with-collections)
  - [Working with Schemas](#working-with-schemas)
- [Data Mapping & Transformation](#data-mapping--transformation)
  - [DataMapper Overview](#datamapper-overview)
  - [Transform Types](#transform-types)
  - [Mapping Rules](#mapping-rules)
  - [Backend Execution](#backend-execution)
- [Schema Generation](#schema-generation)
- [Transform Utilities](#transform-utilities)
- [Test Coverage](#test-coverage)
- [License](#license)

---

## DataProducer Client

The `DataProducerClient` provides a simplified, framework-agnostic interface for connecting to and interacting with DataProducer APIs.

### Quick Start

```typescript
import { DataProducerClient, UUID } from '@zerobias-org/data-utils';

// Create client instance
const client = new DataProducerClient();

// Connect to a DataProducer
const result = await client.connect({
  server: 'https://hub.example.com',
  targetId: new UUID('12345678-1234-1234-1234-123456789abc'),
  scopeId: 'org-abc'
});

if (result.success) {
  console.log('Connected successfully');
} else {
  console.error('Connection failed:', result.error);
}

// Get root object
const root = await client.objects.getRoot();
console.log('Root object:', root.name);

// Get children
const children = await client.objects.getChildren(root.id);
console.log(`Found ${children.length} child objects`);

// Fetch collection data
const page = await client.collections.getCollectionElements(collectionId, {
  pageNumber: 0,
  pageSize: 10,
  sortBy: ['id'],
  sortDirection: 'asc'
});
console.log(`Retrieved ${page.items.length} items`);

// Disconnect when done
await client.disconnect();
```

### Connection Management

```typescript
// Initialize connection (auto-reconnects if already connected to different target)
await client.init(targetId, scopeId, serverUrl);

// Connect (fails if already connected to different target)
await client.connect({ server, targetId, scopeId });

// Check connection status
const isConnected = await client.isConnected();

// Health check
const isHealthy = await client.ping();

// Disconnect
await client.disconnect();

// Get current configuration
const config = client.getConfig();
console.log('Target:', config.targetId);
console.log('Scope:', config.scopeId);
```

### Working with Objects

Navigate hierarchical object structures:

```typescript
// Get root object
const root = await client.objects.getRoot();

// Get a specific object
const obj = await client.objects.getObject(objectId);

// Get children of an object
const children = await client.objects.getChildren(objectId);

// Build tree structure from flat list
const objects = [/* ... */];
const { root, children } = client.objects.buildTree(objects);
```

**ObjectNode interface:**
```typescript
interface ObjectNode {
  id: string;
  name: string;
  type: string;
  parentId?: string | null;
  schemaId?: string;
  hasChildren?: boolean;
  childCount?: number;
  metadata?: Record<string, any>;
  icon?: string;
  path?: string[];
}
```

### Working with Collections

Query and retrieve collection data:

```typescript
// Get list of available collections
const collections = await client.collections.getCollections();

// Get collection elements with pagination
const page = await client.collections.getCollectionElements(collectionId, {
  pageNumber: 0,
  pageSize: 100,
  sortBy: ['createdAt', 'id'],
  sortDirection: 'desc'
});

// Search collection elements
const results = await client.collections.searchCollectionElements(
  collectionId,
  'searchTerm',
  {
    pageNumber: 0,
    pageSize: 50,
    sortBy: ['relevance'],
    sortDirection: 'desc'
  }
);

// Query with flexible parameters
const data = await client.collections.queryCollection({
  collectionId: 'my-collection',
  filter: { status: 'active' },
  pageNumber: 0,
  pageSize: 20
});
```

### Working with Schemas

Retrieve schema definitions:

```typescript
// Get list of available schemas
const schemas = await client.schemas.getSchemas();

// Get a schema by ID
const schema = await client.schemas.getSchema('schema-123');

// Get a schema by name
const userSchema = await client.schemas.getSchemaByName('User');

// Validate data against a schema
const validation = client.schemas.validateData(userData, schema);
if (!validation.valid) {
  console.error('Validation errors:', validation.errors);
}
```

---

## Data Mapping & Transformation

The `DataMapper` executes field-to-field transformations using mapping rules, supporting 8 transform types and 60+ modifiers.

### DataMapper Overview

```typescript
import { DataMapper, MappingRule } from '@zerobias-org/data-utils';

const mapper = new DataMapper();

// Define mapping rules
const mappingRules: MappingRule[] = [
  {
    id: '1',
    source: { key: 'first_name', name: 'First Name', type: 'string' },
    destination: { key: 'firstName', name: 'First Name', type: 'string', required: true },
    transform: { type: 'direct' },
    enabled: true,
    errorStrategy: 'fail'
  },
  {
    id: '2',
    source: { key: 'email', name: 'Email', type: 'string' },
    destination: { key: 'email', name: 'Email', type: 'string', required: true },
    transform: {
      type: 'convert',
      options: { dataType: 'string', modifiers: ['lowercase', 'trim'] }
    },
    enabled: true
  }
];

// Apply all mappings to source data
const sourceData = {
  first_name: 'John',
  email: '  JOHN.DOE@EXAMPLE.COM  '
};

const { result, errors } = await mapper.applyAllMappings(mappingRules, sourceData);
// result: { firstName: 'John', email: 'john.doe@example.com' }
// errors: []
```

### Transform Types

The DataMapper supports 8 transform types:

#### 1. Direct
Simple field copy:
```typescript
{
  type: 'direct'
}
```

#### 2. Convert
Type conversion with optional modifiers:
```typescript
{
  type: 'convert',
  options: {
    dataType: 'string' | 'number' | 'date' | 'boolean',
    modifiers?: ['trim', 'uppercase', ...]
  }
}
```

#### 3. Combine
Merge multiple source fields:
```typescript
{
  type: 'combine',
  options: {
    combineWith: ' ' // separator
  }
}
// Multiple sources: [firstName, lastName] → "John Doe"
```

#### 4. Split
Split string into array:
```typescript
{
  type: 'split',
  options: {
    delimiter: ',',
    trim?: true
  }
}
```

#### 5. Expression
JSONata expression evaluation:
```typescript
{
  type: 'expression',
  options: {
    expression: '$uppercase($trim(firstName)) & " " & $capitalize(lastName)'
  }
}
```

#### 6. Default
Provide fallback value:
```typescript
{
  type: 'default',
  options: {
    defaultValue: 'N/A'
  }
}
```

#### 7. Conditional
If/then/else logic:
```typescript
{
  type: 'conditional',
  options: {
    conditionField: 'status',
    conditionOperator: 'equals' | 'notEquals' | 'greaterThan' | 'lessThan' | 'contains' | 'isEmpty',
    conditionValue: 'active',
    trueValue: 'Yes',
    falseValue: 'No'
  }
}
```

#### 8. Lookup
Dictionary/table lookup:
```typescript
{
  type: 'lookup',
  options: {
    lookupTable: {
      'US': 'United States',
      'UK': 'United Kingdom',
      'CA': 'Canada'
    },
    defaultValue: 'Unknown'
  }
}
```

### Mapping Rules

Complete `MappingRule` interface:

```typescript
interface MappingRule {
  id: string;
  source: SourceField | SourceField[];    // Single or multiple source fields
  destination: DestinationField;           // Target field
  transform: TransformConfig;              // Transformation configuration
  description?: string;                    // Human-readable description
  enabled?: boolean;                       // Default: true
  errorStrategy?: 'fail' | 'skip' | 'default';  // Error handling
  errorDefault?: any;                      // Value to use if errorStrategy is 'default'
}

interface SourceField {
  key: string;         // Field path (supports dot notation: 'user.profile.name')
  name: string;        // Display name
  type: string;        // Data type
  sampleValue?: any;   // Preview value
}

interface DestinationField {
  key: string;         // Field path
  name: string;        // Display name
  type: string;        // Data type
  required?: boolean;  // Validation flag
}

interface TransformConfig {
  type: 'direct' | 'convert' | 'combine' | 'split' | 'expression' | 'default' | 'conditional' | 'lookup';
  options?: {
    // Type-specific options
    dataType?: 'string' | 'number' | 'date' | 'boolean';
    modifiers?: string[];        // Post-processing modifiers
    expression?: string;         // JSONata expression
    combineWith?: string;        // Separator for combine
    delimiter?: string;          // Delimiter for split
    defaultValue?: any;          // Fallback value
    conditionField?: string;     // Field for conditional
    conditionOperator?: string;  // Comparison operator
    conditionValue?: any;        // Value to compare against
    trueValue?: any;            // Value when condition is true
    falseValue?: any;           // Value when condition is false
    lookupTable?: Record<string, any>;  // Lookup dictionary
    trim?: boolean;             // Auto-trim strings
  };
}
```

### Backend Execution

Backend developers can use the DataMapper to execute pipeline mappings:

```typescript
#!/usr/bin/env node
import { DataProducerClient, DataMapper, MappingRule } from '@zerobias-org/data-utils';

async function executePipelineMapping(pipeline: Pipeline) {
  // 1. Extract mapping configuration from pipeline
  const mappingRules: MappingRule[] = pipeline.params.dataMappings;

  // 2. Connect to data source
  const client = new DataProducerClient();
  await client.connect({
    server: pipeline.sourceServer,
    targetId: pipeline.sourceTargetId,
    scopeId: pipeline.sourceScopeId
  });

  // 3. Initialize mapper
  const mapper = new DataMapper();

  // 4. Process all records with pagination
  let pageNumber = 0;
  let processedCount = 0;
  let errorCount = 0;

  while (true) {
    // Fetch page of data
    const page = await client.collections.getCollectionElements(
      pipeline.sourceCollectionId,
      { pageNumber, pageSize: 100, sortBy: ['id'], sortDirection: 'asc' }
    );

    if (page.items.length === 0) break;

    // Transform each item
    for (const sourceItem of page.items) {
      try {
        const { result, errors } = await mapper.applyAllMappings(mappingRules, sourceItem);

        if (errors.length > 0) {
          console.warn(`Errors transforming item ${sourceItem.id}:`, errors);
          errorCount++;
        }

        // Send transformed data to destination
        await sendToDestination(result, pipeline.destinationConfig);
        processedCount++;

      } catch (error) {
        console.error(`Failed to process item ${sourceItem.id}:`, error);
        errorCount++;
      }
    }

    console.log(`Processed page ${pageNumber}: ${page.items.length} items`);
    pageNumber++;
  }

  await client.disconnect();

  return { processedCount, errorCount, success: errorCount === 0 };
}
```

**Key Capabilities for Backend Execution:**
- ✅ Read mapping configurations (`MappingRule[]`)
- ✅ Connect to DataProducer with pagination
- ✅ Execute transforms on each record
- ✅ Handle errors with configurable strategies
- ✅ Loop through records until complete

---

## Schema Generation

Transform OpenAPI specifications or TypeScript interfaces into DataProducer Schema objects.

### Approach 1: Build from TypeScript Interfaces (Recommended)

Use this when you have generated TypeScript models from OpenAPI codegen with `attributeTypeMap`:

```typescript
import { TypeScriptSchemaBuilder, buildSchema } from '@zerobias-org/data-utils';
import { Repository, Label } from '../generated/model';

// Using convenience function
const labelSchema = buildSchema(Label, {
  schemaId: 'github_label_schema',
  primaryKeys: ['id'],
});

// Using builder class for more control
const builder = new TypeScriptSchemaBuilder();

const repoSchema = builder.build({
  schemaId: 'github_repository_schema',
  modelClass: Repository,
  primaryKeys: ['id'],
  references: {
    owner: { schemaId: 'github_user_schema' },
    license: { schemaId: 'github_license_schema' },
  },
  // Optional: enrich with OpenAPI descriptions
  openApiSpec: '/path/to/api.yml',
  openApiSchemaName: 'Repository',
});
```

### Approach 2: Build from OpenAPI Specification

Use this when working directly with OpenAPI specs without generated TypeScript classes:

```typescript
import { OpenAPISchemaBuilder } from '@zerobias-org/data-utils';

const builder = new OpenAPISchemaBuilder();

const schema = builder.build({
  schemaId: 'github_repository_schema',
  openApiSpec: '/path/to/api.yml',  // or parsed object
  schemaName: 'Repository',
  primaryKeys: ['id'],
  references: {
    owner: { schemaId: 'github_user_schema' },
  },
});

// Build multiple schemas from same spec (efficient)
const schemas = builder.buildMultiple('/path/to/api.yml', [
  { schemaId: 'repo_schema', schemaName: 'Repository', primaryKeys: ['id'], openApiSpec: '' },
  { schemaId: 'label_schema', schemaName: 'Label', primaryKeys: ['id'], openApiSpec: '' },
]);
```

For complete schema generation documentation, see the [Type Mappings](#type-mappings) and [Schema References](#schema-references) sections below.

---

## Transform Utilities

### Available Modifiers (60+)

**String Modifiers:**
```typescript
import { StringModifiers } from '@zerobias-org/data-utils';

StringModifiers.uppercase('hello');        // 'HELLO'
StringModifiers.lowercase('HELLO');        // 'hello'
StringModifiers.capitalize('john');        // 'John'
StringModifiers.trim('  text  ');         // 'text'
StringModifiers.slugify('Hello World!');   // 'hello-world'
StringModifiers.reverse('hello');          // 'olleh'
StringModifiers.padLeft('5', 3, '0');     // '005'
```

**Number Modifiers:**
```typescript
import { NumberModifiers } from '@zerobias-org/data-utils';

NumberModifiers.round(3.7);                // 4
NumberModifiers.floor(3.7);                // 3
NumberModifiers.ceil(3.2);                 // 4
NumberModifiers.abs(-5);                   // 5
NumberModifiers.formatCurrency(1234.56);   // '$1,234.56'
NumberModifiers.percentage(0.5);           // 50
NumberModifiers.pow(2, 3);                 // 8
```

**Date Modifiers:**
```typescript
import { DateModifiers } from '@zerobias-org/data-utils';

DateModifiers.formatDate(new Date());      // '2023-01-15'
DateModifiers.dateOnly(new Date());        // '2023-01-15'
DateModifiers.timeOnly(new Date());        // '14:30:00'
DateModifiers.toTimestamp(new Date());     // 1673794200000
DateModifiers.addDays(new Date(), 5);      // Date + 5 days
DateModifiers.subtractDays(new Date(), 2); // Date - 2 days
DateModifiers.extractYear(new Date());     // 2023
DateModifiers.extractMonth(new Date());    // 1
DateModifiers.extractDay(new Date());      // 15
```

**Array Modifiers:**
```typescript
import { ArrayModifiers } from '@zerobias-org/data-utils';

ArrayModifiers.first([1, 2, 3]);           // 1
ArrayModifiers.last([1, 2, 3]);            // 3
ArrayModifiers.unique([1, 2, 2, 3]);       // [1, 2, 3]
ArrayModifiers.arraySize([1, 2, 3]);       // 3
ArrayModifiers.reverseArray([1, 2, 3]);    // [3, 2, 1]
ArrayModifiers.join(['a', 'b'], '-');      // 'a-b'
ArrayModifiers.slice([1, 2, 3, 4], 1, 3);  // [2, 3]
```

### JSONata Integration

All transform utilities can be used as JSONata custom functions:

```typescript
import jsonata from 'jsonata';
import { JsonataIntegration } from '@zerobias-org/data-utils';

// Register all transform utilities as JSONata functions
const expr = jsonata('$uppercase($trim(firstName))');
JsonataIntegration.registerFunctions(expr);

const result = await expr.evaluate({ firstName: '  john  ' });
// Result: "JOHN"
```

**Complex mapping example:**
```typescript
const sourceData = {
  first_name: '  JOHN  ',
  last_name: 'doe',
  email: 'john.doe@example.com'
};

const expr = jsonata(`{
  "displayName": $uppercase($trim(first_name)) & " " & $capitalize($trim(last_name)),
  "username": $slugify(first_name & "-" & last_name),
  "contact": $lowercase($trim(email))
}`);

JsonataIntegration.registerFunctions(expr);
const result = await expr.evaluate(sourceData);
// {
//   displayName: "JOHN Doe",
//   username: "john-doe",
//   contact: "john.doe@example.com"
// }
```

### PathUtils

Navigate nested objects using dot notation:

```typescript
import { PathUtils } from '@zerobias-org/data-utils';

const data = {
  user: {
    profile: { name: 'John' },
    addresses: [
      { street: '123 Main St', city: 'Boston' },
      { street: '456 Oak Ave', city: 'NYC' }
    ]
  }
};

// Get nested values
PathUtils.getNestedValue(data, 'user.profile.name');
// 'John'

// Get array item values
PathUtils.getArrayItemValues(data, 'user.addresses[].city');
// ['Boston', 'NYC']

// Set nested values (creates intermediate objects)
PathUtils.setNestedValue(data, 'user.settings.theme', 'dark');

// Check if path exists
PathUtils.hasPath(data, 'user.profile.name');  // true
```

### ValueConverter

Type-safe conversion between common data types:

```typescript
import { ValueConverter } from '@zerobias-org/data-utils';

// Convert to specific types
ValueConverter.toBoolean('true');    // true
ValueConverter.toNumber('$1,234.56'); // 1234.56
ValueConverter.toDate('2023-01-15');  // Date object
ValueConverter.toString(123);         // '123'

// Generic conversion with type parameter
ValueConverter.convert('123', 'number');  // 123
ValueConverter.convert('true', 'boolean'); // true
```

### Validation Utilities

Runtime validation with TypeScript type narrowing:

```typescript
import {
  validateArray,
  validatePagedResult,
  validateDefined,
  validateFound
} from '@zerobias-org/data-utils';

// Validate arrays
const items = await api.getItems();
validateArray(items, 'getItems');
// TypeScript now knows items is T[]

// Validate paged results
const result = await api.getPage();
validatePagedResult(result, 'getPage');
// TypeScript knows result.items exists

// Validate non-null/undefined
const data = await api.getData();
validateDefined(data, 'getData', 'data');
// TypeScript knows data is defined

// Validate find results
const item = list.find(x => x.id === id);
validateFound(item, 'findItem', `id=${id}`);
// TypeScript knows item is not undefined
```

---

## Test Coverage

The package includes comprehensive test coverage:

- **318 passing tests** across all modules
- **0 failing tests**
- **100% coverage** of DataProducerClient APIs
- **Integration tests** for real-world scenarios
- **Error handling** validation
- **Type safety** verification

Test suites cover:
- DataProducerClient connection lifecycle
- ObjectsApi navigation and tree building
- CollectionsApi querying and pagination
- SchemasApi retrieval and validation
- DataMapper transform execution
- All 60+ modifiers and utilities
- Error scenarios and edge cases

---

## Type Mappings

### Core Types

TypeScript class names from `@zerobias-org/types-core-js` are automatically mapped:

| TypeScript Type | DataType |
|-----------------|----------|
| URL | url |
| Email | email |
| MimeType | mimeType |
| GeoCountry | geoCountry |
| GeoSubdivision | geoSubdivision |
| PhoneNumber | phoneNumber |
| IpAddress | ipAddress |

### Format Hints

OpenAPI format hints are mapped to DataTypes:

| Format | DataType |
|--------|----------|
| uri, url | url |
| email | email |
| uuid | uuid |
| date | date |
| date-time, timestamp | date-time |
| int32, int64 | integer |
| float, double | number |
| byte, base64, binary | byte |

### Primitives

| TypeScript Type | DataType |
|-----------------|----------|
| string | string |
| number | number |
| boolean | boolean |
| Date | date-time |
| object | object |

## Schema References

Define relationships between schemas using the `references` configuration:

```typescript
const repoSchema = builder.build({
  schemaId: 'github_repository_schema',
  modelClass: Repository,
  primaryKeys: ['id'],
  references: {
    owner: { schemaId: 'github_user_schema' },
    organization: {
      schemaId: 'github_org_schema',
      propertyName: 'login'  // Optional: specify which property links them
    },
  },
});
```

---

## License

UNLICENSED
