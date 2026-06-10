/**
 * Effective-environment resolution — the single source of truth shared by
 * `zbb env list/get` (display) and command dispatch (injection). Because
 * both go through {@link resolveEffectiveEnv}, what you see is exactly what
 * a command receives.
 *
 * Hermetic dispatch: a dispatched command's environment is built from
 * scratch as `SYSTEM_BASE ∪ shell_passthrough ∪ effectiveEnv` — nothing
 * else from the operator's shell leaks in. Tokens, registries and
 * endpoints must be DECLARED (a zbb.yaml `env:` entry, slot or stack);
 * they are never inherited ambiently. That is what makes a command's
 * environment identical for everyone and kills the "works on my machine,
 * breaks on theirs" class of failure (a stale stack value, a sourced
 * token, a leftover from another stack).
 */

import { loadRepoConfig } from '../config.js';
import type { Slot } from '../slot/Slot.js';
import type { Stack } from '../stack/Stack.js';

/**
 * OS / runtime machinery that always passes through to a dispatched
 * command. Intentionally minimal and CREDENTIAL-FREE — no tokens, no
 * registries, no endpoints. Anything app-meaningful must be a declared
 * zbb env var or listed in the repo's `shell_passthrough`.
 */
export const SYSTEM_BASE_VARS: ReadonlySet<string> = new Set([
  // identity / paths
  'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'PWD', 'OLDPWD',
  // terminal / locale
  'TERM', 'COLORTERM', 'LANG', 'LANGUAGE', 'TZ',
  // temp
  'TMPDIR', 'TMP', 'TEMP',
  // host / display
  'HOSTNAME', 'DISPLAY',
  // ssh agent (git over ssh)
  'SSH_AUTH_SOCK', 'SSH_AGENT_PID',
  // xdg base dirs
  'XDG_RUNTIME_DIR', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME',
  // WSL interop
  'WSL_DISTRO_NAME', 'WSL_INTEROP', 'WSLENV',
  // toolchain (non-secret) the build needs to launch a JVM / node
  'JAVA_HOME', 'NVM_DIR', 'NVM_BIN', 'NVM_INC',
]);

/** Prefix-matched base families (e.g. every LC_* locale var). */
const SYSTEM_BASE_PREFIXES = ['LC_'] as const;

/**
 * zbb's OWN control/orchestration namespace. Preserved through the
 * hermetic filter so zbb's post-resolve reads (display flags) and its
 * event pipeline keep working — these are flags, never credentials, so
 * passing them through is harmless.
 */
const ZBB_INTERNAL_PREFIXES = ['ZBB_', '_ZBB_'] as const;

/**
 * Per-command env contracts. zbb and build-tools READ these vars internally
 * (System.getenv / process.env, or via subprocesses like `gh`/docker) along a
 * command's code path, but they're not surfaced in any zbb.yaml — so the LOCAL
 * seal would strip them. Each lifecycle command carries its OWN contract: when
 * you dispatch `zbb publish`, publish's vars pass; `zbb gate` only gets the
 * base install/auth creds (it never needs Slack/registry). In CI the seal is
 * off entirely, so these are a no-op there.
 *
 * Deliberately NOT in any contract: the publish-endpoint OVERRIDES
 * (PUBLISH_ORG_*, ZB_PLATFORM_URL, DATALOADER_SERVICE_URL) — they default to
 * prod and stay strippable so a stale shell value can't silently redirect a
 * prod publish (use ZBB_HERMETIC=0 for local-verdaccio testing).
 *
 * KEEP IN SYNC with build-tools' env reads — enforced by EnvContractCoverageTest
 * in packages/build-tools (it fails if a new System.getenv isn't covered here).
 */

// Every lifecycle command needs the install/auth creds (private-dep installs
// from GitHub Packages, vault resolution).
const BASE_CREDS = ['NPM_TOKEN', 'READ_TOKEN', 'GITHUB_TOKEN', 'VAULT_TOKEN'] as const;

// publish / publishRemote: npm publish + docker push + release announce + the
// `gh workflow run` image dispatch. GH_TOKEN holds the privileged dispatch PAT
// (stripping it makes gh fall back to the default GITHUB_TOKEN → 403
// "Resource not accessible by integration"); DISPATCH_TOKEN drives generate-kb.
const PUBLISH_CONTRACT = [
  ...BASE_CREDS,
  'GH_TOKEN', 'DISPATCH_TOKEN', 'ZB_TOKEN',
  'ECR_REGISTRY', 'ECR_REPO_NAME', 'GHCR_REGISTRY', 'DOCKER_BUILD_CONCURRENCY',
  'AWS_REGION', 'SECRET_NAME',
  'SLACK_RELEASES_WEBHOOK', 'SLACK_DEVOPS_NOTIFICATIONS',
  'GITHUB_ACTOR', 'GITHUB_RUN_ID', 'GITHUB_SHA', 'GITHUB_SERVER_URL', 'GITHUB_REPOSITORY', 'CI',
] as const;

const COMMAND_ENV_CONTRACTS: Record<string, readonly string[]> = {
  publish: PUBLISH_CONTRACT,
  publishRemote: PUBLISH_CONTRACT,
  publishOrg: [...BASE_CREDS, 'ZB_TOKEN'],
  // validate/generate/compile/lint/test/build/gate → BASE_CREDS (default below)
};

// Build-verb commands that need only the base creds.
const KNOWN_BUILD_VERBS = new Set([
  'validate', 'generate', 'compile', 'lint', 'test', 'testIntegration',
  'build', 'gate', 'gateCheck', 'clean',
]);

// Union of every contract var — the safe default for unknown/raw commands
// (gradle-wrapper fallback, run/exec) so we never strip a cred they might need.
const ALL_CONTRACT_VARS: ReadonlySet<string> = new Set([
  ...BASE_CREDS,
  ...Object.values(COMMAND_ENV_CONTRACTS).flat(),
]);

