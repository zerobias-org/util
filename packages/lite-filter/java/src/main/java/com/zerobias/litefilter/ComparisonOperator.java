package com.zerobias.litefilter;

/**
 * Comparison operators for filter expressions.
 */
public enum ComparisonOperator {
    // Standard RFC4515 operators
    EQUALS("=", "EQUALS"),
    NOT_EQUALS("!=", "NOT_EQUALS"),
    GREATER_THAN(">", "GREATER_THAN"),
    GREATER_THAN_OR_EQUAL(">=", "GREATER_THAN_OR_EQUAL"),
    LESS_THAN("<", "LESS_THAN"),
    LESS_THAN_OR_EQUAL("<=", "LESS_THAN_OR_EQUAL"),
    APPROX_MATCH("~=", "APPROX_MATCH"),
    PRESENCE_CHECK("=*", "PRESENCE_CHECK"),

    // String operations (custom extensions with colons)
    CONTAINS(":contains:", "CONTAINS"),
    BEGINS_WITH(":startsWith:", "BEGINS_WITH"),
    ENDS_WITH(":endsWith:", "ENDS_WITH"),
    REGEX(":matches:", "REGEX"),

    // Null/empty checks (custom extensions)
    IS_NULL(":isnull:", "IS_NULL"),
    IS_EMPTY(":isempty:", "IS_EMPTY"),

    // Array operations (custom extensions)
    INCLUDES(":includes:", "INCLUDES"),
    INCLUDES_ANY(":includesAny:", "INCLUDES_ANY"),

    // Numeric operations (custom extensions)
    BETWEEN(":between:", "BETWEEN"),

    // Date operations (custom extensions)
    WITHIN_DAYS(":withinDays:", "WITHIN_DAYS"),
    YEAR(":year:", "YEAR");

    private final String token;
    private final String name;

    ComparisonOperator(String token, String name) {
        this.token = token;
        this.name = name;
    }

    /**
     * Get the token representation of this operator.
     *
     * @return the token string
     */
    public String getToken() {
        return token;
    }

    /**
     * Get the name of this operator.
     *
     * @return the name string
     */
    public String getName() {
        return name;
    }

    /**
     * Parse a token string to get the corresponding operator.
     *
     * @param token the token to parse
     * @return the comparison operator
     * @throws IllegalArgumentException if token is not recognized
     */
    public static ComparisonOperator parse(String token) {
        for (ComparisonOperator op : values()) {
            if (op.token.equals(token)) {
                return op;
            }
        }
        throw new IllegalArgumentException("Unknown operator token: " + token);
    }

    /**
     * Check if this operator is a custom extension (uses colon format).
     *
     * @return true if custom extension, false if standard operator
     */
    public boolean isCustomExtension() {
        return token.contains(":");
    }

    @Override
    public String toString() {
        return token;
    }
}
