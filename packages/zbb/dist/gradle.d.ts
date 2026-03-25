/**
 * Gradle wrapper logic — extracted from original bin/zbb.mjs
 *
 * Detects Gradle subproject from cwd, prefixes task names, manages cache.
 */
export declare function prepareGradleEnv(): Record<string, string>;
export interface GradleRepo {
    root: string;
    wrapper: string;
}
export declare function findGradleRoot(startDir: string): GradleRepo | null;
export declare function loadProjectCache(root: string): Record<string, string> | null;
export declare function buildProjectCache(root: string, wrapper: string): Record<string, string>;
export declare function detectProject(root: string, projects: Record<string, string>): string | null;
export declare function prefixArgs(args: string[], projectPath: string): string[];
export declare function resolveStackAlias(command: string): string | null;
export declare function runGradle(args: string[]): void;
