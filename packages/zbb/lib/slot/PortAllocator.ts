import type { ScannedVar } from '../env/Scanner.js';

export interface PortAllocation {
  name: string;
  port: number;
  source: string;
}

/**
 * Allocate ports for all port-type vars from a contiguous range.
 * Returns allocations in declaration order.
 */
export function allocatePorts(
  vars: ScannedVar[],
  range: [number, number],
  existingAllocations?: Map<string, number>,
): PortAllocation[] {
  const [rangeStart, rangeEnd] = range;
  const portVars = vars.filter(v => v.declaration.type === 'port');
  const used = new Set<number>(existingAllocations?.values() ?? []);
  const allocations: PortAllocation[] = [];

  let nextPort = rangeStart;

  for (const v of portVars) {
    // If already allocated (re-create scenario), reuse
    if (existingAllocations?.has(v.name)) {
      allocations.push({
        name: v.name,
        port: existingAllocations.get(v.name)!,
        source: v.source,
      });
      continue;
    }

    // Find next available port in range
    while (used.has(nextPort) && nextPort <= rangeEnd) {
      nextPort++;
    }

    if (nextPort > rangeEnd) {
      throw new Error(
        `Port range exhausted [${rangeStart}-${rangeEnd}]. ` +
        `Need port for ${v.name} but all ${rangeEnd - rangeStart + 1} ports are allocated.`
      );
    }

    allocations.push({ name: v.name, port: nextPort, source: v.source });
    used.add(nextPort);
    nextPort++;
  }

  return allocations;
}
