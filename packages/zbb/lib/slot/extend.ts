import type { Slot } from './Slot.ts';

export interface ExtendResult {
  extended: boolean;
  addedVars: string[];
}

export async function extendSlot(_slot: Slot, _repoRoot: string): Promise<ExtendResult> {
  // STUB — TDD RED phase: test should fail
  throw new Error('extendSlot not implemented');
}
