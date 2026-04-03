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
  /** Live formula that recomputes when inputs change (unlike `default` which freezes). */
  value?: string;
  description?: string;
  mask?: boolean;
  generate?: string;
  source?: 'env' | 'cwd' | 'vault' | 'file';
  /** Vault KV v2 ref — "mount/path.field" (single field lookup). Requires source: vault. */
  vault?: string;
  /** File path to read value from. Supports ~ for homedir. Requires source: file. Falls back to env var or default. */
  file?: string;
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
  healthcheck?: Record<string, { container: string; timeout: number }>;
  exec_hints?: string[];
}

export interface ProjectConfig {
  env?: Record<string, EnvVarDeclaration>;
  require?: ToolRequirement[];
  stack?: StackConfig;
  /** When false, slot creation scans only this project's zbb.yaml — no repo-wide scan. Default: true. */
  inherit?: boolean;
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

// ── Stack Manifest Types ────────────────────────────────────────────

export interface DependencySpec {
  package: string;
  ready_when?: Record<string, unknown>;
}

export interface SubstackConfig {
  compose?: string;
  services?: string[];
  depends?: string[];
  exports?: string[];
  logs?: LogSourceConfig | Record<string, LogSourceConfig>;
}

export interface StateFieldSchema {
  type: 'string' | 'boolean' | 'enum' | 'url' | 'number';
  values?: string[];
}

export interface LifecycleConfig {
  build?: string;
  test?: string;
  gate?: string;
  start?: string;
  stop?: string;
  health?: string | HealthCheckConfig;
  seed?: string;
  cleanup?: string | string[];
}

export interface HealthCheckConfig {
  command: string;
  interval?: number;
  timeout?: number;
}

export interface LogSourceConfig {
  source: 'docker' | 'file' | 'aws';
  container?: string;
  path?: string;
  log_group?: string;
}

export interface SecretSchemaConfig {
  schema?: string;
  discovery?: 'auto' | 'manual';
}

export interface StackManifest {
  name: string;
  version: string;
  depends?: Record<string, string | DependencySpec>;
  exports?: string[];
  imports?: Record<string, (string | ImportAlias)[]>;
  substacks?: Record<string, SubstackConfig>;
  env?: Record<string, EnvVarDeclaration>;
  state?: Record<string, StateFieldSchema>;
  lifecycle?: LifecycleConfig;
  logs?: LogSourceConfig | Record<string, LogSourceConfig>;
  secrets?: Record<string, SecretSchemaConfig>;
  require?: ToolRequirement[];
}

export interface ImportAlias {
  from: string;
  as: string;
}

export interface StackIdentity {
  name: string;
  version: string;
  mode: 'dev' | 'packaged';
  source: string;
  added: string;
  alias?: string;
}

// ── Paths ────────────────────────────────────────────────────────────

const ZBB_DIR = join(homedir(), '.zbb');

export function getZbbDir(): string {
  return ZBB_DIR;
}

export function getSlotsDir(userConfig?: UserConfig): string {
  // ZB_SLOT_DIR is the canonical slot path — derive slots dir from it
  if (process.env.ZB_SLOT_DIR) {
    return resolve(process.env.ZB_SLOT_DIR, '..');
  }
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

export function isStackManifest(config: ProjectConfig | StackManifest): config is StackManifest {
  return 'name' in config && typeof (config as StackManifest).name === 'string';
}

export async function loadStackManifest(dir: string): Promise<StackManifest | null> {
  const config = await loadYamlOrDefault<ProjectConfig & StackManifest>(join(dir, 'zbb.yaml'), {} as any);
  return isStackManifest(config) ? config : null;
}
