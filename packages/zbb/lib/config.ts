import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { loadYaml, loadYamlOrDefault } from './yaml.js';

// ── Types ────────────────────────────────────────────────────────────

/**
 * Reusable tool check definition stored in the stack manifest's `tools:`
 * block. Lifecycle gates reference entries here by name.
 *
 * Same field shape as ToolRequirement minus the `tool:` key — the map
 * key IS the tool name:
 *
 *   tools:
 *     docker:
 *       check: "docker --version"
 *       parse: "Docker version (\\S+),"
 *       version: ">=24"
 *       install: "https://docs.docker.com/engine/install/"
 */
export interface ToolDefinition {
  check: string;
  parse: string;
  version: string;
  install?: string;
}

export interface ToolRequirement {
  tool: string;
  check: string;
  parse: string;
  version: string;
  install?: string;
  /**
   * Commands this tool is required for. If omitted, applies to all commands.
   *
   * @deprecated — per-command gates have moved to `lifecycle.<cmd>.tools`.
   *   Entries with `commands:` set emit a one-time warning on load but
   *   still parse for back-compat during migration.
   */
  commands?: string[];
}

/**
 * Object form for a lifecycle entry. Shorthand (string-only) is
 * normalized to `{command: <str>}` at load time.
 *
 *   lifecycle:
 *     build:
 *       command: ./gradlew monorepoBuild
 *       tools: [node, docker]        # run preflight on these before spawn
 *       env:   [NPM_TOKEN]            # must resolve non-empty before spawn
 *
 * Gates are resolved against the registry of the stack manifest that
 * defines this entry (the closest named zbb.yaml at or above the
 * lifecycle-owner dir). No walk-up merging.
 */
export interface LifecycleEntry {
  command: string;
  tools?: string[];
  env?: string[];
}

/** Raw (unnormalized) lifecycle value as it appears in YAML. */
export type LifecycleValue = string | LifecycleEntry;

/**
 * Parse a raw lifecycle value into canonical LifecycleEntry form.
 * Returns null if the value isn't a string or a valid object.
 * Non-string `command` values cause null (treat as "not a lifecycle string").
 */
export function normalizeLifecycleEntry(value: unknown): LifecycleEntry | null {
  if (typeof value === 'string') return { command: value };
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const raw = value as { command?: unknown; tools?: unknown; env?: unknown };
    if (typeof raw.command !== 'string') return null;
    const entry: LifecycleEntry = { command: raw.command };
    if (Array.isArray(raw.tools) && raw.tools.every(t => typeof t === 'string')) {
      entry.tools = raw.tools as string[];
    }
    if (Array.isArray(raw.env) && raw.env.every(e => typeof e === 'string')) {
      entry.env = raw.env as string[];
    }
    return entry;
  }
  return null;
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
  require?: RequireEntry[];
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

/**
 * Monorepo orchestration block, consumed by the Gradle plugins
 * (zb.monorepo-base/-build/-gate/-publish via MonorepoGraphService.kt).
 *
 * Phase 3: zbb's TS layer no longer reads this directly — the legacy
 * Builder.ts/Publisher.ts code that consumed enabled/gatePreflight/
 * testDatabase has been deleted. The fields below are still parsed by
 * Gradle. Repos that need test-database provisioning should write a
 * shell wrapper around `./gradlew monorepoGate` and reference it from
 * `lifecycle.gate` instead.
 */
export interface MonorepoConfig {
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
}

/**
 * Raw `require:` list entry as it appears in YAML. Accepts either:
 *   - a name reference (string) — resolved against the stack manifest's
 *     `tools:` registry.
 *   - an inline ToolRequirement — legacy form, still supported during
 *     migration; carries its own `check/parse/version/install` inline.
 *
 * Callers use `resolveRequireEntries()` to flatten a mixed list into
 * ToolRequirement[] before running preflight.
 */
export type RequireEntry = string | ToolRequirement;

