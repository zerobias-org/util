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
  // hermetic stripping is the default for COMMAND dispatch; callers that
  // prepare the interactive subshell (slot load) pass hermetic:false so the
  // operator keeps their personal env (KUBECONFIG, AWS_PROFILE, …). The
  // ZBB_HERMETIC=0 env kill-switch disables it everywhere.
  const hermetic = options?.hermetic !== false && process.env.ZBB_HERMETIC !== '0';
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
