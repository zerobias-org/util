# Fuzzy Matcher Library Evaluation

## Executive Summary

**Recommendation: Switch from `intuit/fuzzy-matcher` to `xdrop/fuzzywuzzy`**

The xdrop/fuzzywuzzy library is a better fit for lite-filter's simple string comparison needs. While intuit/fuzzy-matcher is a more feature-rich library, it's designed for complex document matching across multiple fields, which is overkill for our `~=` (approximate match) operator.

---

## Current Implementation: Intuit Fuzzy-Matcher

**Maven Coordinates:**
```xml
<dependency>
    <groupId>com.intuit.fuzzymatcher</groupId>
    <artifactId>fuzzy-matcher</artifactId>
    <version>1.2.1</version>
</dependency>
```

**Current Usage in Clause.java (lines 283-295):**
```java
// Complex API requiring Document/Element builders
Document doc1 = new Document.Builder("1")
    .addElement(new Element.Builder<String>().setValue(str1).createElement())
    .createDocument();
Document doc2 = new Document.Builder("2")
    .addElement(new Element.Builder<String>().setValue(str2).createElement())
    .createDocument();

MatchService matchService = new MatchService();
Map<Document, List<Match<Document>>> matches = matchService.applyMatch(
    Arrays.asList(doc1), Arrays.asList(doc2));

return !matches.isEmpty();
```

### Pros
- ✅ Recently maintained (last release Aug 2023)
- ✅ Rich feature set for multi-field document matching
- ✅ Multiple matching strategies (exact, soundex, n-gram, nearest neighbors)
- ✅ Good for complex record deduplication

### Cons
- ❌ **Overly complex for simple string comparison** - requires Document/Element wrappers
- ❌ **Performance overhead** - designed for O(N log N) bulk operations, not single comparisons
- ❌ **Heavier dependency** - brings in additional transitive dependencies
- ❌ **API mismatch** - we just need string similarity, not document matching
- ❌ **Verbose code** - 13 lines of code to compare two strings
- ❌ **Known issues** - users report threshold and exact-match-only problems

---

## Proposed Alternative: xdrop/fuzzywuzzy

**Maven Coordinates:**
```xml
<dependency>
    <groupId>me.xdrop</groupId>
    <artifactId>fuzzywuzzy</artifactId>
    <version>1.4.0</version>
</dependency>
```

**Proposed Usage:**
```java
// Simple, direct API
int score = FuzzySearch.ratio(str1, str2);
return score >= 75; // Configurable threshold
```

### Pros
- ✅ **Perfect API fit** - designed for simple string-to-string comparison
- ✅ **Zero dependencies** - completely self-contained
- ✅ **Proven algorithm** - Levenshtein distance (industry standard)
- ✅ **Simple to use** - 2 lines of code vs 13 lines
- ✅ **Lightweight** - no complex object creation overhead
- ✅ **Well-tested** - used by 736 projects
- ✅ **Multiple strategies** - ratio, partialRatio, tokenSort, tokenSet
- ✅ **No known issues** with basic string matching

### Cons
- ⚠️ **Dormant since 2020** - no recent updates (but stable and feature-complete)
- ⚠️ **Fixed threshold needed** - need to decide on similarity threshold (e.g., 75%)

---

## Detailed Comparison

| Aspect | Intuit Fuzzy-Matcher | xdrop FuzzyWuzzy |
|--------|---------------------|------------------|
| **Use Case** | Multi-field document matching | String similarity comparison |
| **API Complexity** | High (Document/Element builders) | Low (single method call) |
| **Dependencies** | Has transitive dependencies | Zero dependencies |
| **Code Lines** | 13 lines for comparison | 2 lines for comparison |
| **Algorithm** | Multiple (soundex, n-gram, etc.) | Levenshtein distance |
| **Performance** | Optimized for bulk (O(N log N)) | Optimized for single comparisons |
| **Maintenance** | Active (2023) | Dormant since 2020 |
| **Stars** | 253 | 856 |
| **Dependents** | Not specified | 736 projects |
| **Learning Curve** | Steeper | Minimal |

---

## Migration Impact

### Code Changes Required