export interface RepoConfig {
  env?: Record<string, EnvVarDeclaration>;
  require?: RequireEntry[];
  /**
   * Marks this zbb.yaml as an intentional overlay — a lifecycle / env
   * override layer, never a standalone stack.
   *
   * When true:
   *   - `zbb stack add` refuses this file with a clear error.
   *   - Dispatch walk-up skips this entry when resolving stack context,
   *     even if it has a `name:`. Stack context continues to come from
   *     the nearest added ancestor.
   *
   * Use this on sub-package `zbb.yaml` files that exist solely to
   * define custom lifecycle commands for that path (e.g., a workspace
   * package with its own `build: ./my-special-build.sh`). Without this
   * marker, a zbb.yaml with a `name:` that hasn't been added is still
   * treated as an overlay at runtime, but the marker makes the intent
   * explicit and prevents accidental `zbb stack add`.
   */
  overlay?: boolean;
  /**
   * Named tool definitions referenced by lifecycle gates. Lives on the
   * stack manifest (zbb.yaml with a `name:`); each lifecycle entry's
   * `tools: [name]` list resolves against this registry. See
   * `resolveGateRegistry()` for lookup semantics.
   */
  tools?: Record<string, ToolDefinition>;
  ports?: { range: [number, number] };
  cleanse?: string[];
  monorepo?: MonorepoConfig;
  /**
   * Optional lifecycle delegation. When present, zbb commands like `zbb build`,
   * `zbb gate`, etc. spawn the corresponding lifecycle string instead of
   * running the legacy TS monorepo flow. Mirrors the per-stack `lifecycle:`
   * block in stack `zbb.yaml` files — declarative command delegation,
   * controlled by the repo, not hardcoded in zbb.
   *
   * For monorepo flows: typically points at `./gradlew monorepo*` tasks from
   * the new zb.monorepo-* Gradle plugins.
   */
  lifecycle?: LifecycleConfig;

