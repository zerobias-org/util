package com.zerobias.litefilter;

import java.util.HashMap;
import java.util.Map;

/**
 * Expression interface for RFC4515 filter expressions.
 * Provides factory methods for building and parsing filter expressions.
 */
public interface Expression {

    /**
     * Test if an object matches this expression.
     *
     * @param obj the object to test
     * @return true if the object matches, false otherwise
     */
    boolean matches(Object obj);

    /**
     * Test if an object matches this expression with options.
     *
     * @param obj the object to test
     * @param options matching options
     * @return true if the object matches, false otherwise
     */
    boolean matches(Object obj, MatchOptions options);

    /**
     * Convert this expression using a registered adapter.
     *
     * @param adapterKey the key of the registered adapter
     * @return string representation in the target language
     * @throws IllegalArgumentException if adapter is not registered
     */
    String as(String adapterKey);

    // Adapter registry
    Map<String, AdapterInfo> ADAPTERS = new HashMap<>();

    /**
     * Register an adapter for converting expressions to other query languages.
     *
     * @param key the key to identify the adapter
     * @param description description of the adapter
     * @param adapter the adapter implementation
     */
    static void addAdapter(String key, String description, Adapter adapter) {
        ADAPTERS.put(key, new AdapterInfo(description, adapter));
    }

    /**
     * Get all registered adapters.
     *
     * @return map of adapter keys to descriptions
     */
    static Map<String, String> adapters() {
        Map<String, String> result = new HashMap<>();
        ADAPTERS.forEach((key, info) -> result.put(key, info.description));
        return result;
    }

    // Comparison operations

    /**
     * Create an equality expression.
     */
    static Expression equals(String property, Object value) {
        return new Clause(property, ComparisonOperator.EQUALS, value);
    }

    /**
     * Create a not equals expression.
     */
    static Expression notEquals(String property, Object value) {
        return new Clause(property, ComparisonOperator.NOT_EQUALS, value);
    }

    /**
     * Create a greater than expression.
     */
    static Expression greaterThan(String property, Object value) {
        return new Clause(property, ComparisonOperator.GREATER_THAN, value);
    }

    /**
     * Create a greater than or equal expression.
     */
    static Expression greaterThanOrEqual(String property, Object value) {
        return new Clause(property, ComparisonOperator.GREATER_THAN_OR_EQUAL, value);
    }

    /**
     * Create a less than expression.
     */
    static Expression lessThan(String property, Object value) {
        return new Clause(property, ComparisonOperator.LESS_THAN, value);
    }

    /**
     * Create a less than or equal expression.
     */
    static Expression lessThanOrEqual(String property, Object value) {
        return new Clause(property, ComparisonOperator.LESS_THAN_OR_EQUAL, value);
    }

    /**
     * Create an approximate match expression (fuzzy matching).
     */
    static Expression approxMatch(String property, String value) {
        return new Clause(property, ComparisonOperator.APPROX_MATCH, value);
    }

    /**
     * Create a presence check expression (not null/empty).
     */
    static Expression present(String property) {
        return new Clause(property, ComparisonOperator.PRESENCE_CHECK, null);
    }

    // String operations

    /**
     * Create a contains expression.
     */
    static Expression contains(String property, String value) {
        return new Clause(property, ComparisonOperator.CONTAINS, value);
    }

    /**
     * Create a starts with expression.
     */
    static Expression startsWith(String property, String value) {
        return new Clause(property, ComparisonOperator.BEGINS_WITH, value);
    }

    /**
     * Create an ends with expression.
     */
    static Expression endsWith(String property, String value) {
        return new Clause(property, ComparisonOperator.ENDS_WITH, value);
    }

    /**
     * Create a regex match expression.
     */
    static Expression matches(String property, String regex) {
        return new Clause(property, ComparisonOperator.REGEX, regex);
    }

    // Null/empty checks

    /**
     * Create an is null expression.
     */
    static Expression isNull(String property) {
        return new Clause(property, ComparisonOperator.IS_NULL, null);
    }

    /**
     * Create an is empty expression (for arrays).
     */
    static Expression isEmpty(String property) {
        return new Clause(property, ComparisonOperator.IS_EMPTY, null);
    }

    // Array operations

    /**
     * Create an includes expression (array contains element).
     */
    static Expression includes(String property, Object value) {
        return new Clause(property, ComparisonOperator.INCLUDES, value);
    }

    /**
     * Create an includes any expression (array intersects set).
     */
    static Expression includesAny(String property, String values) {
        return new Clause(property, ComparisonOperator.INCLUDES_ANY, values);
    }

    // Numeric operations

    /**
     * Create a between expression (inclusive range).
     */
    static Expression between(String property, Number min, Number max) {
        return new Clause(property, ComparisonOperator.BETWEEN, min + "," + max);
    }

    // Date operations

    /**
     * Create a within days expression (relative to now).
     */
    static Expression withinDays(String property, int days) {
        return new Clause(property, ComparisonOperator.WITHIN_DAYS, days);
    }

    /**
     * Create a year expression (extract year and compare).
     */
    static Expression year(String property, int year) {
        return new Clause(property, ComparisonOperator.YEAR, year);
    }

    // Logical operations

    /**
     * Create an AND expression.
     */
    static Expression and(Expression... expressions) {
        return new Grouping(LogicalOperator.AND, expressions);
    }

    /**
     * Create an OR expression.
     */
    static Expression or(Expression... expressions) {
        return new Grouping(LogicalOperator.OR, expressions);
    }

    /**
     * Create a NOT expression.
     */
    static Expression not(Expression expression) {
        return new Grouping(LogicalOperator.NOT, expression);
    }

    /**
     * Parse an RFC4515 filter string into an expression.
     *
     * @param filter the RFC4515 filter string
     * @return the parsed expression
     * @throws IllegalArgumentException if the filter is malformed
     */
    static Expression parse(String filter) {
        return RFC4515Parser.parse(filter);
    }

    /**
     * Internal class to hold adapter information.
     */
    class AdapterInfo {
        final String description;
        final Adapter adapter;

        AdapterInfo(String description, Adapter adapter) {
            this.description = description;
            this.adapter = adapter;
        }
    }
}
