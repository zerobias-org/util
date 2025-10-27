# lite-filter (NPM/TypeScript)

TypeScript/JavaScript implementation of lite-filter, a convenience layer for [RFC4515](https://datatracker.ietf.org/doc/html/rfc4515) LDAP-style filters with powerful extensions.

For general information about the filter syntax, operators, and behavioral specifications, see [../README.md](../README.md).

## API

All functionality is unified under the `Expression` object for a clean, composable API.

### Factory Methods

**Comparison Operations:**
```typescript
Expression.equals(property, value)
Expression.notEquals(property, value)
Expression.greaterThan(property, value)
Expression.greaterThanOrEqual(property, value)
Expression.lessThan(property, value)
Expression.lessThanOrEqual(property, value)
Expression.approxMatch(property, value)     // ~= fuzzy matching
Expression.present(property)                // =* presence check

// String operations
Expression.contains(property, value)
Expression.startsWith(property, value)
Expression.endsWith(property, value)
Expression.matches(property, regex)

// Null/empty checks
Expression.isNull(property)
Expression.isEmpty(property)

// Array operations
Expression.includes(property, value)
Expression.includesAny(property, values)

// Numeric operations
Expression.between(property, min, max)

// Date operations
Expression.withinDays(property, days)
Expression.year(property, year)
```

**Logical Operations:**
```typescript
Expression.and(...expressions)
Expression.or(...expressions)
Expression.not(expression)
```

**Parser:**
```typescript
Expression.parse(filter: string)  // Parses RFC4515 syntax
```

### Usage Examples

**Building filters programmatically:**
```typescript
const filter = Expression.and(
  Expression.or(
    Expression.equals('zip', '90210'),
    Expression.startsWith('name', 'Rob')
  ),
  Expression.equals('status', 'Active')
);
// Equivalent to: (&(|(zip=90210)(name:startsWith:Rob))(status=Active))

// Test an object
filter.matches(someObject);
```

**Parsing RFC4515 syntax:**
```typescript
const filter = Expression.parse('(&(status=active)(age>=18))');
filter.matches({ status: 'active', age: 25 });  // true
```

**Stream filtering:**
```typescript
// Define a complex filter once
const activeAdults = Expression.and(
  Expression.equals('status', 'active'),
  Expression.greaterThanOrEqual('age', 18),
  Expression.or(
    Expression.contains('email', '@company.com'),
    Expression.equals('verified', true)
  )
);

// Reuse efficiently across streams
const results = users
  .filter(user => activeAdults.matches(user))
  .map(user => ({
    id: user.id,
    name: user.name,
    email: user.email
  }));

// With case-sensitive option
const filter = Expression.contains('name', 'Rob');
const matches = users.filter(u =>
  filter.matches(u, { caseSensitive: true })
);

// Parse from string and use as filter
const dynamicFilter = Expression.parse('(&(department=Engineering)(level>=5))');
const seniorEngineers = employees.filter(e => dynamicFilter.matches(e));
```

## Adapters

Expressions can be translated to other query languages through pluggable adapters. See [../README.md](../README.md#adapters) for details on the adapter pattern.

**TypeScript Adapter API:**
```typescript
// Register an adapter
Expression.addAdapter(key: string, description: string, adapter: Adapter);

// List registered adapters
Expression.adapters(): { [key: string]: string };

// Use an adapter
expression.as(key: string): string;
```

Example:
```typescript
let e = Expression.parse('(&(status=active)(created_at>=2024-01-01))');
let sql = e.as("SQL");
// returns: status = 'active' AND created_at >= '2024-01-01'
```

## Installation

```bash
npm install lite-filter
```

## Development

```bash
# Install dependencies
npm install

# Build
npm run build

# Run tests
npm test

# Run specific test file
npm test -- <test-file-name>

# Lint
npm run lint

# Type check
npx tsc --noEmit
```

## Dependencies

- **fast-fuzzy** - Required for approximate matching (`~=` operator)
