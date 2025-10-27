package com.zerobias.litefilter;

import me.xdrop.fuzzywuzzy.FuzzySearch;
import com.google.gson.*;

import java.time.LocalDate;
import java.time.LocalDateTime;
import java.time.format.DateTimeFormatter;
import java.time.temporal.ChronoUnit;
import java.util.*;
import java.util.regex.Pattern;

/**
 * Internal class representing a single comparison clause.
 * Not exposed in public API.
 */
class Clause implements Expression {
    private final String property;
    private final ComparisonOperator operator;
    private final Object value;
    private static final Gson gson = new Gson();
    private static final int FUZZY_MATCH_THRESHOLD = 75; // Similarity threshold (0-100)

    Clause(String property, ComparisonOperator operator, Object value) {
        this.property = property;
        this.operator = operator;
        this.value = value;
    }

    public String getProperty() {
        return property;
    }

    public ComparisonOperator getOperator() {
        return operator;
    }

    public Object getValue() {
        return value;
    }

    @Override
    public boolean matches(Object obj) {
        return matches(obj, new MatchOptions());
    }

    @Override
    public boolean matches(Object obj, MatchOptions options) {
        Object propertyValue = getPropertyValue(obj, property);
        return evaluateComparison(propertyValue, operator, value, options);
    }

    @Override
    public String as(String adapterKey) {
        Expression.AdapterInfo info = Expression.ADAPTERS.get(adapterKey);
        if (info == null) {
            throw new IllegalArgumentException("Adapter not registered: " + adapterKey);
        }
        return info.adapter.fromExpression(this);
    }

    /**
     * Get nested property value using dot notation.
     */
    private Object getPropertyValue(Object obj, String propertyPath) {
        if (obj == null) {
            return null;
        }

        // Convert object to JsonElement for property access
        JsonElement element = gson.toJsonTree(obj);
        String[] parts = propertyPath.split("\\.");

        for (String part : parts) {
            if (element == null || element.isJsonNull()) {
                return null;
            }
            if (element.isJsonObject()) {
                element = element.getAsJsonObject().get(part);
            } else {
                return null;
            }
        }

        return jsonElementToObject(element);
    }

    /**
     * Convert JsonElement to Java object.
     */
    private Object jsonElementToObject(JsonElement element) {
        if (element == null || element.isJsonNull()) {
            return null;
        }
        if (element.isJsonPrimitive()) {
            JsonPrimitive primitive = element.getAsJsonPrimitive();
            if (primitive.isBoolean()) {
                return primitive.getAsBoolean();
            } else if (primitive.isNumber()) {
                return primitive.getAsNumber();
            } else {
                return primitive.getAsString();
            }
        }
        if (element.isJsonArray()) {
            JsonArray array = element.getAsJsonArray();
            List<Object> list = new ArrayList<>();
            for (JsonElement item : array) {
                list.add(jsonElementToObject(item));
            }
            return list;
        }
        if (element.isJsonObject()) {
            return element;
        }
        return null;
    }

    /**
     * Evaluate the comparison based on operator type.
     */
    private boolean evaluateComparison(Object propValue, ComparisonOperator op, Object compareValue, MatchOptions options) {
        switch (op) {
            case EQUALS:
                return evaluateEquals(propValue, compareValue, options);
            case NOT_EQUALS:
                return !evaluateEquals(propValue, compareValue, options);
            case GREATER_THAN:
                return compareNumbers(propValue, compareValue) > 0;
            case GREATER_THAN_OR_EQUAL:
                return compareNumbers(propValue, compareValue) >= 0;
            case LESS_THAN:
                return compareNumbers(propValue, compareValue) < 0;
            case LESS_THAN_OR_EQUAL:
                return compareNumbers(propValue, compareValue) <= 0;
            case APPROX_MATCH:
                return evaluateApproxMatch(propValue, compareValue);
            case PRESENCE_CHECK:
                return evaluatePresence(propValue);
            case CONTAINS:
                return evaluateContains(propValue, compareValue, options);
            case BEGINS_WITH:
                return evaluateStartsWith(propValue, compareValue, options);
            case ENDS_WITH:
                return evaluateEndsWith(propValue, compareValue, options);
            case REGEX:
                return evaluateRegex(propValue, compareValue, options);
            case IS_NULL:
                return propValue == null;
            case IS_EMPTY:
                return evaluateIsEmpty(propValue);
            case INCLUDES:
                return evaluateIncludes(propValue, compareValue);
            case INCLUDES_ANY:
                return evaluateIncludesAny(propValue, compareValue);
            case BETWEEN:
                return evaluateBetween(propValue, compareValue);
            case WITHIN_DAYS:
                return evaluateWithinDays(propValue, compareValue);
            case YEAR:
                return evaluateYear(propValue, compareValue);
            default:
                throw new IllegalArgumentException("Unsupported operator: " + op);
        }
    }

