const DEFAULT_RANGE_SIZE = 100;
const FIRST_SLOT_START = 15000;
/**
 * Check if two port ranges overlap.
 */
function portRangesOverlap(a, b) {
    return !(a[1] < b[0] || a[0] > b[1]);
}
/**
 * Allocate a non-overlapping port range for a new slot.
 *
 * Scans existing slots' portRange metadata and picks the next block
 * after the highest used port. Each slot gets its own contiguous range.
 */
export function allocateSlotPortRange(existingSlots, rangeSize = DEFAULT_RANGE_SIZE) {
    let highestPort = FIRST_SLOT_START - 1;
    for (const slot of existingSlots) {
        const range = slot.meta?.portRange;
        if (range) {
            if (range[1] > highestPort) {
                highestPort = range[1];
            }
        }
    }
    const start = highestPort + 1;
    return [start, start + rangeSize - 1];
}
/**
 * Validate a port range doesn't overlap with any existing slot.
 */
export function validatePortRange(portRange, existingSlots) {
    const [start, end] = portRange;
    if (start < 1024) {
        throw new Error(`Port range start ${start} is below 1024 (reserved)`);
    }
    if (end > 65_535) {
        throw new Error(`Port range end ${end} exceeds 65535`);
    }
    if (start >= end) {
        throw new Error(`Invalid port range [${start}, ${end}]`);
    }
    for (const slot of existingSlots) {
        const existing = slot.meta?.portRange;
        if (existing && portRangesOverlap(portRange, existing)) {
            throw new Error(`Port range ${start}-${end} overlaps with slot '${slot.name}' (${existing[0]}-${existing[1]})`);
        }
    }
}
/**
 * Allocate ports for all port-type vars from a contiguous range.
 * Returns allocations in declaration order.
 */
export function allocatePorts(vars, range, existingAllocations) {
    const [rangeStart, rangeEnd] = range;
    const portVars = vars.filter(v => v.declaration.type === 'port');
    const used = new Set(existingAllocations?.values() ?? []);
    const allocations = [];
    let nextPort = rangeStart;
    for (const v of portVars) {
        // If already allocated (re-extend scenario), reuse
        if (existingAllocations?.has(v.name)) {
            allocations.push({
                name: v.name,
                port: existingAllocations.get(v.name),
                source: v.source,
            });
            continue;
        }
        // Find next available port in range
        while (used.has(nextPort) && nextPort <= rangeEnd) {
            nextPort++;
        }
        if (nextPort > rangeEnd) {
            throw new Error(`Port range exhausted [${rangeStart}-${rangeEnd}]. ` +
                `Need port for ${v.name} but all ${rangeEnd - rangeStart + 1} ports are allocated.`);
        }
        allocations.push({ name: v.name, port: nextPort, source: v.source });
        used.add(nextPort);
        nextPort++;
    }
    return allocations;
}
