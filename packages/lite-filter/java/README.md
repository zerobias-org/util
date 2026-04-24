# lite-filter (Java/Maven)

Java implementation of lite-filter, a convenience layer for [RFC4515](https://datatracker.ietf.org/doc/html/rfc4515) LDAP-style filters with powerful extensions.

For general information about the filter syntax, operators, and behavioral specifications, see [../README.md](../README.md).

## Installation

### Maven

Add to your `pom.xml`:

```xml
<dependency>
    <groupId>com.zb</groupId>
    <artifactId>lite-filter</artifactId>
    <version>1.0.0-SNAPSHOT</version>
</dependency>
```

### Gradle

Add to your `build.gradle`:

```gradle
dependencies {
    implementation 'com.zb:lite-filter:1.0.0-SNAPSHOT'
}
```

## API

All functionality is unified under the `Expression` interface for a clean, composable API.

### Factory Methods

**Comparison Operations:**
```java
Expression.equals(String property, Object value)
Expression.notEquals(String property, Object value)
Expression.greaterThan(String property, Object value)
Expression.greaterThanOrEqual(String property, Object value)
Expression.lessThan(String property, Object value)
Expression.lessThanOrEqual(String property, Object value)
Expression.approxMatch(String property, String value)     // ~= fuzzy matching
Expression.present(String property)                        // =* presence check

// String operations
Expression.contains(String property, String value)
Expression.startsWith(String property, String value)
Expression.endsWith(String property, String value)
Expression.matches(String property, String regex)

// Null/empty checks
Expression.isNull(String property)
Expression.isEmpty(String property)

// Array operations
Expression.includes(String property, Object value)
Expression.includesAny(String property, String values)

// Numeric operations
Expression.between(String property, Number min, Number max)

// Date operations
Expression.withinDays(String property, int days)
Expression.year(String property, int year)
```

**Logical Operations:**
```java
Expression.and(Expression... expressions)
Expression.or(Expression... expressions)
Expression.not(Expression expression)
```

**Parser:**
```java
Expression.parse(String filter)  // Parses RFC4515 syntax
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
// Equivalent to: (&(|(zip=90210)(name:startsWith:Rob))(status=Active))

// Test an object (Map, POJO, or any object)
Map<String, Object> user = new HashMap<>();
user.put("zip", "90210");
user.put("status", "Active");

boolean matches = filter.matches(user);  // true
```

**Parsing RFC4515 syntax:**
```java
Expression filter = Expression.parse("(&(status=active)(age>=18))");

Map<String, Object> person = new HashMap<>();
person.put("status", "active");
person.put("age", 25);

filter.matches(person);  // true
```

**Stream filtering:**
```java
// Define a complex filter once
Expression activeAdults = Expression.and(
    Expression.equals("status", "active"),
    Expression.greaterThanOrEqual("age", 18),
    Expression.or(
        Expression.contains("email", "@company.com"),
        Expression.equals("verified", true)
    )
);

// Reuse efficiently across streams
List<Map<String, Object>> users = getUsers();
List<Map<String, Object>> results = users.stream()
    .filter(user -> activeAdults.matches(user))
    .collect(Collectors.toList());

// With case-sensitive option
Expression filter = Expression.contains("name", "Rob");
MatchOptions options = MatchOptions.withCaseSensitive(true);
List<Map<String, Object>> matches = users.stream()
    .filter(u -> filter.matches(u, options))
    .collect(Collectors.toList());

// Parse from string and use as filter
Expression dynamicFilter = Expression.parse("(&(department=Engineering)(level>=5))");
List<Map<String, Object>> seniorEngineers = employees.stream()
    .filter(e -> dynamicFilter.matches(e))
    .collect(Collectors.toList());
```

**Working with POJOs:**
```java
public class User {
    private String name;
    private int age;
    private String status;
    // getters and setters
}

Expression filter = Expression.and(
    Expression.equals("status", "active"),
    Expression.greaterThanOrEqual("age", 18)
);

User user = new User();
user.setName("John");
user.setAge(25);
user.setStatus("active");

filter.matches(user);  // true
```

**Nested properties:**
```java
Expression filter = Expression.equals("user.email", "john@example.com");

Map<String, Object> userInfo = new HashMap<>();
userInfo.put("email", "john@example.com");

Map<String, Object> obj = new HashMap<>();
obj.put("user", userInfo);

filter.matches(obj);  // true
```

## Adapters

Expressions can be translated to other query languages through pluggable adapters. See [../README.md](../README.md#adapters) for details on the adapter pattern.

**Java Adapter API:**
```java
// Register an adapter
Expression.addAdapter(String key, String description, Adapter adapter);

// List registered adapters
Map<String, String> adapters = Expression.adapters();

// Use an adapter
String result = expression.as(String adapterKey);
```

Example adapter implementation:
```java
public class SqlAdapter implements Adapter {
    @Override
    public String fromExpression(Expression expression) {
        // Convert expression to SQL
        // Implementation details...
    }
}

// Register the adapter
Expression.addAdapter("SQL", "ANSI SQL", new SqlAdapter());

// Use it
Expression expr = Expression.parse("(&(status=active)(created_at>=2024-01-01))");
String sql = expr.as("SQL");
// Returns: status = 'active' AND created_at >= '2024-01-01'
```

## Development

```bash
# Build the project
mvn clean install

# Run tests
mvn test

# Run specific test
mvn test -Dtest=ExpressionTest

# Package as JAR
mvn package

# Generate Javadoc
mvn javadoc:javadoc
```

## Dependencies

- **com.intuit.fuzzymatcher:fuzzy-matcher:1.2.1** - For approximate matching (`~=` operator)
- **com.google.code.gson:gson:2.10.1** - For JSON object property access
- **JUnit 5** - For testing (test scope)

## Requirements

- Java 11 or higher
- Maven 3.6 or higher