/**
 * Build-tools env reads intentionally NOT passed through any contract, listed
 * so EnvContractCoverageTest treats them as "covered" without leaking them:
 * the prod-default OVERRIDES (must stay strippable) and framework vars handled
 * by the effective env / ZBB_ prefix. (PATH/HOME/NVM_DIR are in SYSTEM_BASE.)
 */
export const ENV_CONTRACT_IGNORED: ReadonlySet<string> = new Set([
  'PUBLISH_ORG_NPM_TOKEN', 'PUBLISH_ORG_REGISTRY_URL', 'ZB_PLATFORM_URL', 'DATALOADER_SERVICE_URL',
  'ZB_SLOT', 'ZB_SLOT_DIR', 'ZB_STACK', 'ZBB_MONOREPO_EVENT_FILE',
]);

/**
 * The env vars a given lifecycle command may receive through the LOCAL seal.
 * Known commands get their precise contract; unknown/raw commands get the
 * union of all contracts (broad-safe).
 */
export function commandPassthrough(command?: string): ReadonlySet<string> {
  if (command && COMMAND_ENV_CONTRACTS[command]) return new Set(COMMAND_ENV_CONTRACTS[command]);
  if (command && KNOWN_BUILD_VERBS.has(command)) return new Set(BASE_CREDS);
  return ALL_CONTRACT_VARS;
}

export function isSystemBaseVar(key: string): boolean {
  if (SYSTEM_BASE_VARS.has(key)) return true;
  return SYSTEM_BASE_PREFIXES.some(p => key.startsWith(p));
}

function isZbbInternalVar(key: string): boolean {
  return ZBB_INTERNAL_PREFIXES.some(p => key.startsWith(p));
}

/**
 * The effective env for a context = zbb-MANAGED vars only: slot
 * identity/path vars + the active stack's resolved env (hidden vars
 * included, since a command still needs them even if `env list` tidies
 * them away). Pure composition — callers must have already resolved the
 * slot/stack (e.g. via prepareSlot's `slot.resolve()` + `stack.load()`).
 */
export function resolveEffectiveEnv(slot: Slot, stack: Stack | null): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(slot.env.getAll())) {
    if (v) env[k] = v;
  }
  if (stack) {
    // showHidden=true: `hidden` is a display concern, not an injection one.
    for (const [k, v] of Object.entries(stack.env.getAll(true))) {
      if (v) env[k] = v;
    }
    env.ZB_STACK = stack.name;
  }
  return env;
}

/**
 * The repo's optional `shell_passthrough` allowlist — explicit, committed,
 * identical for everyone. The escape hatch for a var a command genuinely
 * needs forwarded that isn't a zbb-declared env var. Being a declaration
 * (not an ambient leak), it preserves determinism.
 */
export async function loadShellPassthrough(repoRoot: string | null): Promise<ReadonlySet<string>> {
  if (!repoRoot) return new Set();
  try {
    const cfg = await loadRepoConfig(repoRoot);
    return new Set(cfg.shell_passthrough ?? []);
  } catch {
    return new Set();
  }
}

/**
 * Apply the effective env to `process.env` AUTHORITATIVELY so every
 * downstream spawn (which inherits process.env) runs hermetically, without
 * having to touch each spawn site. Any key that is not part of the
 * resolved set, the system base, the zbb-internal namespace, or the
 * `passthrough` allowlist is DELETED — that is the difference from the old
 * additive-only injection and what stops stale/leaked vars from reaching a
 * command.
 *
 * Set `ZBB_HERMETIC=0` to fall back to additive-only (apply effective, keep
 * everything else) as an escape hatch during rollout. Returns the list of
 * stripped keys for optional debug logging.
 */
export function applyEffectiveEnv(
  effectiveEnv: Record<string, string>,
  passthrough: ReadonlySet<string>,
  options?: { hermetic?: boolean },
): string[] {
  // The seal exists for LOCAL determinism — stopping one developer's personal
  // shell vars (stale overrides, personal tokens) from leaking into commands
  // ("works for me, breaks for you"). CI has none of that: its env is the
  // workflow's committed secrets + runner — a single controlled environment,
  // identical every run. So the seal gives NO benefit in CI and only breaks
  // the long tail of vars the toolchain reads via SUBPROCESSES (gh's
  // GH_TOKEN, docker's DOCKER_*, aws's AWS_*, vault's VAULT_*, npm_config_*, …)
  // that no whitelist can fully enumerate. → strip LOCALLY only; in CI the
  // env passes through untouched, exactly as before the seal.
  //
  // hermetic also off for: callers preparing the interactive subshell (slot
  // load passes hermetic:false so the operator keeps KUBECONFIG/AWS_PROFILE/…),
  // and the ZBB_HERMETIC=0 kill-switch.
  const inCI = process.env.CI === 'true' || process.env.CI === '1'
    || process.env.GITHUB_ACTIONS === 'true';
  const hermetic = options?.hermetic !== false
    && process.env.ZBB_HERMETIC !== '0'
    && !inCI;
  const stripped: string[] = [];

  if (hermetic) {
    for (const key of Object.keys(process.env)) {
      if (key in effectiveEnv) continue;
      if (isSystemBaseVar(key) || isZbbInternalVar(key) || passthrough.has(key)) continue;
      delete process.env[key];
      stripped.push(key);
    }
  }

  // Effective env is authoritative — it wins over any same-named ambient
  // value that survived (e.g. a system-base key a stack legitimately
  // redefines).
  for (const [k, v] of Object.entries(effectiveEnv)) {
    process.env[k] = v;
  }

  return stripped;
}
