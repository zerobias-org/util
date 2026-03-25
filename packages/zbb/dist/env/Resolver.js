/**
 * Resolve ${VAR} references in env var defaults.
 * Topo-sorts by dependency order, detects cycles.
 */
const VAR_REF = /\$\{([^}]+)\}/g;
/** Extract ${VAR} references from a string */
export function extractRefs(value) {
    const refs = [];
    let match;
    while ((match = VAR_REF.exec(value)) !== null) {
        refs.push(match[1]);
    }
    return refs;
}
/** Interpolate ${VAR} references in a string using resolved values */
export function interpolate(template, resolved) {
    return template.replace(VAR_REF, (_, name) => {
        const val = resolved.get(name);
        if (val === undefined) {
            throw new Error(`Unresolved reference: \${${name}}`);
        }
        return val;
    });
}
/**
 * Topo-sort and resolve all vars.
 *
 * @param vars - Map of var name → raw value (may contain ${VAR} refs)
 * @param preResolved - Already-resolved vars (ports, secrets, inherited) that don't need interpolation
 */
export function resolveAll(vars, preResolved) {
    // Build entries with dependency lists
    const entries = [];
    for (const [name, raw] of vars) {
        entries.push({ name, raw, deps: extractRefs(raw) });
    }
    // Kahn's algorithm for topo sort
    const inDegree = new Map();
    const dependents = new Map(); // dep → vars that depend on it
    for (const entry of entries) {
        inDegree.set(entry.name, 0);
    }
    for (const entry of entries) {
        for (const dep of entry.deps) {
            // Only count deps that are in our entry set (not pre-resolved)
            if (inDegree.has(dep)) {
                inDegree.set(entry.name, (inDegree.get(entry.name) ?? 0) + 1);
                const list = dependents.get(dep) ?? [];
                list.push(entry.name);
                dependents.set(dep, list);
            }
            else if (!preResolved.has(dep)) {
                throw new Error(`Variable '${entry.name}' references unknown variable '\${${dep}}'`);
            }
        }
    }
    // Seed queue with zero in-degree
    const queue = [];
    for (const [name, degree] of inDegree) {
        if (degree === 0)
            queue.push(name);
    }
    const resolved = new Map(preResolved);
    const result = [];
    const entryMap = new Map(entries.map(e => [e.name, e]));
    while (queue.length > 0) {
        const name = queue.shift();
        const entry = entryMap.get(name);
        const hasDeps = entry.deps.length > 0;
        const value = hasDeps ? interpolate(entry.raw, resolved) : entry.raw;
        resolved.set(name, value);
        result.push({ name, value, derived: hasDeps });
        for (const dependent of dependents.get(name) ?? []) {
            const deg = inDegree.get(dependent) - 1;
            inDegree.set(dependent, deg);
            if (deg === 0)
                queue.push(dependent);
        }
    }
    // Cycle detection
    if (result.length < entries.length) {
        const unresolved = entries
            .filter(e => !resolved.has(e.name) || !result.find(r => r.name === e.name))
            .map(e => e.name);
        throw new Error(`Circular dependency detected among: ${unresolved.join(', ')}`);
    }
    return result;
}
