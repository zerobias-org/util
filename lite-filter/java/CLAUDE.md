# CLAUDE.md - Java/Maven Implementation

This file provides Java/Maven-specific guidance to Claude Code (claude.ai/code) when working with code in this repository.

**For general project information, data model, syntax, and behavioral specifications, see [../CLAUDE.md](../CLAUDE.md).**

## Java Implementation Overview

This is the Java/Maven implementation of lite-filter. The module provides a type-safe API for parsing RFC4515 filters and testing Java objects (Maps, POJOs, etc.) against filter criteria.

## Java-Specific Architecture

### Class Structure

**MatchOptions class:**
```java
public class MatchOptions {
    private final boolean caseSensitive;

    public MatchOptions();  // default: case-insensitive
    public MatchOptions(boolean caseSensitive);
    public boolean isCaseSensitive();

    public static MatchOptions withCaseSensitive(boolean caseSensitive);
    public static MatchOptions defaults();
}
```

**Expression interface:**
```java
public interface Expression {
    boolean matches(Object obj);
    boolean matches(Object obj, MatchOptions options);
    String as(String adapterKey);

    // Static factory methods for all operators
    static Expression equals(String property, Object value) { ... }
    // ... all other factory methods

    // Parser
    static Expression parse(String filter) { ... }

    // Adapter management
    static void addAdapter(String key, String description, Adapter adapter) { ... }
    static Map<String, String> adapters() { ... }
}
```

**Adapter interface:**
```java
public interface Adapter {
    String fromExpression(Expression expression);
}
```

**ComparisonOperator enum:**
```java
public enum ComparisonOperator {
    EQUALS("=", "EQUALS"),
    NOT_EQUALS("!=", "NOT_EQUALS"),
    // ... all operators

    public String getToken();
    public String getName();
    public static ComparisonOperator parse(String token);
    public boolean isCustomExtension();
}
```

**LogicalOperator enum:**
```java
public enum LogicalOperator {
    AND("&", "AND"),
    OR("|", "OR"),
    NOT("!", "NOT");

    public String getToken();
    public String getName();
    public static LogicalOperator parse(String token);
}
```

### API Signatures

**Expression Factory Methods - Comparison Operations:**
```java
static Expression equals(String property, Object value)
static Expression notEquals(String property, Object value)
static Expression greaterThan(String property, Object value)
static Expression greaterThanOrEqual(String property, Object value)
static Expression lessThan(String property, Object value)
static Expression lessThanOrEqual(String property, Object value)
static Expression approxMatch(String property, String value)
static Expression present(String property)

// String operations
static Expression contains(String property, String value)
static Expression startsWith(String property, String value)
static Expression endsWith(String property, String value)
static Expression matches(String property, String regex)

// Null/empty checks
static Expression isNull(String property)
static Expression isEmpty(String property)

// Array operations
static Expression includes(String property, Object value)
static Expression includesAny(String property, String values)  // comma-separated

// Numeric operations
static Expression between(String property, Number min, Number max)

// Date operations
static Expression withinDays(String property, int days)
static Expression year(String property, int year)
```

**Expression Factory Methods - Logical Operations:**
```java
static Expression and(Expression... expressions)
static Expression or(Expression... expressions)
static Expression not(Expression expression)
```

**Parser:**
```java
static Expression parse(String filter)
```

**Adapter Management:**
```java
static void addAdapter(String key, String description, Adapter adapter)
static Map<String, String> adapters()
```

### Usage Examples

**Building filters programmatically:**
```java
Expression filter = Expression.and(
    Expression.or(
        Expression.equals("zip", "90210"),
        Expression.startsWith("name", "Rob")
    ),
    Expression.equals("status", "Active")
);

// Test an object
Map<String, Object> obj = new HashMap<>();
obj.put("zip", "90210");
obj.put("status", "Active");
boolean matches = filter.matches(obj);
```

**Stream filtering:**
```java
Expression activeUsers = Expression.and(
    Expression.equals("status", "active"),
    Expression.greaterThanOrEqual("age", 18)
);

List<Map<String, Object>> results = users.stream()
    .filter(user -> activeUsers.matches(user))
    .collect(Collectors.toList());

// With case-sensitive option
Expression caseSensitiveFilter = Expression.contains("name", "Rob");
MatchOptions options = MatchOptions.withCaseSensitive(true);
List<Map<String, Object>> results = users.stream()
    .filter(u -> caseSensitiveFilter.matches(u, options))
    .collect(Collectors.toList());
```

**Adapter usage:**
```java
Expression expr = Expression.parse("(&(status=active)(created_at>=2024-01-01))");
String sql = expr.as("SQL");
// Returns: "status = 'active' AND created_at >= '2024-01-01'"
```

## Java Implementation Notes

### Dependencies

**Required:**
- **me.xdrop:fuzzywuzzy:1.4.0** - For approximate matching (`~=` operator) using Levenshtein distance
- **com.google.code.gson:gson:2.10.1** - For JSON-like object property access

### File Organization

