/**
 * ZB_ENV — zbb's built-in selector for the ZeroBias environment this machine
 * talks to: `prod`, `uat`, `qa` or `ci` (`dev` is accepted for `ci`, whose
 * hosts are ci.*). It is never declared in a zbb.yaml. `zbb env set ZB_ENV
 * <env>` stores it slot-wide; without that the shell's value applies, and
 * with neither zbb behaves exactly as before.
 *
 * A selected environment supplies:
 *   - the defaults for ZB_PLATFORM_URL, DATALOADER_SERVICE_URL and
 *     PUBLISH_ORG_REGISTRY_URL (a `zbb env set` or hand-picked value wins);
 *   - the npm config every dispatched npm run uses: a generated
 *     `~/.zbb/npm/<env>.npmrc` in place of ~/.npmrc and the global npmrc, plus
 *     the ZeroBias scope registries in npm's env so a repo's own .npmrc can't
 *     send them to another environment's registry.
 *
 * Every environment's Verdaccio serves the same storage and authenticates the
 * token against its own platform, so lockfiles keep prod's host. A non-prod
 * environment rewrites those URLs to its host when npm fetches them
 * (`replace-registry-host`), and zbb rewrites any it records back to the
 * canonical host before it exits.
 *
 * KEEP IN SYNC with build-tools' `com.zerobias.buildtools.util.ZbEnv`, which
 * derives the same URL defaults when Gradle runs without zbb.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { getZbbDir } from '../config.js';

export const ZB_ENV_VAR = 'ZB_ENV';

export type ZbEnvName = 'prod' | 'uat' | 'qa' | 'ci';

/** One selectable environment: its npm registry host and platform origin. */
export interface ZbEnvTarget {
  readonly name: ZbEnvName;
  readonly registryHost: string;
  readonly platformOrigin: string;
}

/** The registry host lockfiles keep: prod's, which every environment's Verdaccio serves the same storage behind. */
export const CANONICAL_REGISTRY_HOST = 'pkg.zerobias.org';

const NPMJS_REGISTRY = 'https://registry.npmjs.org';

/** The npm scopes the ZeroBias registries serve (the scopes the repos' .npmrc files route there). */
export const ZEROBIAS_SCOPES = ['@zerobias-org', '@zerobias-com', '@auditlogic', '@auditmation', '@devsupply'] as const;

const TARGETS: ReadonlyMap<string, ZbEnvTarget> = new Map<string, ZbEnvTarget>([
  ['prod', { name: 'prod', registryHost: CANONICAL_REGISTRY_HOST, platformOrigin: 'https://app.zerobias.com' }],
  ['uat', { name: 'uat', registryHost: 'uat.pkg.zerobias.org', platformOrigin: 'https://uat.zerobias.com' }],
  ['qa', { name: 'qa', registryHost: 'qa.pkg.zerobias.org', platformOrigin: 'https://qa.zerobias.com' }],
  ['ci', { name: 'ci', registryHost: 'ci.pkg.zerobias.org', platformOrigin: 'https://ci.zerobias.com' }],
]);

const ALIASES: ReadonlyMap<string, string> = new Map([['dev', 'ci']]);

/** The env vars a selected environment supplies a default for. */
export const ZB_ENV_DEFAULT_KEYS = ['ZB_PLATFORM_URL', 'DATALOADER_SERVICE_URL', 'PUBLISH_ORG_REGISTRY_URL'] as const;

/** Marks that zbb set the npm config below, so a later run can clear it without touching a user's own npm env. */
const NPMRC_MARKER = 'ZBB_NPMRC';

/** Commands whose npm runs keep the repo's own registries: releases must never go to a non-prod registry. */
const RELEASE_COMMANDS: ReadonlySet<string> = new Set(['publish', 'publishRemote']);

/**
 * The environment `raw` names, or null when it is unset or blank. Case and
 * surrounding whitespace are ignored. Anything unknown throws, so a typo
 * can't quietly fall back to prod.
 */