**1. Update pom.xml:**
```xml
<!-- Replace -->
<dependency>
    <groupId>com.intuit.fuzzymatcher</groupId>
    <artifactId>fuzzy-matcher</artifactId>
    <version>1.2.1</version>
</dependency>

<!-- With -->
<dependency>
    <groupId>me.xdrop</groupId>
    <artifactId>fuzzywuzzy</artifactId>
    <version>1.4.0</version>
</dependency>
```

**2. Update Clause.java (lines 274-300):**
```java
// Current imports
import com.intuit.fuzzymatcher.component.MatchService;
import com.intuit.fuzzymatcher.domain.Document;
import com.intuit.fuzzymatcher.domain.Element;
import com.intuit.fuzzymatcher.domain.Match;

// New imports
import me.xdrop.fuzzywuzzy.FuzzySearch;

// Current implementation
private boolean evaluateApproxMatch(Object propValue, Object compareValue) {
    if (!(propValue instanceof String) || !(compareValue instanceof String)) {
        return false;
    }

    String str1 = (String) propValue;
    String str2 = (String) compareValue;

    try {
        Document doc1 = new Document.Builder("1")
            .addElement(new Element.Builder<String>().setValue(str1).createElement())
            .createDocument();
        Document doc2 = new Document.Builder("2")
            .addElement(new Element.Builder<String>().setValue(str2).createElement())
            .createDocument();

        MatchService matchService = new MatchService();
        Map<Document, List<Match<Document>>> matches = matchService.applyMatch(
            Arrays.asList(doc1), Arrays.asList(doc2));

        return !matches.isEmpty();
    } catch (Exception e) {
        return str1.toLowerCase().contains(str2.toLowerCase()) ||
               str2.toLowerCase().contains(str1.toLowerCase());
    }
}

// Proposed implementation
private static final int FUZZY_MATCH_THRESHOLD = 75; // Configurable

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
        // Fallback to simple contains check
        return str1.toLowerCase().contains(str2.toLowerCase()) ||
               str2.toLowerCase().contains(str1.toLowerCase());
    }
}
```

### Testing Considerations

- **Threshold tuning**: May need to adjust the default threshold (75) based on use case
- **Different results**: Levenshtein distance may give different results than intuit's algorithm
- **Test updates**: `testApproxMatch` tests may need adjustment if behavior changes

### Alternative Matching Strategies

FuzzyWuzzy offers multiple strategies for different use cases:

```java
// Simple ratio (Levenshtein distance)
FuzzySearch.ratio(str1, str2)

// Partial ratio (substring matching)
FuzzySearch.partialRatio(str1, str2)

// Token sort ratio (handles word reordering)
FuzzySearch.tokenSortRatio(str1, str2)

// Token set ratio (handles duplicates and reordering)
FuzzySearch.tokenSetRatio(str1, str2)

// Weighted ratio (best of all strategies)
FuzzySearch.weightedRatio(str1, str2)
```

We could use `weightedRatio()` for more robust matching if needed.

---

## Recommendation: Proceed with Migration

### Reasons to Switch:

1. **Simplicity**: Reduces code complexity from 13 lines to 2 lines
2. **Performance**: Lighter weight, no object creation overhead
3. **Dependencies**: Zero external dependencies vs multiple transitive deps
4. **Correctness**: Current implementation has a bug (wrong API usage)
5. **Maintainability**: Simpler code is easier to understand and maintain
6. **Right tool for the job**: FuzzyWuzzy is designed for this exact use case

### Risk Mitigation:

- **Library dormancy**: Not a concern - the library is feature-complete and stable
- **Behavior changes**: Can be tested and threshold adjusted if needed
- **Rollback**: Easy to revert if issues arise (only 2 files changed)

### Next Steps:

1. Update pom.xml dependency
2. Refactor evaluateApproxMatch() in Clause.java
3. Run existing tests to verify behavior
4. Tune FUZZY_MATCH_THRESHOLD if needed (default 75)
5. Consider making threshold configurable via MatchOptions in future

---

## Conclusion

**The xdrop/fuzzywuzzy library is the superior choice** for lite-filter's approximate matching needs. It provides a simpler, lighter, and more appropriate solution than intuit/fuzzy-matcher, which is designed for complex multi-field document matching scenarios that we don't require.

The migration is low-risk, high-reward, with minimal code changes and significant improvements in code clarity and performance.
