import { execSync } from 'node:child_process';
import semver from 'semver';
import type { ToolRequirement } from './config.js';

export interface CheckResult {
  tool: string;
  ok: boolean;
  version?: string;
  required: string;
  error?: string;
  install?: string;
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
