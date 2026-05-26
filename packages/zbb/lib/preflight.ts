import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import semver from 'semver';
import type { EnvVarDeclaration, ToolDefinition, ToolRequirement } from './config.js';
import { knownJavaHomes } from './java-home.js';

export interface CheckResult {
  tool: string;
  ok: boolean;
  version?: string;
  required: string;
  error?: string;
  install?: string;
}

const JAVA_VERSION_PARSE = /version "(\S+)"/;

/**
 * Multi-path Java version detection.
 * Tries candidates in order, returns first version satisfying the constraint.
 * If none satisfy, returns the first version found (so the error message is useful).
 */
function checkJavaVersion(constraint: string): string | null {
  const candidates: string[] = ['java'];
  if (process.env.JAVA_HOME) {
    candidates.push(`${process.env.JAVA_HOME}/bin/java`);
  }
  for (const home of knownJavaHomes()) {
    const bin = `${home}/bin/java`;
    if (existsSync(bin)) candidates.push(bin);
  }

  let firstFound: string | null = null;
  for (const bin of candidates) {
    try {
      const output = execSync(`${bin} -version 2>&1`, {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 10_000,
      }).trim();
      const match = output.match(JAVA_VERSION_PARSE);
      if (!match?.[1]) continue;
      const version = match[1];
      if (!firstFound) firstFound = version;
      const coerced = semver.coerce(version);
      if (coerced && semver.satisfies(coerced, constraint)) return version;
    } catch { /* try next */ }
  }
  return firstFound;
}

/**
 * Run preflight checks for all tool requirements.
 * Merges repo-level and project-level requirements (deduplicated by tool name).
 */
export function runPreflightChecks(
  requirements: ToolRequirement[],
  skipTools?: string[],
): CheckResult[] {
  const skip = new Set(skipTools ?? []);
  const results: CheckResult[] = [];

  // Deduplicate by tool name (first wins — repo-level takes priority)
  const seen = new Set<string>();
  const unique: ToolRequirement[] = [];
  for (const req of requirements) {
    if (seen.has(req.tool)) continue;
    seen.add(req.tool);
    unique.push(req);
  }

  for (const req of unique) {
    if (skip.has(req.tool)) continue;

    // Special case: check env var existence (no "check" command, tool name is the var)
    if (!req.check) {
      const value = process.env[req.tool];
      results.push({
        tool: req.tool,
        ok: !!value,
        required: 'set',
        error: value ? undefined : `${req.tool} not set in environment`,
        install: req.install,
      });
      continue;
    }

    // Built-in Java detection: try PATH, $JAVA_HOME, and known install paths
    if (req.tool === 'java') {
      const version = checkJavaVersion(req.version);
      if (!version) {
        results.push({
          tool: req.tool,
          ok: false,
          required: req.version,
          error: 'Java not found on PATH, $JAVA_HOME, or known install paths',
          install: req.install,
        });
        continue;
      }
      const coerced = semver.coerce(version);
      const ok = coerced ? semver.satisfies(coerced, req.version) : false;
      results.push({
        tool: req.tool,
        ok,
        version,
        required: req.version,
        error: ok ? undefined : `No Java ${req.version} found (PATH has ${version})`,
        install: req.install,
      });
      continue;
    }

    try {
      const output = execSync(req.check, {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 10_000,
      }).trim();

      // Parse version from output
      const regex = new RegExp(req.parse);
      const match = output.match(regex);

      if (!match || !match[1]) {
        results.push({
          tool: req.tool,
          ok: false,
          required: req.version,
          error: `Could not parse version from: ${output}`,
          install: req.install,
        });
        continue;
      }

      const version = match[1];

      // Validate against semver constraint
      if (req.version === '*') {
        results.push({ tool: req.tool, ok: true, version, required: req.version });
      } else {
        // semver.satisfies needs clean version — try coercing
        const coerced = semver.coerce(version);
        if (!coerced) {
          results.push({
            tool: req.tool,
            ok: false,
            version,
            required: req.version,
            error: `Cannot parse version '${version}' as semver`,
            install: req.install,
          });
          continue;
        }

        const ok = semver.satisfies(coerced, req.version);
        results.push({
          tool: req.tool,
          ok,
          version,
          required: req.version,
          error: ok ? undefined : `Version ${version} does not satisfy ${req.version}`,
          install: req.install,
        });
      }
    } catch (err: any) {
      results.push({
        tool: req.tool,
        ok: false,
        required: req.version,
        error: `Command failed: ${req.check}`,
        install: req.install,
      });
    }
  }

  return results;
}

// ── Per-command gate checks (new object-form lifecycle entries) ─────
//
// Gates are scoped to a single lifecycle command's preflight. They're
// distinct from the stack-level `require:` block:
//   - require: checked once on stack add / slot load, independent of
//     which command runs.
//   - gate:    checked right before the command spawns, after slot env
//     resolution — so env vars sourced from vault or formulas are
//     visible.
//
// Both gate kinds return structured results so the dispatcher can
// decide how to present failures (the UI is the same as require: for
// now — reuse formatPreflightResults).

