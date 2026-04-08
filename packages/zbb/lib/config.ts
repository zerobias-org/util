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
  /** Commands this tool is required for. If omitted, applies to all commands. */
  commands?: string[];
}

export interface EnvVarDeclaration {
  type: 'port' | 'string' | 'secret' | 'enum';
  default?: string;
  /** Valid values for enum type — presented as selector in UI */
  values?: string[];
  /** Live formula that recomputes when inputs change (unlike `default` which freezes). */
  value?: string;
  description?: string;
  mask?: boolean;
  /** Hidden from UI env list by default — internal/runtime vars */
  hidden?: boolean;
  generate?: string;
  source?: 'env' | 'cwd' | 'vault' | 'file' | 'expression:jsonata';
  /** Vault KV v2 ref — "mount/path.field" (single field lookup). Requires source: vault. */
  vault?: string;
  /** File path to read value from. Supports ~ for homedir. Requires source: file. Falls back to env var or default. */
  file?: string;
  /** JSONata expression. Env vars are available as $ENV_NAME. Requires source: expression:jsonata. */
  expr?: string;
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
  /** Test database provisioning via Neon branching */
  testDatabase?: {
    /** Database provider (currently only 'neon') */
    provider: 'neon';
    /** Neon parent branch to create ephemeral branches from */
    parentBranch: string;
    /** Workspace dirs whose tests need a database */
    packages: string[];
  };
  /** Extra preflight checks required before gate/test (e.g., Vault, DB connectivity) */
  gatePreflight?: ToolRequirement[];
}

export interface RepoConfig {
  env?: Record<string, EnvVarDeclaration>;
  require?: ToolRequirement[];
  ports?: { range: [number, number] };
  cleanse?: string[];
  monorepo?: MonorepoConfig;
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

export interface StateFieldSchema {
  type: 'string' | 'boolean' | 'enum' | 'url' | 'number';
  values?: string[];
}

export interface CollectionStateConfig {
  collection: true;
  schema: Record<string, StateFieldSchema>;
}

export function isCollectionState(
  state: Record<string, StateFieldSchema> | CollectionStateConfig | undefined,
): state is CollectionStateConfig {
  return state !== undefined && 'collection' in state && (state as CollectionStateConfig).collection === true;
}

export interface SubstackConfig {
  compose?: string;
  services?: string[];
  depends?: string[];
  exports?: string[];
  logs?: LogSourceConfig | Record<string, LogSourceConfig>;
  state?: Record<string, StateFieldSchema> | CollectionStateConfig;
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
  imports?: Record<string, (string | ImportAlias)[] | OptionalImport>;
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

export interface OptionalImport {
  optional: true;
  vars: (string | ImportAlias)[];
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
  const config = await loadYamlOrDefault<Partial<StackManifest> & ProjectConfig>(join(dir, 'zbb.yaml'), {});
  return isStackManifest(config) ? config as StackManifest : null;
}