export function parseZbEnv(raw: string | undefined): ZbEnvTarget | null {
  const value = raw?.trim().toLowerCase();
  if (!value) return null;
  const target = TARGETS.get(ALIASES.get(value) ?? value);
  if (!target) {
    throw new Error(`ZB_ENV must be prod, uat, qa or ci (dev = ci), not '${raw}'`);
  }
  return target;
}

/** `target`'s value for each of {@link ZB_ENV_DEFAULT_KEYS}. */
export function zbEnvDefaults(target: ZbEnvTarget): Record<string, string> {
  return {
    ZB_PLATFORM_URL: `${target.platformOrigin}/api`,
    DATALOADER_SERVICE_URL: `${target.platformOrigin}/api/dataloader`,
    PUBLISH_ORG_REGISTRY_URL: `https://${target.registryHost}`,
  };
}

/** Whether `key` is one of the vars ZB_ENV supplies a default for. */
export function isZbEnvDefaultKey(key: string): boolean {
  return (ZB_ENV_DEFAULT_KEYS as readonly string[]).includes(key);
}

/**
 * Whether `value` is what some environment derives for `key`: a default left
 * over from another environment (a stack's prod default, an earlier run's
 * export) rather than a value somebody picked.
 */
export function isZbEnvDefaultValue(key: string, value: string | undefined): boolean {
  if (!value) return false;
  const normalized = value.trim().replace(/\/+$/, '');
  return [...TARGETS.values()].some(t => zbEnvDefaults(t)[key] === normalized);
}

/**
 * Overlay the selected environment onto an effective env, in place: ZB_ENV
 * becomes the canonical name, and each {@link ZB_ENV_DEFAULT_KEYS} var takes
 * the environment's value unless it is in `overrides` (a `zbb env set`) or
 * holds a value no environment derives (a hand-picked endpoint).
 */
export function overlayZbEnv(
  env: Record<string, string>,
  target: ZbEnvTarget,
  overrides: ReadonlySet<string>,
): void {
  env[ZB_ENV_VAR] = target.name;
  for (const [key, value] of Object.entries(zbEnvDefaults(target))) {
    const current = env[key];
    if (overrides.has(key) || (current && !isZbEnvDefaultValue(key, current))) continue;
    env[key] = value;
  }
}

/**
 * With the local seal off (CI, ZBB_HERMETIC=0, an interactive subshell) an
 * ambient endpoint such as a local dataloader-service survives into the
 * command. This says whether it should also beat the default the effective
 * env derived from ZB_ENV, which it does whenever it is not itself a default.
 */
export function keepsAmbientOverZbEnvDefault(
  key: string,
  effective: Record<string, string>,
  ambient: NodeJS.ProcessEnv,
): boolean {
  if (!effective[ZB_ENV_VAR] || !isZbEnvDefaultKey(key)) return false;
  const current = ambient[key];
  return !!current && !isZbEnvDefaultValue(key, current) && isZbEnvDefaultValue(key, effective[key]);
}

/** Where zbb writes the npm config it points npm at for `target`. */
export function zbEnvNpmrcPath(target: ZbEnvTarget, zbbDir = getZbbDir()): string {
  return join(zbbDir, 'npm', `${target.name}.npmrc`);
}

/** The generated npmrc for `target`. Tokens stay `${VAR}` references, so the file holds no secret. */
export function renderZbEnvNpmrc(target: ZbEnvTarget): string {
  const registry = `https://${target.registryHost}/`;
  const lines = [
    `# Written by zbb for ZB_ENV=${target.name} and rewritten on every run; edits are lost.`,
    '# zbb points npm here in place of ~/.npmrc and also sets the scope registries',
    "# in npm's env, so a repo's own .npmrc can't send them elsewhere.",
  ];
  if (target.registryHost !== CANONICAL_REGISTRY_HOST) {
    lines.push(`registry=${registry}`, `replace-registry-host=${CANONICAL_REGISTRY_HOST}`);
  }
  for (const scope of ZEROBIAS_SCOPES) lines.push(`${scope}:registry=${registry}`);
  lines.push(
    `//${target.registryHost}/:_authToken=\${ZB_TOKEN}`,
    '//npm.pkg.github.com/:_authToken=${NPM_TOKEN}',
  );
  return `${lines.join('\n')}\n`;
}

