/**
 * Resolve ${VAR} references in env var defaults.
 * Topo-sorts by dependency order, detects cycles.
 */

export interface ResolvedVar {
  name: string;
  value: string;
  derived: boolean;
}

interface VarEntry {
  name: string;
  raw: string;
  deps: string[];
}

const VAR_REF = /\$\{([^}]+)\}/g;

/** Extract ${VAR} references from a string */
export function extractRefs(value: string): string[] {
  const refs: string[] = [];
  let match;
  while ((match = VAR_REF.exec(value)) !== null) {
    refs.push(match[1]);
  }
  return refs;
}

/** Interpolate ${VAR} references in a string using resolved values */
export function interpolate(
  template: string,
  resolved: Map<string, string>,
  lenient = false,
): string {
  return template.replace(VAR_REF, (match, name) => {
    const val = resolved.get(name);
    if (val === undefined) {
      if (lenient) return match; // leave ${VAR} as-is for later resolution
      throw new Error(`Unresolved reference: \${${name}}`);
    }
    return val;
  });
}

export interface ResolveOptions {
  /**
   * When true, unknown variable references are left as literal `${VAR}`
   * instead of throwing. Used during `slot create` where vars like
   * `ZB_STACK` / stack-scoped imports aren't known yet — they get
   * resolved later during `stack add`.
   */
  lenient?: boolean;
}

/**
 * Topo-sort and resolve all vars.
 *
 * @param vars - Map of var name → raw value (may contain ${VAR} refs)
 * @param preResolved - Already-resolved vars (ports, secrets, inherited) that don't need interpolation
 * @param options - Resolution options (lenient mode for slot create)
 */
export function resolveAll(
  vars: Map<string, string>,
  preResolved: Map<string, string>,
  options?: ResolveOptions,
): ResolvedVar[] {
  const lenient = options?.lenient ?? false;
  // Build entries with dependency lists
  const entries: VarEntry[] = [];
  for (const [name, raw] of vars) {
    entries.push({ name, raw, deps: extractRefs(raw) });
  }

  // Kahn's algorithm for topo sort
  const inDegree = new Map<string, number>();
  const dependents = new Map<string, string[]>(); // dep → vars that depend on it

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
      } else if (!preResolved.has(dep)) {
        if (!lenient) {
          throw new Error(
            `Variable '${entry.name}' references unknown variable '\${${dep}}'`
          );
        }
        // Lenient: unknown dep won't block topo-sort. interpolate() in
        // lenient mode leaves the ${VAR} literal for later resolution.
      }
    }
  }

  // Seed queue with zero in-degree
  const queue: string[] = [];
  for (const [name, degree] of inDegree) {
    if (degree === 0) queue.push(name);
  }

  const resolved = new Map<string, string>(preResolved);
  const result: ResolvedVar[] = [];
  const entryMap = new Map(entries.map(e => [e.name, e]));

  while (queue.length > 0) {
    const name = queue.shift()!;
    const entry = entryMap.get(name)!;

    const hasDeps = entry.deps.length > 0;
    const value = hasDeps ? interpolate(entry.raw, resolved, lenient) : entry.raw;
    resolved.set(name, value);
    result.push({ name, value, derived: hasDeps });

    for (const dependent of dependents.get(name) ?? []) {
      const deg = inDegree.get(dependent)! - 1;
      inDegree.set(dependent, deg);
      if (deg === 0) queue.push(dependent);
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