  /**
   * User-defined scripts invoked via `zbb run <name>`. Separate from
   * `lifecycle:` — lifecycle entries are canonical build/test/publish
   * verbs dispatched by `zbb <verb>` with preflight and the full
   * lifecycle pipeline; scripts are ad-hoc dev utilities (boot a VM,
   * tail a log, seed a DB) that just need slot+stack env preloaded.
   *
   * Each entry is a shell command string. Args passed after the script
   * name on the command line are appended verbatim.
   */
  scripts?: Record<string, string>;
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
  build?: LifecycleValue;
  test?: LifecycleValue;
  gate?: LifecycleValue;
  /** Cheap pre-flight check (e.g., `./gradlew monorepoGateCheck`). Used when
   *  the user runs `zbb gate --check`. Falls back to `gate` if not defined. */
  gateCheck?: LifecycleValue;
  clean?: LifecycleValue;
  publish?: LifecycleValue;
  /** Stack-level start/stop — object form with tools/env gates is honored
   *  the same as build/test/gate. Health/cleanup keep their own shapes. */
  start?: LifecycleValue;
  stop?: LifecycleValue;
  health?: string | HealthCheckConfig;
  seed?: LifecycleValue;
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
  /** Named tool definitions referenced by lifecycle gates. See RepoConfig.tools. */
  tools?: Record<string, ToolDefinition>;
  state?: Record<string, StateFieldSchema>;
  lifecycle?: LifecycleConfig;
  logs?: LogSourceConfig | Record<string, LogSourceConfig>;
  secrets?: Record<string, SecretSchemaConfig>;
  require?: RequireEntry[];
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
 * Walk up from startDir looking for zbb.yaml (the merged single-file
 * config — Phase 3 model). Falls back to gradlew as a repo root
 * indicator for non-zbb repos that still want the smart Gradle wrapper
 * behaviour. Returns null if neither marker is found.
 */
export function findRepoRoot(startDir: string): string | null {
  let dir = startDir;
  while (true) {
    if (existsSync(join(dir, 'zbb.yaml'))) return dir;
    if (existsSync(join(dir, 'gradlew'))) return dir;
    const parent = resolve(dir, '..');
    if (parent === dir) return null;
    dir = parent;
  }
}

// ── Walk-up chain for lifecycle / scope dispatch ─────────────────────
//
// The lifecycle dispatcher needs more than "the nearest zbb.yaml". In
// repos with nested stack manifests (e.g. com/hub/node-stack/zbb.yaml
// inside com/hub/zbb.yaml) the nearest file may not declare the
// requested lifecycle command, may not carry the monorepo: block, and
// may not be the repo root we want to execute from. These helpers build
// the full chain of ancestor zbb.yaml files and let callers pick the
// right one per concern:
//
//   - `findMonorepoRoot` → the chain entry whose zbb.yaml has a
//     top-level `monorepo:` block. This is the aggregator root; there
//     is at most one per chain.
//   - `findLifecycleOwner` → the CLOSEST chain entry whose
//     `lifecycle[command]` is a string. Falls back to the outermost
//     chain entry when nothing defines it — matches the pre-walk-up
//     "./gradlew <cmd>" fallthrough.
//   - `findStackManifestOwner` → the closest chain entry whose YAML
//     declares `name:` (i.e. is a valid stack manifest).
//
// Chain termination: we stop AFTER including the first entry with a
// `monorepo:` block (that's the aggregator root — nothing above it is
// part of this repo's logical tree), at filesystem root, or when
// crossing a `.git` boundary upward (defensive — protects against
// stumbling into a parent dev workspace). We keep walking through
// intermediate zbb.yaml files — they're legitimate sub-manifests we
// want in the chain.

export interface ZbbChainEntry {
  /** Absolute path to the directory containing this entry's zbb.yaml. */
  dir: string;
  /** Parsed YAML (partial shape — only the top-level keys we inspect). */
  config: Partial<RepoConfig & StackManifest>;
  /** True when the parsed YAML has a top-level `monorepo:` key. */
  hasMonorepoBlock: boolean;
}

/**
 * Walk up from startDir collecting every zbb.yaml we encounter. Returns
 * entries closest-first. Stops AFTER the first entry with a `monorepo:`
 * block (that file IS the aggregator root), at the filesystem root, or
 * when crossing a `.git` boundary upward.
 *
 * Lazy-loaded: each zbb.yaml is parsed once per call. Safe to invoke
 * multiple times in a single dispatch — the cost is a handful of small
 * YAML parses along one filesystem path.
 */
export async function findZbbChain(startDir: string): Promise<ZbbChainEntry[]> {
  const chain: ZbbChainEntry[] = [];
  let dir = resolve(startDir);
  let crossedGit = false;

  while (true) {
    const zbbPath = join(dir, 'zbb.yaml');
    if (existsSync(zbbPath)) {
      // loadYamlOrDefault swallows parse errors and returns {} — for the
      // chain we need to know the real shape, so we use loadYaml and
      // catch. A broken sub-manifest shouldn't silently disappear; warn
      // once and keep walking.
      let config: Partial<RepoConfig & StackManifest> = {};
      try {
        const raw = await loadYaml<Partial<RepoConfig & StackManifest>>(zbbPath);
        config = raw ?? {};
      } catch (err) {
        console.warn(
          `[zbb] warning: failed to parse ${zbbPath} — skipping for chain walk-up: ${(err as Error).message}`,
        );
      }
      const hasMonorepoBlock = config.monorepo != null;
      chain.push({ dir, config, hasMonorepoBlock });
      // Stop AFTER including the aggregator root — nothing above it is
      // part of this repo's logical tree.
      if (hasMonorepoBlock) break;
    }

    // Defensive boundary — if we just crossed out of a .git repo into
    // a parent, stop. A parent zbb.yaml in a different git repo is not
    // ours to consult.
    if (existsSync(join(dir, '.git'))) {
      if (crossedGit) break;
      crossedGit = true;
    }

    const parent = resolve(dir, '..');
    if (parent === dir) break;
    dir = parent;
  }

  return chain;
}

/** Return the single chain entry with `monorepo:`, or null. */
export function findMonorepoRoot(chain: ZbbChainEntry[]): ZbbChainEntry | null {
  return chain.find(e => e.hasMonorepoBlock) ?? null;
}

/** Result of resolving which chain entry owns a given lifecycle verb. */
export interface LifecycleOwner {
  entry: ZbbChainEntry;
  /** The raw lifecycle string defined on `entry.config.lifecycle[command]`, or null if the owner is a fallback. */
  lifecycleCmd: string | null;
  /**
   * Named tools the owner's entry gates on — present only when the
   * owner declared the entry in object form with `tools: [...]`.
   * Gate resolution is the caller's responsibility.
   */
  tools?: string[];
  /**
   * Env var names that must resolve to a non-empty value before the
   * command spawns. Present only when the entry is in object form with
   * `env: [...]`.
   */
  env?: string[];
  /** True when `entry` is a fallback (outermost chain entry, no match). */
  isFallback: boolean;
}

/**
 * Pick the chain entry whose `lifecycle[command]` is defined. Closest
 * wins. Falls back to the outermost chain entry (with a null
 * `lifecycleCmd`) to preserve the pre-walk-up "no entry → ./gradlew
 * <cmd>" behaviour.
 *
 * Accepts both shorthand string form (`build: ./gradlew monorepoBuild`)
 * and the object form (`build: {command, tools, env}`) — when in object
 * form, the owner's `tools`/`env` gate lists come along for the caller
 * to resolve.
 *
 * For `gate --check`, looks up `lifecycle.gateCheck`; never picks
 * `lifecycle.gate` as a substitute — gate and gateCheck have different
 * semantics (full run vs. cheap file read).
 */
export function findLifecycleOwner(
  chain: ZbbChainEntry[],
  command: string,
  parsed: { check: boolean },
): LifecycleOwner | null {
  if (chain.length === 0) return null;

  const key = command === 'gate' && parsed.check ? 'gateCheck' : command;

  for (const entry of chain) {
    const lifecycle = entry.config.lifecycle as Record<string, unknown> | undefined;
    const raw = lifecycle?.[key];
    const parsedEntry = normalizeLifecycleEntry(raw);
    if (parsedEntry) {
      return {
        entry,
        lifecycleCmd: parsedEntry.command,
        tools: parsedEntry.tools,
        env: parsedEntry.env,
        isFallback: false,
      };
    }
  }

  // Fallback: outermost entry (the end of the chain — typically the
  // monorepo root when one exists). Caller falls through to
  // `./gradlew <command>` at this dir.
  const fallback = chain[chain.length - 1];
  return { entry: fallback, lifecycleCmd: null, isFallback: true };
}

/** Closest chain entry whose YAML declares `name:` (valid stack manifest). */
export function findStackManifestOwner(chain: ZbbChainEntry[]): ZbbChainEntry | null {
  for (const entry of chain) {
    if (typeof entry.config.name === 'string') return entry;
  }
  return null;
}

/**
 * Resolve the active stack for a given chain — the closest chain entry
 * whose `name:` matches a stack **currently added to the slot**.
 *
 * A zbb.yaml is a "stack" only when it's added to the slot. Everything
 * else in the chain is a lifecycle/env overlay — contributes lifecycle
 * entries but borrows stack context from the nearest added ancestor.
 *
 * Skips:
 *   - Entries with no `name:` (pure overlays — a sub-dir zbb.yaml that
 *     just defines custom lifecycle commands)
 *   - Entries explicitly marked `overlay: true` (author opted out of
 *     being treated as a stack even if a `name:` is present)
 *   - Entries with `name:` but not currently added to the slot (could
 *     be a stack in the future; for now, walk past it)
 *
 * Mirrors the shell cd hook's walk-up: "first zbb.yaml whose stack is
 * actually in the slot." Returns null when no added stack is reachable.
 */
export function findActiveStackInChain(
  chain: ZbbChainEntry[],
  addedStackNames: ReadonlySet<string>,
  addedIdentityNames: ReadonlySet<string>,
): ZbbChainEntry | null {
  for (const entry of chain) {
    const cfg = entry.config as Partial<RepoConfig & StackManifest>;
    if (cfg.overlay === true) continue;
    const name = cfg.name;
    if (typeof name !== 'string') continue;
    const shortName = name.split('/').pop() ?? name;
    if (addedStackNames.has(shortName) || addedIdentityNames.has(name)) {
      return entry;
    }
  }
  return null;
}

/**
 * Resolution result for a `require:` list. Contains the fully-inlined
 * ToolRequirement entries ready to pass to runPreflightChecks, plus a
 * list of unresolved names (references that weren't defined in the
 * `tools:` registry — caller decides whether that's an error).
 */
export interface ResolvedRequire {
  requirements: ToolRequirement[];
  unresolved: string[];
}

/**
 * Flatten a mixed `require:` list into ToolRequirement[]. String
 * entries are name references that get resolved against the provided
 * `tools:` registry. Inline entries pass through unchanged (legacy
 * path — useful during migration when the author hasn't moved
 * everything to the registry).
 *
 * Names that don't appear in the registry are collected in
 * `unresolved` so the caller can decide whether to warn or hard-fail.
 * Inline entries that happen to share a name with a registry entry
 * DON'T cause a conflict — inline always wins.
 */
export function resolveRequireEntries(
  entries: RequireEntry[] | undefined,
  registry: Record<string, ToolDefinition> | undefined,
): ResolvedRequire {
  const requirements: ToolRequirement[] = [];
  const unresolved: string[] = [];
  if (!entries || entries.length === 0) return { requirements, unresolved };

  for (const entry of entries) {
    if (typeof entry === 'string') {
      const def = registry?.[entry];
      if (!def) {
        unresolved.push(entry);
        continue;
      }
      requirements.push({
        tool: entry,
        check: def.check,
        parse: def.parse,
        version: def.version,
        install: def.install,
      });
    } else {
      requirements.push(entry);
    }
  }
  return { requirements, unresolved };
}

/**
 * Extract the gate registry (tools + env declarations) from the active
 * stack entry.
 *
 * A lifecycle entry's `tools: [name]` and `env: [NAME]` gate lists
 * resolve against the active stack's declarations — NOT the closest
 * named zbb.yaml to the lifecycle owner. Overlay sub-dirs don't carry
 * their own `tools:` / `env:` blocks; they borrow the active stack's.
 *
 * Caller passes the active stack entry (as resolved via
 * `findActiveStackInChain`). This function is a simple getter — the
 * walk-up logic lives in the active-stack resolution step, not here.
 */
export function resolveGateRegistry(
  activeStackEntry: ZbbChainEntry,
): {
  manifestDir: string;
  tools: Record<string, ToolDefinition>;
  envDecls: Record<string, EnvVarDeclaration>;
} {
  const cfg = activeStackEntry.config as Partial<RepoConfig & StackManifest>;
  return {
    manifestDir: activeStackEntry.dir,
    tools: cfg.tools ?? {},
    envDecls: cfg.env ?? {},
  };
}


/**
 * Collect every env-var name declared anywhere in the chain — the
 * union of each zbb.yaml's `env:` keys. Used by the gradle-daemon
 * env-drift check (lib/gradleDaemon.ts) so a refresh of any tracked
 * value triggers a daemon restart.
 *
 * Order is insertion order across the chain (cwd-first), but consumers
 * shouldn't rely on order — the result is treated as a set.
 */
export function collectChainEnvKeys(chain: ZbbChainEntry[]): string[] {
  const keys = new Set<string>();
  for (const entry of chain) {
    const cfg = entry.config as Partial<RepoConfig & StackManifest>;
    if (cfg.env) {
      for (const k of Object.keys(cfg.env)) keys.add(k);
    }
  }
  return [...keys];
}


// ── Loaders ──────────────────────────────────────────────────────────

export async function loadUserConfig(): Promise<UserConfig> {
  return loadYamlOrDefault<UserConfig>(getUserConfigPath(), {});
}

export async function loadRepoConfig(repoRoot: string): Promise<RepoConfig> {
  // Phase 3: the merged single-file config lives at repoRoot/zbb.yaml.
  // The same file is also a stack manifest — see loadStackManifest below.
  // Both functions parse different field subsets of the same file.
  return loadYamlOrDefault<RepoConfig>(join(repoRoot, 'zbb.yaml'), {});
}

export async function loadProjectConfig(projectDir: string): Promise<ProjectConfig> {
  return loadYamlOrDefault<ProjectConfig>(join(projectDir, 'zbb.yaml'), {});
}

export function isStackManifest(config: ProjectConfig | StackManifest): config is StackManifest {
  return 'name' in config && typeof (config as StackManifest).name === 'string';
}

export async function loadStackManifest(dir: string): Promise<StackManifest | null> {
  const filePath = join(dir, 'zbb.yaml');
  if (!existsSync(filePath)) return null;
  // Fail fast on invalid YAML (bad syntax, duplicate keys, etc.) rather than
  // silently defaulting to {} and reporting a confusing "missing name" error.
  const config = await loadYaml<Partial<StackManifest> & ProjectConfig>(filePath);
  if (config == null) return null;
  return isStackManifest(config) ? config as StackManifest : null;
}
