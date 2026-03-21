import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { loadYamlOrDefault } from './yaml.js';

// ── Types ────────────────────────────────────────────────────────────

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
  healthcheck?: Record<string, { container: string; timeout: number }>;
}

export interface ProjectConfig {
  env?: Record<string, EnvVarDeclaration>;
  require?: ToolRequirement[];
  stack?: StackConfig;
}

export interface RepoConfig {
  env?: Record<string, EnvVarDeclaration>;
  require?: ToolRequirement[];
  ports?: { range: [number, number] };
  cleanse?: string[];
}

export interface UserConfig {
  java?: { home: string };
  node?: { version: string; manager: 'nvm' | 'fnm' | 'volta' | 'system' };
  slots?: { dir: string };
  prompt?: string;
  skip_checks?: string[];
}

// ── Paths ────────────────────────────────────────────────────────────

const ZBB_DIR = join(homedir(), '.zbb');

export function getZbbDir(): string {
  return ZBB_DIR;
}

export function getSlotsDir(userConfig?: UserConfig): string {
  return userConfig?.slots?.dir
    ? resolve(userConfig.slots.dir.replace('~', homedir()))
    : join(ZBB_DIR, 'slots');
}

export function getUserConfigPath(): string {
  return join(ZBB_DIR, 'config.yaml');
}

/**
 * Walk up from startDir looking for .zbb.yaml (repo root marker).
 * Also checks for gradlew as fallback repo root indicator.
 */
export function findRepoRoot(startDir: string): string | null {
  let dir = startDir;
  while (true) {
    if (existsSync(join(dir, '.zbb.yaml'))) return dir;
    if (existsSync(join(dir, 'gradlew'))) return dir;
    const parent = resolve(dir, '..');
    if (parent === dir) return null;
    dir = parent;
  }
}

// ── Loaders ──────────────────────────────────────────────────────────

export async function loadUserConfig(): Promise<UserConfig> {
  return loadYamlOrDefault<UserConfig>(getUserConfigPath(), {});
}

export async function loadRepoConfig(repoRoot: string): Promise<RepoConfig> {
  return loadYamlOrDefault<RepoConfig>(join(repoRoot, '.zbb.yaml'), {});
}

export async function loadProjectConfig(projectDir: string): Promise<ProjectConfig> {
  return loadYamlOrDefault<ProjectConfig>(join(projectDir, 'zbb.yaml'), {});
}
