export interface ToolRequirement {
    tool: string;
    check: string;
    parse: string;
    version: string;
    install?: string;
}
export interface EnvVarDeclaration {
    type: 'port' | 'string' | 'secret';
    default?: string;
    description?: string;
    mask?: boolean;
    generate?: string;
    source?: 'env' | 'cwd' | 'vault';
    /** Vault KV v2 ref — "mount/path.field" (single field lookup). Requires source: vault. */
    vault?: string;
    /** When true, always re-fetch on `zbb env refresh` / `zbb publish`. Default: false. */
    refresh?: boolean;
    required?: boolean;
    deprecated?: boolean;
    replacedBy?: string;
    message?: string;
}
export interface StackConfig {
    compose?: string | string[];
    services?: string[];
    healthcheck?: Record<string, {
        container: string;
        timeout: number;
    }>;
    exec_hints?: string[];
}
export interface ProjectConfig {
    env?: Record<string, EnvVarDeclaration>;
    require?: ToolRequirement[];
    stack?: StackConfig;
    /** When false, slot creation scans only this project's zbb.yaml — no repo-wide scan. Default: true. */
    inherit?: boolean;
}
export interface MonorepoImageConfig {
    /** Directory containing Dockerfile (relative to repo root) */
    context: string;
    /** Image name on registry */
    name: string;
    /** GitHub workflow file to dispatch for image build */
    workflow?: string;
}
export interface MonorepoConfig {
    /** Enable monorepo mode (required when gradlew coexists with workspaces) */
    enabled: boolean;
    /** npm registry for publish (default: from .npmrc / publishConfig) */
    registry?: string;
    /** Source directories to hash per package (default: ["src"]) */
    sourceDirs?: string[];
    /** Additional source files to hash per package (default: ["tsconfig.json"]) */
    sourceFiles?: string[];
    /** Build phases — npm scripts to run in order (default: ["lint", "generate", "validate", "transpile"]) */
    buildPhases?: string[];
    /** Test phases — npm scripts to run (default: ["test"]) */
    testPhases?: string[];
    /** Workspace dirs to skip during publish (e.g., test packages) */
    skipPublish?: string[];
    /** Packages that produce Docker images, keyed by workspace dir name */
    images?: Record<string, MonorepoImageConfig>;
    /** GitHub repository (owner/repo) for workflow dispatch (default: auto-detected from git remote) */
    githubRepo?: string;
    /** Extra preflight checks required before gate/test (e.g., Vault, DB connectivity) */
    gatePreflight?: ToolRequirement[];
}
export interface RepoConfig {
    env?: Record<string, EnvVarDeclaration>;
    require?: ToolRequirement[];
    ports?: {
        range: [number, number];
    };
    cleanse?: string[];
    monorepo?: MonorepoConfig;
}
export interface UserConfig {
    java?: {
        home: string;
    };
    node?: {
        version: string;
        manager: 'nvm' | 'fnm' | 'volta' | 'system';
    };
    slots?: {
        dir: string;
    };
    prompt?: string;
    skip_checks?: string[];
}
export declare function getZbbDir(): string;
export declare function getSlotsDir(userConfig?: UserConfig): string;
export declare function getUserConfigPath(): string;
/**
 * Walk up from startDir looking for .zbb.yaml (repo root marker).
 * Also checks for gradlew as fallback repo root indicator.
 */
export declare function findRepoRoot(startDir: string): string | null;
export declare function loadUserConfig(): Promise<UserConfig>;
export declare function loadRepoConfig(repoRoot: string): Promise<RepoConfig>;
export declare function loadProjectConfig(projectDir: string): Promise<ProjectConfig>;