/**
 * The npm env that makes every npm run use `target`'s registry: the user and
 * global config files replaced by the generated ones, and the registry
 * settings that must beat a repo's .npmrc (project config outranks the user
 * file, env outranks both).
 */
export function zbEnvNpmEnv(target: ZbEnvTarget, npmrcPath: string, globalPath: string): Record<string, string> {
  const registry = `https://${target.registryHost}/`;
  const env: Record<string, string> = {
    NPM_CONFIG_USERCONFIG: npmrcPath,
    NPM_CONFIG_GLOBALCONFIG: globalPath,
    [NPMRC_MARKER]: npmrcPath,
  };
  if (target.registryHost !== CANONICAL_REGISTRY_HOST) {
    env.npm_config_registry = registry;
    env.npm_config_replace_registry_host = CANONICAL_REGISTRY_HOST;
  }
  for (const scope of ZEROBIAS_SCOPES) env[`npm_config_${scope}:registry`] = registry;
  return env;
}

/** Every env var {@link applyZbEnvNpm} may set; the Gradle-daemon drift check watches them with ZB_ENV. */
export function zbEnvWatchedKeys(): string[] {
  const keys = Object.keys(zbEnvNpmEnv(TARGETS.get('ci')!, '', ''));
  return [ZB_ENV_VAR, ...ZB_ENV_DEFAULT_KEYS, ...keys];
}

/** The config key npm reads from an env var name (`npm_config_` prefix, `_` → `-`, lower case), or null. */
function npmConfigKey(envKey: string): string | null {
  if (!/^npm_config_/i.test(envKey)) return null;
  const key = envKey.slice('npm_config_'.length);
  return key.startsWith('//') ? key : key.replace(/(?!^)_/g, '-').toLowerCase();
}

/** Remove every env var npm would read as one of `configKeys`, whatever its spelling. */
function deleteNpmConfig(env: NodeJS.ProcessEnv, configKeys: ReadonlySet<string>): void {
  for (const envKey of Object.keys(env)) {
    const key = npmConfigKey(envKey);
    if (key && configKeys.has(key)) delete env[envKey];
  }
}

/** Clear the npm config an earlier zbb run set (only when its marker is there, so a user's own npm env survives). */
export function clearZbEnvNpm(env: NodeJS.ProcessEnv = process.env): void {
  if (!env[NPMRC_MARKER]) return;
  const configKeys = new Set(
    Object.keys(zbEnvNpmEnv(TARGETS.get('ci')!, '', '')).map(npmConfigKey).filter((k): k is string => !!k),
  );
  deleteNpmConfig(env, configKeys);
  delete env[NPMRC_MARKER];
}

/** Write `content` to `path` unless it already holds exactly that. */
function writeIfChanged(path: string, content: string): void {
  if (existsSync(path) && readFileSync(path, 'utf-8') === content) return;
  writeFileSync(path, content, { mode: 0o644 });
}

let exitHookRepo: string | null = null;

/**
 * Point every npm run this process starts at `target`'s registry: write the
 * generated npmrc and set the npm env on `env`. With no target, or for a
 * release command, it only clears what an earlier run set. For a non-prod
 * target it also restores canonical lockfile hosts in `repoRoot` now (left by
 * a manual install in a slot shell) and again when the process exits.
 */
export function applyZbEnvNpm(
  target: ZbEnvTarget | null,
  options: { command?: string; repoRoot?: string | null; zbbDir?: string; env?: NodeJS.ProcessEnv } = {},
): void {
  const env = options.env ?? process.env;
  clearZbEnvNpm(env);
  if (!target || (options.command && RELEASE_COMMANDS.has(options.command))) return;

  const npmDir = join(options.zbbDir ?? getZbbDir(), 'npm');
  mkdirSync(npmDir, { recursive: true });
  const npmrcPath = join(npmDir, `${target.name}.npmrc`);
  const globalPath = join(npmDir, 'global.npmrc');
  writeIfChanged(npmrcPath, renderZbEnvNpmrc(target));
  writeIfChanged(globalPath, '# Empty on purpose: zbb keeps npm off the machine-wide npmrc.\n');

  const npmEnv = zbEnvNpmEnv(target, npmrcPath, globalPath);
  deleteNpmConfig(env, new Set(Object.keys(npmEnv).map(npmConfigKey).filter((k): k is string => !!k)));
  Object.assign(env, npmEnv);

  if (target.registryHost === CANONICAL_REGISTRY_HOST || !options.repoRoot) return;
  reportNormalized(normalizeRepoLockfiles(options.repoRoot));
  if (exitHookRepo === null) {
    exitHookRepo = options.repoRoot;
    process.once('exit', () => reportNormalized(normalizeRepoLockfiles(exitHookRepo!)));
  }
}

