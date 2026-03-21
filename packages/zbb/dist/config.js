import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { loadYamlOrDefault } from './yaml.js';
// ── Paths ────────────────────────────────────────────────────────────
const ZBB_DIR = join(homedir(), '.zbb');
export function getZbbDir() {
    return ZBB_DIR;
}
export function getSlotsDir(userConfig) {
    return userConfig?.slots?.dir
        ? resolve(userConfig.slots.dir.replace('~', homedir()))
        : join(ZBB_DIR, 'slots');
}
export function getUserConfigPath() {
    return join(ZBB_DIR, 'config.yaml');
}
/**
 * Walk up from startDir looking for .zbb.yaml (repo root marker).
 * Also checks for gradlew as fallback repo root indicator.
 */
export function findRepoRoot(startDir) {
    let dir = startDir;
    while (true) {
        if (existsSync(join(dir, '.zbb.yaml')))
            return dir;
        if (existsSync(join(dir, 'gradlew')))
            return dir;
        const parent = resolve(dir, '..');
        if (parent === dir)
            return null;
        dir = parent;
    }
}
// ── Loaders ──────────────────────────────────────────────────────────
export async function loadUserConfig() {
    return loadYamlOrDefault(getUserConfigPath(), {});
}
export async function loadRepoConfig(repoRoot) {
    return loadYamlOrDefault(join(repoRoot, '.zbb.yaml'), {});
}
export async function loadProjectConfig(projectDir) {
    return loadYamlOrDefault(join(projectDir, 'zbb.yaml'), {});
}
