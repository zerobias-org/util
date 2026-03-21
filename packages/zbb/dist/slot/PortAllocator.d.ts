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
export declare function allocatePorts(vars: ScannedVar[], range: [number, number], existingAllocations?: Map<string, number>): PortAllocation[];
