import type { EnvVarDeclaration } from '../config.ts';
export interface ScannedVar {
    name: string;
    declaration: EnvVarDeclaration;
    /** Relative path of the project that declared this var */
    source: string;
}
/**
 * Scan repo root and all project zbb.yaml files, collecting env declarations.
 * First declaration wins for defaults/generation. Returns in discovery order.
 */
export declare function scanEnvDeclarations(repoRoot: string): Promise<ScannedVar[]>;
