import type { ToolRequirement } from './config.js';
export interface CheckResult {
    tool: string;
    ok: boolean;
    version?: string;
    required: string;
    error?: string;
    install?: string;
}
/**
 * Run preflight checks for all tool requirements.
 * Merges repo-level and project-level requirements (deduplicated by tool name).
 */
export declare function runPreflightChecks(requirements: ToolRequirement[], skipTools?: string[]): CheckResult[];
/** Format check results for terminal output. */
export declare function formatPreflightResults(results: CheckResult[]): string;
