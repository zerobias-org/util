/**
 * Resolve ${VAR} references in env var defaults.
 * Topo-sorts by dependency order, detects cycles.
 */
export interface ResolvedVar {
    name: string;
    value: string;
    derived: boolean;
}
/** Extract ${VAR} references from a string */
export declare function extractRefs(value: string): string[];
/** Interpolate ${VAR} references in a string using resolved values */
export declare function interpolate(template: string, resolved: Map<string, string>): string;
/**
 * Topo-sort and resolve all vars.
 *
 * @param vars - Map of var name → raw value (may contain ${VAR} refs)
 * @param preResolved - Already-resolved vars (ports, secrets, inherited) that don't need interpolation
 */
export declare function resolveAll(vars: Map<string, string>, preResolved: Map<string, string>): ResolvedVar[];