/**
 * For a run with no slot loaded, where there is no seal and the shell env is
 * the command's env: apply the shell's ZB_ENV — its canonical name, the URL
 * defaults wherever the shell holds no hand-picked value, and the npm config.
 */
export function applyZbEnvToShell(options: { command?: string; repoRoot?: string | null } = {}): void {
  const target = parseZbEnv(process.env[ZB_ENV_VAR]);
  if (target) {
    const env: Record<string, string> = {};
    for (const key of ZB_ENV_DEFAULT_KEYS) {
      const value = process.env[key];
      if (value) env[key] = value;
    }
    overlayZbEnv(env, target, new Set());
    Object.assign(process.env, env);
  }
  applyZbEnvNpm(target, options);
}

/** Tell the user (on stderr, synchronously, so it survives process exit) which lockfiles were rewritten. */
function reportNormalized(files: string[]): void {
  if (files.length === 0) return;
  writeSync(2, `zbb: ZB_ENV restored canonical registry hosts in ${files.join(', ')}\n`);
}

const ENV_REGISTRY_HOSTS = [...TARGETS.values()]
  .map(t => t.registryHost)
  .filter(h => h !== CANONICAL_REGISTRY_HOST);

const ENV_RESOLVED_RE = new RegExp(
  `("resolved"\\s*:\\s*")https://(?:${ENV_REGISTRY_HOSTS.map(h => h.replace(/\./g, '\\.')).join('|')})/([^"]*)"`,
  'g',
);

/**
 * Rewrite lockfile `resolved` URLs that point at a non-prod registry host to
 * the host prod would record: pkg.zerobias.org for the ZeroBias scopes, npmjs
 * for everything else (Verdaccio only proxied those). Paths and integrity are
 * identical on every host, so the entry stays valid.
 */
export function normalizeLockfileHosts(content: string): string {
  return content.replace(ENV_RESOLVED_RE, (_match, prefix: string, path: string) => {
    const first = safeDecode(path.split('/')[0] ?? '');
    const scope = first.startsWith('@') ? first.split('/')[0] : null;
    const zerobias = scope !== null && (ZEROBIAS_SCOPES as readonly string[]).includes(scope);
    return `${prefix}${zerobias ? `https://${CANONICAL_REGISTRY_HOST}` : NPMJS_REGISTRY}/${path}"`;
  });
}

/** `decodeURIComponent`, or the input unchanged when it isn't valid percent-encoding. */
function safeDecode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/**
 * Normalize every modified or untracked package-lock.json in the git repo at
 * `repoRoot` ({@link normalizeLockfileHosts}); returns the rewritten paths.
 * Not a git repo, or git missing, means nothing to do.
 */
export function normalizeRepoLockfiles(repoRoot: string): string[] {
  let listing: string;
  try {
    listing = execFileSync(
      'git',
      ['-C', repoRoot, 'ls-files', '-z', '-m', '-o', '--exclude-standard', '--', ':(glob)**/package-lock.json'],
      { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] },
    );
  } catch {
    return [];
  }
  const rewritten: string[] = [];
  for (const rel of new Set(listing.split('\0').filter(Boolean))) {
    const file = join(repoRoot, rel);
    if (!existsSync(file)) continue;
    const content = readFileSync(file, 'utf-8');
    if (!ENV_REGISTRY_HOSTS.some(h => content.includes(h))) continue;
    const normalized = normalizeLockfileHosts(content);
    if (normalized === content) continue;
    writeFileSync(file, normalized);
    rewritten.push(rel);
  }
  return rewritten;
}
