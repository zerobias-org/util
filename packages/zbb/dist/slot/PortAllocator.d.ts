import type { ScannedVar } from '../env/Scanner.js';
import type { Slot } from './Slot.js';
export interface PortAllocation {
    name: string;
    port: number;
    source: string;
}
/**
 * Allocate a non-overlapping port range for a new slot.
 *
 * Scans existing slots' portRange metadata and picks the next block
 * after the highest used port. Each slot gets its own contiguous range.
 */
export declare function allocateSlotPortRange(existingSlots: Slot[], rangeSize?: number): [number, number];
/**
 * Validate a port range doesn't overlap with any existing slot.
 */
export declare function validatePortRange(portRange: [number, number], existingSlots: Slot[]): void;
/**
 * Allocate ports for all port-type vars from a contiguous range.
 * Returns allocations in declaration order.
 */
export declare function allocatePorts(vars: ScannedVar[], range: [number, number], existingAllocations?: Map<string, number>): PortAllocation[];