    /**
     * Coerce value for comparison.
     */
    private Object coerceValue(Object value, Object targetValue) {
        if (value == null || targetValue == null) {
            return value;
        }

        // String to number coercion
        if (targetValue instanceof Number && value instanceof String) {
            try {
                String strValue = (String) value;
                if (targetValue instanceof Double || targetValue instanceof Float) {
                    return Double.parseDouble(strValue);
                } else {
                    return Long.parseLong(strValue);
                }
            } catch (NumberFormatException e) {
                return value;
            }
        }

        // String to boolean coercion
        if (targetValue instanceof Boolean && value instanceof String) {
            return Boolean.parseBoolean((String) value);
        }

        return value;
    }

    /**
     * Evaluate equals with wildcard support.
     */
    private boolean evaluateEquals(Object propValue, Object compareValue, MatchOptions options) {
        if (propValue == null && compareValue == null) return true;
        if (propValue == null || compareValue == null) return false;

        // Coerce values
        propValue = coerceValue(propValue, compareValue);
        compareValue = coerceValue(compareValue, propValue);

        // Check for wildcards in string comparison
        if (compareValue instanceof String) {
            String pattern = (String) compareValue;
            if (pattern.contains("*")) {
                return evaluateWildcard(propValue, pattern, options);
            }
        }

        // String comparison with case sensitivity
        if (propValue instanceof String && compareValue instanceof String) {
            String str1 = (String) propValue;
            String str2 = (String) compareValue;
            if (options.isCaseSensitive()) {
                return str1.equals(str2);
            } else {
                return str1.equalsIgnoreCase(str2);
            }
        }

        // Numeric comparison after coercion (compare values, not types)
        if (propValue instanceof Number && compareValue instanceof Number) {
            double d1 = ((Number) propValue).doubleValue();
            double d2 = ((Number) compareValue).doubleValue();
            return Double.compare(d1, d2) == 0;
        }

        return Objects.equals(propValue, compareValue);
    }

    /**
     * Evaluate wildcard pattern.
     */
    private boolean evaluateWildcard(Object propValue, String pattern, MatchOptions options) {
        if (!(propValue instanceof String)) {
            return false;
        }
        String str = (String) propValue;

        // Convert wildcard pattern to regex
        String regex = pattern.replace(".", "\\.").replace("*", ".*");
        Pattern p = options.isCaseSensitive()
            ? Pattern.compile("^" + regex + "$")
            : Pattern.compile("^" + regex + "$", Pattern.CASE_INSENSITIVE);

        return p.matcher(str).matches();
    }

    /**
     * Compare numbers with coercion.
     */
    private int compareNumbers(Object propValue, Object compareValue) {
        if (propValue == null || compareValue == null) {
            throw new IllegalArgumentException("Cannot compare null values");
        }

        // Coerce to numbers
        propValue = coerceValue(propValue, compareValue);
        compareValue = coerceValue(compareValue, propValue);

        if (!(propValue instanceof Number) || !(compareValue instanceof Number)) {
            throw new IllegalArgumentException("Cannot compare non-numeric values");
        }

        double d1 = ((Number) propValue).doubleValue();
        double d2 = ((Number) compareValue).doubleValue();
        return Double.compare(d1, d2);
    }

    /**
     * Evaluate approximate match using fuzzy matching (Levenshtein distance).
     */
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

    /**
     * Evaluate presence (not null/empty).
     */
    private boolean evaluatePresence(Object propValue) {
        if (propValue == null) return false;
        if (propValue instanceof Collection) {
            return !((Collection<?>) propValue).isEmpty();
        }
        if (propValue instanceof String) {
            return !((String) propValue).isEmpty();
        }
        return true;
    }

    /**
     * Evaluate contains.
     */
    private boolean evaluateContains(Object propValue, Object compareValue, MatchOptions options) {
        if (!(propValue instanceof String) || !(compareValue instanceof String)) {
            return false;
        }
        String str = (String) propValue;
        String pattern = (String) compareValue;
        if (options.isCaseSensitive()) {
            return str.contains(pattern);
        } else {
            return str.toLowerCase().contains(pattern.toLowerCase());
        }
    }

