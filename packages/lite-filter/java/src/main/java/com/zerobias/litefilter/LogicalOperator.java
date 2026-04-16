package com.zerobias.litefilter;

/**
 * Logical operators for combining expressions.
 */
public enum LogicalOperator {
    AND("&", "AND"),
    OR("|", "OR"),
    NOT("!", "NOT");

    private final String token;
    private final String name;

    LogicalOperator(String token, String name) {
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
     * @return the logical operator
     * @throws IllegalArgumentException if token is not recognized
     */
    public static LogicalOperator parse(String token) {
        for (LogicalOperator op : values()) {
            if (op.token.equals(token)) {
                return op;
            }
        }
        throw new IllegalArgumentException("Unknown logical operator token: " + token);
    }

    @Override
    public String toString() {
        return token;
    }
}
