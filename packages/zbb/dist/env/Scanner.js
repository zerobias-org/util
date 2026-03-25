import { existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { loadYamlOrDefault } from '../yaml.js';
/**
 * Scan repo root and all project zbb.yaml files, collecting env declarations.
 * First declaration wins for defaults/generation. Returns in discovery order.
 */
export async function scanEnvDeclarations(repoRoot) {
    const vars = [];
    const seen = new Set();
    // 1. Repo-level .zbb.yaml
    const repoConfig = await loadYamlOrDefault(join(repoRoot, '.zbb.yaml'), {});
    if (repoConfig.env) {
        for (const [name, decl] of Object.entries(repoConfig.env)) {
            if (!seen.has(name)) {
                seen.add(name);
                vars.push({ name, declaration: decl, source: '.zbb.yaml' });
            }
        }
    }
    // 2. Walk for project zbb.yaml files
    const projectFiles = await findProjectConfigs(repoRoot);
    for (const filePath of projectFiles) {
        const config = await loadYamlOrDefault(filePath, {});
        if (!config.env)
            continue;
        const source = relative(repoRoot, filePath);
        for (const [name, decl] of Object.entries(config.env)) {
            if (!seen.has(name)) {
                seen.add(name);
                vars.push({ name, declaration: decl, source });
            }
        }
    }
    return vars;
}
const SKIP_DIRS = new Set([
    'node_modules', '.git', '.gradle', 'build', 'dist', 'out', '.zbb',
]);
async function findProjectConfigs(dir, depth = 0) {
    if (depth > 6)
        return [];
    const results = [];
    const zbbYaml = join(dir, 'zbb.yaml');
    if (existsSync(zbbYaml)) {
        results.push(zbbYaml);
    }
    let entries;
    try {
        entries = await readdir(dir, { withFileTypes: true });
    }
    catch {
        return results;
    }
    for (const entry of entries) {
        if (!entry.isDirectory())
            continue;
        if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.'))
            continue;
        const sub = await findProjectConfigs(join(dir, entry.name), depth + 1);
        results.push(...sub);
    }
    return results;
}
