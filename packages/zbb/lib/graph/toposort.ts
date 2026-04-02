/**
 * Generic topological sort using Kahn's algorithm (BFS).
 * Extracted from monorepo Workspace.ts and generalized.
 */

export interface TopoSortResult<T> {
  /** Items in dependency order (leaves first) */
  sorted: T[];
  /** Items involved in cycles, if any */
  cycles: T[];
}

/**
 * Topological sort using Kahn's algorithm.
 *
 * @param items   - All items to sort
 * @param getId   - Extract unique identifier from an item
 * @param getDeps - Extract dependency IDs for an item (must be IDs of other items)
 * @returns sorted items (dependencies first) and any cycle members
 */
export function toposort<T>(
  items: T[],
  getId: (item: T) => string,
  getDeps: (item: T) => string[],
): TopoSortResult<T> {
  const itemMap = new Map<string, T>();
  for (const item of items) {
    itemMap.set(getId(item), item);
  }

  // Build reverse adjacency (dependents) and compute in-degree
  const dependents = new Map<string, Set<string>>();
  const inDegree = new Map<string, number>();

  for (const item of items) {
    const id = getId(item);
    if (!dependents.has(id)) dependents.set(id, new Set());
    const deps = getDeps(item).filter(d => itemMap.has(d));
    inDegree.set(id, deps.length);

    for (const dep of deps) {
      if (!dependents.has(dep)) dependents.set(dep, new Set());
      dependents.get(dep)!.add(id);
    }
  }

  // BFS from zero-degree nodes
  const queue: string[] = [];
  for (const [id, degree] of inDegree) {
    if (degree === 0) queue.push(id);
  }

  const sortedIds: string[] = [];
  while (queue.length > 0) {
    const current = queue.shift()!;
    sortedIds.push(current);

    for (const dependent of dependents.get(current) ?? new Set()) {
      const newDegree = (inDegree.get(dependent) ?? 0) - 1;
      inDegree.set(dependent, newDegree);
      if (newDegree === 0) queue.push(dependent);
    }
  }

  // Map back to items
  const sorted = sortedIds.map(id => itemMap.get(id)!);
  const cycleIds = [...itemMap.keys()].filter(id => !sortedIds.includes(id));
  const cycles = cycleIds.map(id => itemMap.get(id)!);

  return { sorted, cycles };
}

/**
 * Get all transitive dependents of a given item (reverse transitive closure).
 */
export function getTransitiveDependents<T>(
  items: T[],
  getId: (item: T) => string,
  getDeps: (item: T) => string[],
  targetId: string,
): Set<string> {
  // Build reverse adjacency
  const dependents = new Map<string, Set<string>>();
  for (const item of items) {
    const id = getId(item);
    if (!dependents.has(id)) dependents.set(id, new Set());
    for (const dep of getDeps(item)) {
      if (!dependents.has(dep)) dependents.set(dep, new Set());
      dependents.get(dep)!.add(id);
    }
  }

  // BFS from target
  const result = new Set<string>();
  const queue = [targetId];
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const dep of dependents.get(current) ?? new Set()) {
      if (!result.has(dep)) {
        result.add(dep);
        queue.push(dep);
      }
    }
  }

  return result;
}
