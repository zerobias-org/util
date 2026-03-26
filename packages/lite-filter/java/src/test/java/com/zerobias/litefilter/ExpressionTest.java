package com.zerobias.litefilter;

import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.*;

import java.util.*;

/**
 * Basic tests for Expression functionality.
 */
public class ExpressionTest {

    @Test
    public void testSimpleEquals() {
        Expression expr = Expression.equals("name", "John");

        Map<String, Object> obj1 = new HashMap<>();
        obj1.put("name", "John");
        assertTrue(expr.matches(obj1));

        Map<String, Object> obj2 = new HashMap<>();
        obj2.put("name", "Jane");
        assertFalse(expr.matches(obj2));
    }

    @Test
    public void testCaseInsensitiveByDefault() {
        Expression expr = Expression.equals("name", "john");

        Map<String, Object> obj = new HashMap<>();
        obj.put("name", "JOHN");
        assertTrue(expr.matches(obj));
    }

    @Test
    public void testCaseSensitive() {
        Expression expr = Expression.equals("name", "john");

        Map<String, Object> obj = new HashMap<>();
        obj.put("name", "JOHN");
        assertFalse(expr.matches(obj, MatchOptions.withCaseSensitive(true)));
    }

    @Test
    public void testNumericComparison() {
        Expression expr = Expression.greaterThanOrEqual("age", 18);

        Map<String, Object> obj1 = new HashMap<>();
        obj1.put("age", 25);
        assertTrue(expr.matches(obj1));

        Map<String, Object> obj2 = new HashMap<>();
        obj2.put("age", 15);
        assertFalse(expr.matches(obj2));
    }

    @Test
    public void testStringCoercionToNumber() {
        Expression expr = Expression.equals("age", 18);

        Map<String, Object> obj = new HashMap<>();
        obj.put("age", "18");
        assertTrue(expr.matches(obj));
    }

    @Test
    public void testAndLogic() {
        Expression expr = Expression.and(
            Expression.equals("status", "active"),
            Expression.greaterThanOrEqual("age", 18)
        );

        Map<String, Object> obj1 = new HashMap<>();
        obj1.put("status", "active");
        obj1.put("age", 25);
        assertTrue(expr.matches(obj1));

        Map<String, Object> obj2 = new HashMap<>();
        obj2.put("status", "inactive");
        obj2.put("age", 25);
        assertFalse(expr.matches(obj2));
    }

    @Test
    public void testOrLogic() {
        Expression expr = Expression.or(
            Expression.equals("zip", "90210"),
            Expression.equals("zip", "10001")
        );

        Map<String, Object> obj1 = new HashMap<>();
        obj1.put("zip", "90210");
        assertTrue(expr.matches(obj1));

        Map<String, Object> obj2 = new HashMap<>();
        obj2.put("zip", "12345");
        assertFalse(expr.matches(obj2));
    }

    @Test
    public void testNotLogic() {
        Expression expr = Expression.not(
            Expression.equals("status", "inactive")
        );

        Map<String, Object> obj1 = new HashMap<>();
        obj1.put("status", "active");
        assertTrue(expr.matches(obj1));

        Map<String, Object> obj2 = new HashMap<>();
        obj2.put("status", "inactive");
        assertFalse(expr.matches(obj2));
    }

    @Test
    public void testStartsWith() {
        Expression expr = Expression.startsWith("name", "John");

        Map<String, Object> obj1 = new HashMap<>();
        obj1.put("name", "John Doe");
        assertTrue(expr.matches(obj1));

        Map<String, Object> obj2 = new HashMap<>();
        obj2.put("name", "Jane Doe");
        assertFalse(expr.matches(obj2));
    }

    @Test
    public void testContains() {
        Expression expr = Expression.contains("email", "@example.com");

        Map<String, Object> obj1 = new HashMap<>();
        obj1.put("email", "user@example.com");
        assertTrue(expr.matches(obj1));

        Map<String, Object> obj2 = new HashMap<>();
        obj2.put("email", "user@other.com");
        assertFalse(expr.matches(obj2));
    }

