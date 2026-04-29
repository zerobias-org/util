# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is a multi-language library that provides a convenience layer for RFC4515 LDAP-style filters with extensions. The library parses filter expressions and provides a `matches()` operation to test objects against filter criteria.

**Language Implementations:**
- **npm/** - TypeScript/JavaScript implementation
- **java/** - Java implementation (in development)

For language-specific implementation guidance, see:
- `npm/CLAUDE.md` - TypeScript/JavaScript implementation details
- `java/CLAUDE.md` - Java implementation details (coming soon)

## Core Data Model

The codebase centers around a single interface hierarchy that should be consistent across all language implementations:

**Expression** (interface)
- Core method: `matches(obj, options?)` - tests if an object matches the expression
  - Options should include: case sensitivity control (default: case-insensitive)
- Internal implementations (not exposed in public API):
  - **Clause**: Represents a single comparison (property + operator + value)
  - **Grouping**: Represents logical combinations (AND/OR/NOT) of multiple Expressions

**ComparisonOperator** (internal class/enum)
- Contains `token` (e.g., "=", ":startsWith:") and `name` (e.g., "EQUALS", "BEGINS_WITH")
- Should have static instances/constants for all operators
- Should have a method to parse from token string
- **Note:** This is an internal implementation detail; users interact via Expression factory methods

## Extended RFC4515 Syntax

**Operator Syntax Rules:**
- Base RFC4515 operators and extensions to them: NO colons (e.g., `=`, `!=`, `>=`, `<=`, `~=`, `=*`)
- Custom function-style extensions: Use `:function:` format (e.g., `:startsWith:`, `:contains:`)

**Standard RFC4515 Operators:**
- `=` - Equality (supports wildcards with `*`)
- `!=` - Not equals
- `>=` - Greater than or equal
- `<=` - Less than or equal
- `~=` - Approximate match (uses fuzzy matching with default threshold)
- `=*` - Presence check (not null/undefined for singles, not empty for arrays)

**Wildcard Support:**
- `*` can be used in values: `(name=J*n)`, `(email=*@example.com)`

**Custom Extensions (`:function:` format):**
- String: `:contains:`, `:startsWith:`, `:endsWith:`, `:matches:` (regex)
- Null/Empty checks: `:isnull:` (null/undefined), `:isempty:` (arrays: null/undefined/zero-length)
- Array: `:includes:` (single element), `:includesAny:` (comma-separated OR logic)
- Numeric: `:between:` (inclusive range, comma-separated min,max)
- Date: `:withinDays:` (relative to now), `:year:` (extract year and compare equality)

## Key API Design

All functionality should be unified under the `Expression` object for a clean, composable API.

**Expression Factory Methods - Comparison Operations:**
- `equals(property, value)` - `=`
- `notEquals(property, value)` - `!=`
- `greaterThan(property, value)` - `>`
- `greaterThanOrEqual(property, value)` - `>=`
- `lessThan(property, value)` - `<`
- `lessThanOrEqual(property, value)` - `<=`
- `approxMatch(property, value)` - `~=` (fuzzy)
- `present(property)` - `=*` (exists)
- String operations: `contains`, `startsWith`, `endsWith`, `matches` (regex)
- Null/empty checks: `isNull`, `isEmpty`
- Array operations: `includes`, `includesAny`
- Numeric operations: `between`
- Date operations: `withinDays`, `year`

**Expression Factory Methods - Logical Operations:**
- `and(...expressions)` - `&` (AND)
- `or(...expressions)` - `|` (OR)
- `not(expression)` - `!` (NOT)

**Expression.parse(filter: string)**:
- Parses RFC4515 syntax into Expression tree
- Example: `Expression.parse('(&(status=active)(created_at>=2024-01-01))')`

## Adapter Pattern

Expressions can be translated to other query languages (SQL, DynamoDB, GraphQL, CQL, etc.):

- Adapters should implement a method: `fromExpression(expr: Expression): string`
- Register with: `Expression.addAdapter(key: string, description: string, adapter)`
  - **Note:** Adapters can be replaced - calling `addAdapter` with an existing key will overwrite
- List adapters: `Expression.adapters()` returns registered keys and descriptions
- Use with: `expression.as(key: string)` returns translated string

Example:
```
expr = Expression.parse('(&(status=active)(created_at>=2024-01-01))')
sql = expr.as("SQL")
// Returns: "status = 'active' AND created_at >= '2024-01-01'"
```

## Behavioral Specifications

### Type Coercion
- **Auto-coercion enabled**: String-number comparisons automatically coerce
  - `{age: "18"}` matches `(age=18)` ✓
  - `{age: "18"}` matches `(age>=18)` ✓
  - `{active: "true"}` matches `(active=true)` ✓

### Case Sensitivity
- **Default: Case-insensitive** for string comparisons
- Override with options parameter to matches()

### Property Access
- **Dot notation** for nested properties: `user.email`, `address.city`
- Missing properties are treated as undefined

### Null/Undefined Handling
- **`:isnull:`** returns true if property is undefined OR null
  - `{}` (no age property) matches `(age:isnull:)` ✓
  - `{age: null}` matches `(age:isnull:)` ✓
- **`:isempty:`** for arrays returns true if null, undefined, OR zero-length
  - `{}` matches `(tags:isempty:)` ✓
  - `{tags: null}` matches `(tags:isempty:)` ✓
  - `{tags: []}` matches `(tags:isempty:)` ✓
- **`=*`** presence check: equivalent to inverting `:isnull:` or `:isempty:`

### Date Handling
- **Format**: ISO 8601 only (`YYYY-MM-DD` or `YYYY-MM-DDTHH:mm:ss.sssZ`)
- **`:withinDays:`** is relative to current time (last N days from now)
- **`:year:`** extracts year and compares equality
  - `{created: "2025-03-15T10:30:00Z"}` matches `(created:year:2025)` ✓

### Numeric Operations
- **`:between:`** is inclusive: `[min, max]`
  - `{amount: 100}` matches `(amount:between:100,500)` ✓
  - `{amount: 500}` matches `(amount:between:100,500)` ✓
  - For exclusive bounds, use `>` and `<` separately

### String Matching
- **Wildcards** (`*`): `(name=J*n)` matches "John", "Joan", "Jean"
- **Approximate** (`~=`): Uses fuzzy matching library with default threshold
- **Case sensitivity** follows global option (default: insensitive)

### Array Operations
- **`:includes:`** checks if array contains the exact element
- **`:includesAny:`** checks if array intersects with comma-separated set (OR logic)
  - `{tags: ['a', 'b']}` matches `(tags:includesAny:b,c)` ✓

### Performance Optimization
- Expressions are designed for **stream filtering** (repeated evaluation)
- Consider caching compiled expressions for reuse
- Optimize property access paths during parsing

### Error Handling
- **Parser validation**: Validate operator-value compatibility during `Expression.parse()`
  - Invalid regex in `:matches:` → throw error
  - `:between:` without two numeric values → throw error
  - Malformed filter strings → throw exception

## Parser Implementation Guidelines

The RFC4515 parser must handle:
- **Prefix notation**: `(&(a=1)(b=2))` = AND, `(|(a=1)(b=2))` = OR, `(!(a=1))` = NOT
- **Nested groupings** with proper parenthesis matching
- **Standard operators**: `=`, `!=`, `>=`, `<=`, `~=`, `=*`
- **Wildcards**: `(name=J*n)` converts to regex-like substring matching
- **Extended function syntax**: `(property:function:value)` - only for custom extensions
- **Operator syntax detection**:
  - If token contains colons → custom extension (`:startsWith:`, `:contains:`)
  - Otherwise → standard operator (`=`, `!=`, `>=`, etc.)
- **Validation**: Check operator-value compatibility and throw errors for invalid syntax

## Matching Logic Requirements

The `matches()` method must:
- **Property access**: Navigate using dot notation (`user.email` → `obj.user.email`)
- **Type coercion**: Auto-coerce strings to numbers/booleans for comparisons
- **Case sensitivity**: Default insensitive, respect options parameter
- **Null handling**: Treat undefined properties as null for `:isnull:` checks
- **Array detection**: Differentiate array vs scalar for appropriate operator behavior
- **Wildcard expansion**: Convert `*` patterns to regex for matching
- **Date parsing**: Parse ISO 8601 strings to Date objects for date operations
- **Approximate matching**: Use fuzzy matching library for `~=` operator
- **Logical operators**: Apply recursively for Groupings (AND/OR/NOT)
- **Performance**: Optimize for repeated calls (stream filtering use case)
