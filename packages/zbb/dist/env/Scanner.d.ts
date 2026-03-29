import type { EnvVarDeclaration } from '../config.js';
export interface ScannedVar {
    name: string;
    declaration: EnvVarDeclaration;
    /** Relative path of the project that declared this var */
    source: string;
}
/**
 * Scan repo root and all project zbb.yaml files, collecting env declarations.
 * First declaration wins for defaults/generation. Returns in discovery order.
 *
 * When projectOnly is set, scans only that single zbb.yaml (for inherit: false projects).
 */
export declare function scanEnvDeclarations(repoRoot: string, projectOnly?: string): Promise<ScannedVar[]>;
