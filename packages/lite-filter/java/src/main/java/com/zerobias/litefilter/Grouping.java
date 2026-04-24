package com.zerobias.litefilter;

import java.util.Arrays;
import java.util.List;

/**
 * Internal class representing a logical grouping of expressions.
 * Not exposed in public API.
 */
class Grouping implements Expression {
    private final LogicalOperator operator;
    private final List<Expression> expressions;

    Grouping(LogicalOperator operator, Expression... expressions) {
        this.operator = operator;
        this.expressions = Arrays.asList(expressions);
    }

    Grouping(LogicalOperator operator, List<Expression> expressions) {
        this.operator = operator;
        this.expressions = expressions;
    }

    public LogicalOperator getOperator() {
        return operator;
    }

    public List<Expression> getExpressions() {
        return expressions;
    }

    @Override
    public boolean matches(Object obj) {
        return matches(obj, new MatchOptions());
    }

    @Override
    public boolean matches(Object obj, MatchOptions options) {
        switch (operator) {
            case AND:
                return evaluateAnd(obj, options);
            case OR:
                return evaluateOr(obj, options);
            case NOT:
                return evaluateNot(obj, options);
            default:
                throw new IllegalArgumentException("Unsupported logical operator: " + operator);
        }
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
     * Evaluate AND - all expressions must match.
     */
    private boolean evaluateAnd(Object obj, MatchOptions options) {
        for (Expression expr : expressions) {
            if (!expr.matches(obj, options)) {
                return false;
            }
        }
        return true;
    }

    /**
     * Evaluate OR - at least one expression must match.
     */
    private boolean evaluateOr(Object obj, MatchOptions options) {
        for (Expression expr : expressions) {
            if (expr.matches(obj, options)) {
                return true;
            }
        }
        return false;
    }

    /**
     * Evaluate NOT - expression must not match.
     */
    private boolean evaluateNot(Object obj, MatchOptions options) {
        if (expressions.size() != 1) {
            throw new IllegalArgumentException("NOT operator requires exactly one expression");
        }
        return !expressions.get(0).matches(obj, options);
    }

    @Override
    public String toString() {
        StringBuilder sb = new StringBuilder();
        sb.append("(").append(operator.getToken());
        for (Expression expr : expressions) {
            sb.append(expr.toString());
        }
        sb.append(")");
        return sb.toString();
    }
}
