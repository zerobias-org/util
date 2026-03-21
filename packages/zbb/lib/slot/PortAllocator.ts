import { createServer } from 'node:net';
import type { ScannedVar } from '../env/Scanner.js';

export interface PortAllocation {
  name: string;
  port: number;
  source: string;
}

/**
 * Check if a port is free by attempting to bind to it.
 */
function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => {
      server.close(() => resolve(true));
    });
    server.listen(port, '0.0.0.0');
  });
}

/**
 * Pick a random free port from the range.
 */
async function findFreePort(range: [number, number], used: Set<number>): Promise<number> {
  const [start, end] = range;
  const size = end - start + 1;

  // Try random ports up to 100 times
  for (let i = 0; i < 100; i++) {
    const port = start + Math.floor(Math.random() * size);
    if (used.has(port)) continue;
    if (await isPortFree(port)) return port;
  }

  // Fallback: sequential scan
  for (let port = start; port <= end; port++) {
    if (used.has(port)) continue;
    if (await isPortFree(port)) return port;
  }

  throw new Error(`No free port in range [${start}-${end}]`);
}

/**
 * Allocate ports for all port-type vars.
 * Reuses existing allocations for the same slot (re-extend scenario).
 * New ports are picked randomly from the range and verified free.
 */
export async function allocatePorts(
  vars: ScannedVar[],
  range: [number, number],
  existingAllocations?: Map<string, number>,
): Promise<PortAllocation[]> {
  const portVars = vars.filter(v => v.declaration.type === 'port');
  const used = new Set<number>(existingAllocations?.values() ?? []);
  const allocations: PortAllocation[] = [];

  for (const v of portVars) {
    // If already allocated (re-extend), reuse if still free
    if (existingAllocations?.has(v.name)) {
      const existing = existingAllocations.get(v.name)!;
      allocations.push({ name: v.name, port: existing, source: v.source });
      continue;
    }

    const port = await findFreePort(range, used);
    allocations.push({ name: v.name, port, source: v.source });
    used.add(port);
  }

  return allocations;
}
