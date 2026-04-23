package com.zerobias.litefilter;

/**
 * Options for controlling match behavior.
 */
public class MatchOptions {
    private final boolean caseSensitive;

    /**
     * Create default match options (case-insensitive).
     */
    public MatchOptions() {
        this.caseSensitive = false;
    }

    /**
     * Create match options with specified case sensitivity.
     *
     * @param caseSensitive true for case-sensitive matching, false for case-insensitive
     */
    public MatchOptions(boolean caseSensitive) {
        this.caseSensitive = caseSensitive;
    }

    /**
     * Check if matching should be case-sensitive.
     *
     * @return true if case-sensitive, false otherwise
     */
    public boolean isCaseSensitive() {
        return caseSensitive;
    }

    /**
     * Create a new MatchOptions with case sensitivity set.
     *
     * @param caseSensitive true for case-sensitive matching
     * @return new MatchOptions instance
     */
    public static MatchOptions withCaseSensitive(boolean caseSensitive) {
        return new MatchOptions(caseSensitive);
    }

    /**
     * Create default match options (case-insensitive).
     *
     * @return new MatchOptions instance with default settings
     */
    public static MatchOptions defaults() {
        return new MatchOptions();
    }
}
