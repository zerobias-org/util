/**
 * zbb secret — slot-scoped secret management
 *
 * Secrets are YAML files at ${ZB_SLOT_STATE}/secrets/<name>.yml
 * Each file is a complete connection profile with optional metadata.
 * Values can contain refs ({{env.VAR}}) resolved at read time by `get`.
 *
 * Commands: create, get, list, update, delete
 */
import type { Slot } from './slot/Slot.js';
/**
 * Handle `zbb secret` subcommands
 */
export declare function handleSecret(args: string[], slot: Slot): Promise<void>;
