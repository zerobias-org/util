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
    source?: 'env';
    required?: boolean;
    deprecated?: boolean;
    replacedBy?: string;
    message?: string;
}
export interface StackConfig {
    compose?: string;
    services?: string[];
    healthcheck?: Record<string, {
        container: string;
        timeout: number;
    }>;
}
export interface ProjectConfig {
    env?: Record<string, EnvVarDeclaration>;
    require?: ToolRequirement[];
    stack?: StackConfig;
}
export interface RepoConfig {
    env?: Record<string, EnvVarDeclaration>;
    require?: ToolRequirement[];
    ports?: {
        range: [number, number];
    };
    cleanse?: string[];
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
