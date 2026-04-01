import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import semver from 'semver';
const JAVA_VERSION_PARSE = /version "(\S+)"/;
const KNOWN_JAVA_PATHS = [
    '/usr/lib/jvm/java-21-openjdk-amd64/bin/java',
    '/usr/lib/jvm/java-21-openjdk/bin/java',
    '/usr/lib/jvm/java-21/bin/java',
];
/**
 * Multi-path Java version detection.
 * Tries candidates in order, returns first version satisfying the constraint.
 * If none satisfy, returns the first version found (so the error message is useful).
 */
function checkJavaVersion(constraint) {
    const candidates = ['java'];
    if (process.env.JAVA_HOME) {
        candidates.push(`${process.env.JAVA_HOME}/bin/java`);
    }
    for (const p of KNOWN_JAVA_PATHS) {
        if (existsSync(p))
            candidates.push(p);
    }
    let firstFound = null;
    for (const bin of candidates) {
        try {
            const output = execSync(`${bin} -version 2>&1`, {
                encoding: 'utf-8',
                stdio: ['pipe', 'pipe', 'pipe'],
                timeout: 10_000,
            }).trim();
            const match = output.match(JAVA_VERSION_PARSE);
            if (!match?.[1])
                continue;
            const version = match[1];
            if (!firstFound)
                firstFound = version;
            const coerced = semver.coerce(version);
            if (coerced && semver.satisfies(coerced, constraint))
                return version;
        }
        catch { /* try next */ }
    }
    return firstFound;
}
/**
 * Run preflight checks for all tool requirements.
 * Merges repo-level and project-level requirements (deduplicated by tool name).
 */
export function runPreflightChecks(requirements, skipTools) {
    const skip = new Set(skipTools ?? []);
    const results = [];
    // Deduplicate by tool name (first wins — repo-level takes priority)
    const seen = new Set();
    const unique = [];
    for (const req of requirements) {
        if (seen.has(req.tool))
            continue;
        seen.add(req.tool);
        unique.push(req);
    }
    for (const req of unique) {
        if (skip.has(req.tool))
            continue;
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
            }
            else {
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
        }
        catch (err) {
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
export function formatPreflightResults(results) {
    const lines = ['Preflight check...'];
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
