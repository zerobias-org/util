package com.zerobias.litefilter;

import java.util.ArrayList;
import java.util.List;

/**
 * Parser for RFC4515 filter expressions with extensions.
 */
public class RFC4515Parser {

    /**
     * Parse an RFC4515 filter string into an Expression.
     *
     * @param filter the filter string
     * @return the parsed expression
     * @throws IllegalArgumentException if the filter is malformed
     */
    public static Expression parse(String filter) {
        if (filter == null || filter.trim().isEmpty()) {
            throw new IllegalArgumentException("Filter cannot be null or empty");
        }

        filter = filter.trim();
        if (!filter.startsWith("(") || !filter.endsWith(")")) {
            throw new IllegalArgumentException("Filter must be enclosed in parentheses");
        }

        return parseExpression(filter);
    }

    /**
     * Parse a single expression (clause or grouping).
     */
    private static Expression parseExpression(String expr) {
        expr = expr.trim();

        // Remove outer parentheses
        if (!expr.startsWith("(") || !expr.endsWith(")")) {
            throw new IllegalArgumentException("Expression must be enclosed in parentheses: " + expr);
        }

        String inner = expr.substring(1, expr.length() - 1);

        // Check if it's a logical operator
        if (inner.length() > 0) {
            char firstChar = inner.charAt(0);
            if (firstChar == '&' || firstChar == '|' || firstChar == '!') {
                return parseGrouping(inner);
            }
        }

        // Otherwise it's a clause
        return parseClause(inner);
    }

    /**
     * Parse a logical grouping.
     */
    private static Expression parseGrouping(String expr) {
        char opChar = expr.charAt(0);
        LogicalOperator operator;

        switch (opChar) {
            case '&':
                operator = LogicalOperator.AND;
                break;
            case '|':
                operator = LogicalOperator.OR;
                break;
            case '!':
                operator = LogicalOperator.NOT;
                break;
            default:
                throw new IllegalArgumentException("Unknown logical operator: " + opChar);
        }

        // Parse the sub-expressions
        String subExpressions = expr.substring(1);
        List<Expression> expressions = parseSubExpressions(subExpressions);

        if (operator == LogicalOperator.NOT && expressions.size() != 1) {
            throw new IllegalArgumentException("NOT operator requires exactly one expression");
        }

        return new Grouping(operator, expressions);
    }

    /**
     * Parse multiple sub-expressions.
     */
    private static List<Expression> parseSubExpressions(String expr) {
        List<Expression> expressions = new ArrayList<>();
        int index = 0;
        int length = expr.length();

        while (index < length) {
            // Skip whitespace
            while (index < length && Character.isWhitespace(expr.charAt(index))) {
                index++;
            }

            if (index >= length) {
                break;
            }

            // Find matching parentheses
            if (expr.charAt(index) != '(') {
                throw new IllegalArgumentException("Expected '(' at position " + index);
            }

            int start = index;
            int parenCount = 0;
            while (index < length) {
                char c = expr.charAt(index);
                if (c == '(') {
                    parenCount++;
                } else if (c == ')') {
                    parenCount--;
                    if (parenCount == 0) {
                        index++;
                        break;
                    }
                }
                index++;
            }

            if (parenCount != 0) {
                throw new IllegalArgumentException("Unmatched parentheses in expression");
            }

            String subExpr = expr.substring(start, index);
            expressions.add(parseExpression(subExpr));
        }

        if (expressions.isEmpty()) {
            throw new IllegalArgumentException("No sub-expressions found");
        }

        return expressions;
    }

    /**
     * Parse a comparison clause.
     */
    private static Expression parseClause(String clause) {
        // Try to find operator
        // First check for custom extensions (contain colons)
        int colonIndex = clause.indexOf(':');
        if (colonIndex > 0) {
            return parseCustomExtension(clause);
        }

        // Check for standard operators
        return parseStandardOperator(clause);
    }

    /**
     * Parse custom extension operator (format: property:function:value).
     */
    private static Expression parseCustomExtension(String clause) {
        // Find the operator by looking for :xxx: pattern
        int firstColon = clause.indexOf(':');
        if (firstColon < 0) {
            throw new IllegalArgumentException("Invalid custom extension format: " + clause);
        }

        String property = clause.substring(0, firstColon);

        // Find the second colon
        int secondColon = clause.indexOf(':', firstColon + 1);
        if (secondColon < 0) {
            throw new IllegalArgumentException("Invalid custom extension format: " + clause);
        }

        String operatorToken = clause.substring(firstColon, secondColon + 1);
        String value = clause.substring(secondColon + 1);

        ComparisonOperator operator;
        try {
            operator = ComparisonOperator.parse(operatorToken);
        } catch (IllegalArgumentException e) {
            throw new IllegalArgumentException("Unknown operator: " + operatorToken);
        }

        // Convert value if needed
        Object actualValue = convertValue(value, operator);

        return new Clause(property, operator, actualValue);
    }

    /**
     * Parse standard operator (format: property op value).
     */
    private static Expression parseStandardOperator(String clause) {
        // Try operators in order of length (longest first to avoid matching substrings)
        String[] operators = {">=", "<=", "!=", "~=", "=*", "=", ">", "<"};

        for (String op : operators) {
            int index = clause.indexOf(op);
            if (index > 0) {
                String property = clause.substring(0, index);
                String value = clause.substring(index + op.length());

                ComparisonOperator operator;
                try {
                    operator = ComparisonOperator.parse(op);
                } catch (IllegalArgumentException e) {
                    continue;
                }

                // Convert value if needed
                Object actualValue = convertValue(value, operator);

                return new Clause(property, operator, actualValue);
            }
        }

        throw new IllegalArgumentException("No valid operator found in clause: " + clause);
    }

    /**
     * Convert string value to appropriate type based on operator.
     */
    private static Object convertValue(String value, ComparisonOperator operator) {
        if (value == null || value.isEmpty()) {
            return null;
        }

        // For operators that don't need values
        if (operator == ComparisonOperator.IS_NULL ||
            operator == ComparisonOperator.IS_EMPTY ||
            operator == ComparisonOperator.PRESENCE_CHECK) {
            return null;
        }

        // Try to parse as number for numeric operators
        if (operator == ComparisonOperator.GREATER_THAN ||
            operator == ComparisonOperator.GREATER_THAN_OR_EQUAL ||
            operator == ComparisonOperator.LESS_THAN ||
            operator == ComparisonOperator.LESS_THAN_OR_EQUAL ||
            operator == ComparisonOperator.WITHIN_DAYS ||
            operator == ComparisonOperator.YEAR) {
            try {
                if (value.contains(".")) {
                    return Double.parseDouble(value);
                } else {
                    return Integer.parseInt(value);
                }
            } catch (NumberFormatException e) {
                // Keep as string
            }
        }

        // Try to parse as boolean
        if (value.equalsIgnoreCase("true") || value.equalsIgnoreCase("false")) {
            return Boolean.parseBoolean(value);
        }

        // Return as string
        return value;
    }
}