- `src/main/java/com/zerobias/litefilter/`
  - `Expression.java` - Core Expression interface with factory methods
  - `MatchOptions.java` - Options for matching behavior
  - `Adapter.java` - Adapter interface
  - `ComparisonOperator.java` - Enum for comparison operators
  - `LogicalOperator.java` - Enum for logical operators
  - `Clause.java` - Internal class for comparison clauses
  - `Grouping.java` - Internal class for logical groupings
  - `RFC4515Parser.java` - Parser for RFC4515 syntax
- `src/test/java/com/zerobias/litefilter/`
  - `ExpressionTest.java` - Unit tests

**Public API Surface:**
- Only `Expression`, `MatchOptions`, and `Adapter` are public interfaces/classes
- `ComparisonOperator` and `LogicalOperator` are public enums but typically not used directly by users
- `Clause`, `Grouping`, and parser classes are package-private (internal)

### Java-Specific Implementation Details

**Property Access using GSON:**
The implementation uses GSON to access nested properties via dot notation:
```java
private Object getPropertyValue(Object obj, String propertyPath) {
    JsonElement element = gson.toJsonTree(obj);
    String[] parts = propertyPath.split("\\.");

    for (String part : parts) {
        if (element != null && element.isJsonObject()) {
            element = element.getAsJsonObject().get(part);
        }
    }

    return jsonElementToObject(element);
}
```

**Type Coercion:**
Implement automatic coercion for string-number and string-boolean comparisons:
```java
private Object coerceValue(Object value, Object targetValue) {
    if (targetValue instanceof Number && value instanceof String) {
        try {
            if (targetValue instanceof Double || targetValue instanceof Float) {
                return Double.parseDouble((String) value);
            } else {
                return Long.parseLong((String) value);
            }
        } catch (NumberFormatException e) {
            return value;
        }
    }

    if (targetValue instanceof Boolean && value instanceof String) {
        return Boolean.parseBoolean((String) value);
    }

    return value;
}
```

**Date Parsing:**
Use Java 8 time API for ISO 8601 parsing:
```java
private LocalDateTime parseDateTime(Object value) {
    if (value instanceof String) {
        try {
            return LocalDateTime.parse((String) value, DateTimeFormatter.ISO_DATE_TIME);
        } catch (Exception e1) {
            try {
                LocalDate date = LocalDate.parse((String) value, DateTimeFormatter.ISO_DATE);
                return date.atStartOfDay();
            } catch (Exception e2) {
                return null;
            }
        }
    }
    return null;
}
```

**Fuzzy Matching:**
Use the FuzzyWuzzy library for `~=` operator (based on Levenshtein distance):
```java
import me.xdrop.fuzzywuzzy.FuzzySearch;

private static final int FUZZY_MATCH_THRESHOLD = 75; // Similarity threshold (0-100)

private boolean evaluateApproxMatch(Object propValue, Object compareValue) {
    if (!(propValue instanceof String) || !(compareValue instanceof String)) {
        return false;
    }

    String str1 = (String) propValue;
    String str2 = (String) compareValue;

    try {
        int similarity = FuzzySearch.ratio(str1, str2);
        return similarity >= FUZZY_MATCH_THRESHOLD;
    } catch (Exception e) {
        // Fallback to simple similarity check
        return str1.toLowerCase().contains(str2.toLowerCase()) ||
               str2.toLowerCase().contains(str1.toLowerCase());
    }
}
```

**Wildcard Pattern Matching:**
Convert wildcard patterns to regex:
```java
private boolean evaluateWildcard(Object propValue, String pattern, MatchOptions options) {
    if (!(propValue instanceof String)) {
        return false;
    }

    String regex = pattern.replace(".", "\\.").replace("*", ".*");
    Pattern p = options.isCaseSensitive()
        ? Pattern.compile("^" + regex + "$")
        : Pattern.compile("^" + regex + "$", Pattern.CASE_INSENSITIVE);

    return p.matcher((String) propValue).matches();
}
```

**Collection Handling:**
Use Java Collections API for array operations:
```java
private boolean evaluateIncludes(Object propValue, Object compareValue) {
    if (!(propValue instanceof Collection)) {
        return false;
    }
    return ((Collection<?>) propValue).contains(compareValue);
}

private boolean evaluateIncludesAny(Object propValue, Object compareValue) {
    if (!(propValue instanceof Collection) || !(compareValue instanceof String)) {
        return false;
    }
    Collection<?> collection = (Collection<?>) propValue;
    String[] values = ((String) compareValue).split(",");

    for (String val : values) {
        if (collection.contains(val.trim())) {
            return true;
        }
    }
    return false;
}
```

## Development Commands

```bash
# Install dependencies
mvn install

# Build
mvn clean compile

# Run tests
mvn test

# Run specific test
mvn test -Dtest=ExpressionTest

# Package
mvn package

# Generate Javadoc
mvn javadoc:javadoc

# Clean
mvn clean
```

## Testing Guidelines

- Use JUnit 5 for all tests
- Test with both Map and POJO objects
- Test case sensitivity options
- Test type coercion behavior
- Test nested property access
- Test all operators and logical combinations
- Test parser with valid and invalid syntax
- Test edge cases (null values, empty collections, etc.)