    @Test
    public void testIsNull() {
        Expression expr = Expression.isNull("middleName");

        Map<String, Object> obj1 = new HashMap<>();
        obj1.put("firstName", "John");
        assertTrue(expr.matches(obj1));

        Map<String, Object> obj2 = new HashMap<>();
        obj2.put("middleName", "Robert");
        assertFalse(expr.matches(obj2));
    }

    @Test
    public void testIsEmpty() {
        Expression expr = Expression.isEmpty("tags");

        Map<String, Object> obj1 = new HashMap<>();
        obj1.put("tags", new ArrayList<>());
        assertTrue(expr.matches(obj1));

        Map<String, Object> obj2 = new HashMap<>();
        obj2.put("tags", Arrays.asList("a", "b"));
        assertFalse(expr.matches(obj2));
    }

    @Test
    public void testArrayIncludes() {
        Expression expr = Expression.includes("tags", "premium");

        Map<String, Object> obj1 = new HashMap<>();
        obj1.put("tags", Arrays.asList("premium", "verified"));
        assertTrue(expr.matches(obj1));

        Map<String, Object> obj2 = new HashMap<>();
        obj2.put("tags", Arrays.asList("basic", "verified"));
        assertFalse(expr.matches(obj2));
    }

    @Test
    public void testBetween() {
        Expression expr = Expression.between("amount", 100, 500);

        Map<String, Object> obj1 = new HashMap<>();
        obj1.put("amount", 250);
        assertTrue(expr.matches(obj1));

        Map<String, Object> obj2 = new HashMap<>();
        obj2.put("amount", 600);
        assertFalse(expr.matches(obj2));
    }

    @Test
    public void testWildcard() {
        Expression expr = Expression.equals("name", "J*n");

        Map<String, Object> obj1 = new HashMap<>();
        obj1.put("name", "John");
        assertTrue(expr.matches(obj1));

        Map<String, Object> obj2 = new HashMap<>();
        obj2.put("name", "Joan");
        assertTrue(expr.matches(obj2));

        Map<String, Object> obj3 = new HashMap<>();
        obj3.put("name", "Jane");
        assertFalse(expr.matches(obj3));
    }

    @Test
    public void testNestedProperty() {
        Expression expr = Expression.equals("user.email", "john@example.com");

        Map<String, Object> user = new HashMap<>();
        user.put("email", "john@example.com");

        Map<String, Object> obj = new HashMap<>();
        obj.put("user", user);

        assertTrue(expr.matches(obj));
    }

    @Test
    public void testParseSimple() {
        Expression expr = Expression.parse("(name=John)");

        Map<String, Object> obj = new HashMap<>();
        obj.put("name", "John");
        assertTrue(expr.matches(obj));
    }

    @Test
    public void testParseAnd() {
        Expression expr = Expression.parse("(&(status=active)(age>=18))");

        Map<String, Object> obj = new HashMap<>();
        obj.put("status", "active");
        obj.put("age", 25);
        assertTrue(expr.matches(obj));
    }

    @Test
    public void testParseOr() {
        Expression expr = Expression.parse("(|(zip=90210)(zip=10001))");

        Map<String, Object> obj = new HashMap<>();
        obj.put("zip", "90210");
        assertTrue(expr.matches(obj));
    }

    @Test
    public void testParseNot() {
        Expression expr = Expression.parse("(!(status=inactive))");

        Map<String, Object> obj = new HashMap<>();
        obj.put("status", "active");
        assertTrue(expr.matches(obj));
    }

    @Test
    public void testParseComplex() {
        Expression expr = Expression.parse("(&(|(zip=90210)(name:startsWith:Rob))(status=Active))");

        Map<String, Object> obj = new HashMap<>();
        obj.put("zip", "90210");
        obj.put("status", "Active");
        assertTrue(expr.matches(obj));
    }
}