    /**
     * Evaluate starts with.
     */
    private boolean evaluateStartsWith(Object propValue, Object compareValue, MatchOptions options) {
        if (!(propValue instanceof String) || !(compareValue instanceof String)) {
            return false;
        }
        String str = (String) propValue;
        String pattern = (String) compareValue;
        if (options.isCaseSensitive()) {
            return str.startsWith(pattern);
        } else {
            return str.toLowerCase().startsWith(pattern.toLowerCase());
        }
    }

    /**
     * Evaluate ends with.
     */
    private boolean evaluateEndsWith(Object propValue, Object compareValue, MatchOptions options) {
        if (!(propValue instanceof String) || !(compareValue instanceof String)) {
            return false;
        }
        String str = (String) propValue;
        String pattern = (String) compareValue;
        if (options.isCaseSensitive()) {
            return str.endsWith(pattern);
        } else {
            return str.toLowerCase().endsWith(pattern.toLowerCase());
        }
    }

    /**
     * Evaluate regex match.
     */
    private boolean evaluateRegex(Object propValue, Object compareValue, MatchOptions options) {
        if (!(propValue instanceof String) || !(compareValue instanceof String)) {
            return false;
        }
        String str = (String) propValue;
        String regex = (String) compareValue;
        Pattern pattern = options.isCaseSensitive()
            ? Pattern.compile(regex)
            : Pattern.compile(regex, Pattern.CASE_INSENSITIVE);
        return pattern.matcher(str).find();
    }

    /**
     * Evaluate is empty (for arrays).
     */
    private boolean evaluateIsEmpty(Object propValue) {
        if (propValue == null) return true;
        if (propValue instanceof Collection) {
            return ((Collection<?>) propValue).isEmpty();
        }
        return false;
    }

    /**
     * Evaluate includes (array contains element).
     */
    private boolean evaluateIncludes(Object propValue, Object compareValue) {
        if (!(propValue instanceof Collection)) {
            return false;
        }
        Collection<?> collection = (Collection<?>) propValue;
        return collection.contains(compareValue);
    }

    /**
     * Evaluate includes any (array intersects set).
     */
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

    /**
     * Evaluate between (inclusive range).
     */
    private boolean evaluateBetween(Object propValue, Object compareValue) {
        if (!(compareValue instanceof String)) {
            return false;
        }
        String[] parts = ((String) compareValue).split(",");
        if (parts.length != 2) {
            throw new IllegalArgumentException("Between requires two values: min,max");
        }

        try {
            double value = ((Number) coerceValue(propValue, 0.0)).doubleValue();
            double min = Double.parseDouble(parts[0].trim());
            double max = Double.parseDouble(parts[1].trim());
            return value >= min && value <= max;
        } catch (Exception e) {
            return false;
        }
    }

    /**
     * Evaluate within days (relative to now).
     */
    private boolean evaluateWithinDays(Object propValue, Object compareValue) {
        LocalDateTime date = parseDateTime(propValue);
        if (date == null) return false;

        int days = ((Number) compareValue).intValue();
        LocalDateTime now = LocalDateTime.now();
        LocalDateTime threshold = now.minusDays(days);

        return date.isAfter(threshold) && date.isBefore(now.plusDays(1));
    }

    /**
     * Evaluate year (extract year and compare).
     */
    private boolean evaluateYear(Object propValue, Object compareValue) {
        LocalDateTime date = parseDateTime(propValue);
        if (date == null) return false;

        int year = ((Number) compareValue).intValue();
        return date.getYear() == year;
    }

    /**
     * Parse ISO 8601 date string.
     */
    private LocalDateTime parseDateTime(Object value) {
        if (value == null) return null;

        if (value instanceof String) {
            String str = (String) value;
            try {
                // Try full ISO 8601 format
                return LocalDateTime.parse(str, DateTimeFormatter.ISO_DATE_TIME);
            } catch (Exception e1) {
                try {
                    // Try date only format
                    LocalDate date = LocalDate.parse(str, DateTimeFormatter.ISO_DATE);
                    return date.atStartOfDay();
                } catch (Exception e2) {
                    return null;
                }
            }
        }
        return null;
    }

    @Override
    public String toString() {
        if (operator.isCustomExtension()) {
            return "(" + property + operator.getToken() + (value != null ? value : "") + ")";
        } else {
            return "(" + property + operator.getToken() + (value != null ? value : "") + ")";
        }
    }
}