/** Result of an env-var gate check. */
export interface EnvGateResult {
  name: string;
  ok: boolean;
  /** Set when ok=false: the human-readable reason. */
  error?: string;
}

/**
 * Run tool gate checks for each name in `tools` against the registry
 * from the stack manifest. Missing-from-registry is a hard failure —
 * lifecycle authors can't gate on a tool they haven't defined.
 *
 * Reuses the existing `runPreflightChecks` pipeline by building a
 * ToolRequirement on the fly from the registry entry.
 */
export function checkToolGates(
  tools: string[],
  registry: Record<string, ToolDefinition>,
  skipTools?: string[],
): CheckResult[] {
  const results: CheckResult[] = [];
  const resolvableRequirements: ToolRequirement[] = [];

  for (const name of tools) {
    const def = registry[name];
    if (!def) {
      results.push({
        tool: name,
        ok: false,
        required: '(undefined)',
        error:
          `tool '${name}' is not defined in the stack manifest's tools: block. ` +
          `Add a tools.${name} entry, or remove the gate reference.`,
      });
      continue;
    }
    resolvableRequirements.push({
      tool: name,
      check: def.check,
      parse: def.parse,
      version: def.version,
      install: def.install,
    });
  }

  if (resolvableRequirements.length > 0) {
    results.push(...runPreflightChecks(resolvableRequirements, skipTools));
  }
  return results;
}

/**
 * Run env-var gate checks. Each name must be declared in the manifest's
 * `env:` block AND resolve to a non-empty value via the given lookup
 * function (typically `slot.env.get(name)` or `stack.env.get(name)`).
 *
 * Undeclared names are hard failures — lifecycle authors can't gate on
 * an env var that isn't part of the stack's env schema. Empty-after-
 * resolve is also a hard failure, with a hint when the declaration
 * names a `source:` (env/vault/file) so the user knows what to set.
 */
export function checkEnvGates(
  names: string[],
  envDecls: Record<string, EnvVarDeclaration>,
  lookup: (name: string) => string | undefined,
): EnvGateResult[] {
  const results: EnvGateResult[] = [];
  for (const name of names) {
    const decl = envDecls[name];
    if (!decl) {
      results.push({
        name,
        ok: false,
        error:
          `env '${name}' is not declared in the stack manifest's env: block. ` +
          `Add an env.${name} declaration, or remove the gate reference.`,
      });
      continue;
    }
    const value = lookup(name);
    if (!value || value.length === 0) {
      const hint = decl.source
        ? ` (declared source: ${decl.source})`
        : '';
      results.push({
        name,
        ok: false,
        error: `env '${name}' is empty or unresolved${hint}`,
      });
      continue;
    }
    results.push({ name, ok: true });
  }
  return results;
}

/**
 * Format env gate results for terminal output. Mirrors
 * `formatPreflightResults` so the dispatcher's failure path reads the
 * same regardless of which gate kind failed.
 */
export function formatEnvGateResults(results: EnvGateResult[]): string {
  const lines: string[] = ['Env gate...'];
  const maxName = Math.max(...results.map(r => r.name.length), 4);

  for (const r of results) {
    const name = r.name.padEnd(maxName + 2);
    const status = r.ok ? 'ok' : 'FAIL';
    lines.push(`  ${name} ${status}${r.error ? '   ' + r.error : ''}`);
  }

  return lines.join('\n');
}

/** Format check results for terminal output. */
export function formatPreflightResults(results: CheckResult[]): string {
  const lines: string[] = ['Preflight check...'];
  const maxTool = Math.max(...results.map(r => r.tool.length));
  const maxVer = Math.max(...results.map(r => (r.version ?? '').length), 3);

  for (const r of results) {
    const tool = r.tool.padEnd(maxTool + 2);
    const ver = (r.version ?? '').padEnd(maxVer + 2);
    const status = r.ok ? 'ok' : 'FAIL';
    const constraint = r.ok ? `(${r.required})` : `(need ${r.required})`;
    lines.push(`  ${tool} ${ver} ${status}   ${constraint}`);
    // Surface the specific reason for the failure — otherwise the user
    // can't tell whether the check command crashed, the parse regex
    // didn't match, or the version was semver-rejected. Indented under
    // the row that owns it so the visual grouping reads naturally.
    if (!r.ok && r.error) {
      lines.push(`      ${r.error}`);
    }
  }

  const failed = results.filter(r => !r.ok);
  if (failed.length > 0) {
    lines.push('');
    lines.push('Fix issues above before loading slot.');
    for (const f of failed) {
      if (f.install) {
        lines.push(`  ${f.tool}: ${f.install}`);
      }
    }
  }

  return lines.join('\n');
}
