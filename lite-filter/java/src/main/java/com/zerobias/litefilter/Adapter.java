package com.zerobias.litefilter;

/**
 * Interface for adapters that convert expressions to other query languages.
 */
public interface Adapter {
    /**
     * Convert an expression to a string representation in the target query language.
     *
     * @param expression the expression to convert
     * @return string representation in the target language
     */
    String fromExpression(Expression expression);
}
