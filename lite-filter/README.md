# lite-filter

A lightweight library that provides a convenience layer for [RFC4515](https://datatracker.ietf.org/doc/html/rfc4515) LDAP-style filters with powerful extensions. Parse filter expressions and test objects against filter criteria in multiple languages.

## Language Implementations

- **[npm/](npm/)** - TypeScript/JavaScript implementation for Node.js and browsers
- **[java/](java/)** - Java implementation (coming soon)

## Core Concepts

### Data Model

The base data model consists of an interface called `Expression` that provides a `matches` operation that returns true if an object matches the expression.

There are two subclasses of the `Expression` interface:
- **Clause**: An object with a `property`, `comparisonOperator`, and `value`
- **Grouping**: An object with a `logicalOperator` and a collection of `Expression` objects

### Extended RFC4515 Syntax

This library implements the RFC4515 filter syntax with powerful extensions:

```
# Extended RFC4515 syntax with functions

# SYNTAX RULES:
# - Base operators (RFC4515 + extensions): NO colons
#   Examples: =, !=, >=, <=, ~=, =*
# - Custom function extensions: USE colons
#   Format: (attribute:function:value)

# Standard RFC4515 Operators (no colons)
(name=John)                           # EQUALS
(name!=John)                          # NOT_EQUALS
(age>=18)                             # GREATER_THAN_OR_EQUAL
(age<=65)                             # LESS_THAN_OR_EQUAL
(name~=Jon)                           # APPROX_MATCH (fuzzy matching)
(email=*)                             # PRESENCE_CHECK (not null/empty)

# Wildcards (with = operator)
(name=J*)                             # Starts with J
(name=*son)                           # Ends with son
(name=J*n)                            # Starts with J, ends with n

# String functions (custom extensions with colons)
(email:contains:@example.com)         # CONTAINS
(name:startsWith:John)                # BEGINS_WITH
(name:endsWith:son)                   # ENDS_WITH
(path:matches:^/home/.*/documents$)   # REGEX

# Null/Empty checks (custom extensions)
(name:isnull:)                        # IS_NULL (checks null OR undefined)
(tags:isempty:)                       # IS_EMPTY (arrays: null OR undefined OR zero-length)

# Array functions (custom extensions)
(tags:includes:premium)               # Array contains element
(permissions:includesAny:read,write)  # Array intersects set (OR logic)

# Numeric functions (custom extensions)
(amount:between:100,500)              # Range check (inclusive: [100,500])

# Date functions (custom extensions, ISO 8601 format only)
(created:withinDays:30)               # Within last 30 days from now
(modified:year:2025)                  # Extract year and compare equality

# Logical Operators
(&(status=active)(age>=18))           # AND
(|(zip=90210)(zip=10001))             # OR
(!(status=inactive))                  # NOT
```

## Adapters

Expressions can be translated to other query languages through an adapter pattern:

- Adapters implement a method that takes an `Expression` and returns a string representation
- Adapters can be registered with a key (e.g., "SQL", "DynamoDB", "GraphQL")
- Expressions can be converted using the registered adapter key

Example translations:
```
# DynamoDB
(email:contains:@example.com) → contains(email, :domain)

# GraphQL
(name:startsWith:John) → { name: { startsWith: "John" } }

# CQL
(text:contains:keyword) → text~"keyword"

# SQL
(&(status=active)(created_at>=2024-01-01)) → status = 'active' AND created_at >= '2024-01-01'
```

**Note:** Calling `addAdapter` with an existing key will replace the previous adapter.

## Behavioral Specifications

### Type Coercion
String-number and string-boolean comparisons automatically coerce:
- `{age: "18"}` matches `(age=18)` ✓
- `{age: "18"}` matches `(age>=18)` ✓
- `{active: "true"}` matches `(active=true)` ✓

### Case Sensitivity
String comparisons are **case-insensitive by default**.

### Property Access
Nested properties use **dot notation**: `user.email`, `address.city`

### Null/Undefined Handling
- **`:isnull:`** - Returns true if property is undefined OR null
  - `{}` (no age property) matches `(age:isnull:)` ✓
  - `{age: null}` matches `(age:isnull:)` ✓
- **`:isempty:`** - Returns true if array is null, undefined, OR zero-length
  - `{}` matches `(tags:isempty:)` ✓
  - `{tags: null}` matches `(tags:isempty:)` ✓
  - `{tags: []}` matches `(tags:isempty:)` ✓
- **`=*`** (presence) - Opposite of `:isnull:`/`:isempty:`

### Date Handling
- **Format**: ISO 8601 only: `YYYY-MM-DD` or `YYYY-MM-DDTHH:mm:ss.sssZ`
- **`:withinDays:`** - Relative to current time (last N days from now)
- **`:year:`** - Extracts year and compares equality
  - `{created: "2025-03-15T10:30:00Z"}` matches `(created:year:2025)` ✓

### Numeric Operations
- **`:between:`** is inclusive: `[min, max]`
  - `{amount: 100}` matches `(amount:between:100,500)` ✓
  - `{amount: 500}` matches `(amount:between:100,500)` ✓
  - For exclusive bounds, use `>` and `<` separately

### String Matching
- **Wildcards** (`*`): `(name=J*n)` matches "John", "Joan", "Jean"
- **Approximate** (`~=`): Uses fuzzy matching with default threshold
- **Case sensitivity** follows configuration (default: insensitive)

### Array Operations
- **`:includes:`** - Checks if array contains the exact element
- **`:includesAny:`** - Checks if array intersects with comma-separated set (OR logic)
  - `{tags: ['a', 'b']}` matches `(tags:includesAny:b,c)` ✓

### Performance Optimization
Expressions are designed for **stream filtering** (repeated evaluation). Create an expression once and reuse it across many objects for best performance.

### Error Handling
Parser should validate operator-value compatibility:
- Invalid regex in `:matches:` → throw error
- `:between:` without two numeric values → throw error
- Malformed filter strings → throw exception

## Language-Specific Documentation

For language-specific APIs, usage examples, and implementation details, see:
- **[npm/README.md](npm/README.md)** - TypeScript/JavaScript documentation
- **[java/README.md](java/README.md)** - Java documentation (coming soon)
