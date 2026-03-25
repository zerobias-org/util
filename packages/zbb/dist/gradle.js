/**
 * Gradle wrapper logic — extracted from original bin/zbb.mjs
 *
 * Detects Gradle subproject from cwd, prefixes task names, manages cache.
 */
import { existsSync, readFileSync, writeFileSync, statSync, mkdirSync } from 'node:fs';
import { join, resolve, relative, sep } from 'node:path';
import { execFileSync } from 'node:child_process';
import { platform } from 'node:os';
// ── Environment Setup ────────────────────────────────────────────────
export function prepareGradleEnv() {
    const env = { ...process.env };
    // Force Java 21 to avoid Gradle 8.10.2 issues with Java 25
    env.JAVA_HOME = env.JAVA_HOME || '/usr/lib/jvm/java-21-openjdk-amd64';
    // Suppress Java 21 native access warnings
    const jvmArgs = '--enable-native-access=ALL-UNNAMED';
    env.GRADLE_OPTS = env.GRADLE_OPTS
        ? `${env.GRADLE_OPTS} ${jvmArgs}`
        : jvmArgs;
    const daemonArgs = `-Dorg.gradle.jvmargs=${jvmArgs}`;
    env.GRADLE_OPTS = `${env.GRADLE_OPTS} ${daemonArgs}`;
    return env;
}
export function findGradleRoot(startDir) {
    const wrapperName = platform() === 'win32' ? 'gradlew.bat' : 'gradlew';
    let dir = startDir;
    while (true) {
        const candidate = join(dir, wrapperName);
        if (existsSync(candidate)) {
            return { root: dir, wrapper: candidate };
        }
        const parent = resolve(dir, '..');
        if (parent === dir)
            return null;
        dir = parent;
    }
}
// ── Cache ────────────────────────────────────────────────────────────
const CACHE_FILE = 'zbb-projects.json';
function settingsMtime(root) {
    const candidates = ['settings.gradle.kts', 'settings.gradle'];
    let newest = 0;
    for (const name of candidates) {
        const p = join(root, name);
        if (existsSync(p)) {
            const t = statSync(p).mtimeMs;
            if (t > newest)
                newest = t;
        }
    }
    return newest;
}
export function loadProjectCache(root) {
    const cachePath = join(root, '.gradle', CACHE_FILE);
    if (!existsSync(cachePath))
        return null;
    try {
        const data = JSON.parse(readFileSync(cachePath, 'utf-8'));
        if (data.settingsMtime === settingsMtime(root)) {
            return data.projects;
        }
    }
    catch {
        // corrupt cache
    }
    return null;
}
export function buildProjectCache(root, wrapper) {
    let output;
    try {
        output = execFileSync(wrapper, ['-q', 'projectPaths'], {
            cwd: root,
            encoding: 'utf-8',
            stdio: ['pipe', 'pipe', 'pipe'],
            env: prepareGradleEnv(),
            timeout: 120_000,
        });
    }
    catch (err) {
        const stderr = err.stderr || '';
        if (stderr.includes("Task 'projectPaths' not found")) {
            return {};
        }
        throw new Error(`Failed to run '${wrapper} -q projectPaths':\n${stderr}`);
    }
    const projects = {};
    for (const line of output.split('\n')) {
        const eq = line.indexOf('=');
        if (eq > 0) {
            projects[line.substring(0, eq).trim()] = line.substring(eq + 1).trim();
        }
    }
    const cacheDir = join(root, '.gradle');
    if (!existsSync(cacheDir))
        mkdirSync(cacheDir, { recursive: true });
    writeFileSync(join(cacheDir, CACHE_FILE), JSON.stringify({ settingsMtime: settingsMtime(root), projects }, null, 2), 'utf-8');
    return projects;
}
// ── Project Detection ────────────────────────────────────────────────
export function detectProject(root, projects) {
    const cwd = process.cwd();
    const rel = relative(root, cwd);
    if (!rel || rel === '.')
        return null;
    const relNorm = rel.split(sep).join('/');
    let bestMatch = null;
    let bestLen = -1;
    for (const [projectPath, projectDir] of Object.entries(projects)) {
        const dirNorm = projectDir.split(sep).join('/');
        if (relNorm === dirNorm || relNorm.startsWith(dirNorm + '/')) {
            if (dirNorm.length > bestLen) {
                bestLen = dirNorm.length;
                bestMatch = projectPath;
            }
        }
    }
    return bestMatch;
}
export function prefixArgs(args, projectPath) {
    return args.map(arg => {
        if (arg.startsWith('-') || arg.includes(':'))
            return arg;
        return `${projectPath}:${arg}`;
    });
}
// ── Stack Aliases ────────────────────────────────────────────────────
const STACK_ALIASES = {
    up: 'stackUp',
    down: 'stackDown',
    destroy: 'stackDestroy',
    info: 'stackInfo',
};
export function resolveStackAlias(command) {
    return STACK_ALIASES[command] ?? null;
}
// ── Execute ──────────────────────────────────────────────────────────
export function runGradle(args) {
    const found = findGradleRoot(process.cwd());
    if (!found) {
        process.stderr.write('zbb: requires a Gradle project. Run from a directory with gradlew\n');
        process.exit(1);
    }
    const { root, wrapper } = found;
    // Handle --refresh-cache
    const refreshIdx = args.indexOf('--refresh-cache');
    if (refreshIdx !== -1) {
        args.splice(refreshIdx, 1);
        buildProjectCache(root, wrapper);
        if (args.length === 0) {
            console.log('zbb: cache refreshed');
            process.exit(0);
        }
    }
    let projects = loadProjectCache(root);
    if (projects === null) {
        projects = buildProjectCache(root, wrapper);
    }
    const projectPath = detectProject(root, projects);
    const gradleArgs = projectPath ? prefixArgs(args, projectPath) : args;
    try {
        execFileSync(wrapper, gradleArgs, {
            cwd: root,
            stdio: 'inherit',
            env: prepareGradleEnv(),
            timeout: 600_000,
        });
        process.exit(0);
    }
    catch (err) {
        process.exit(err.status ?? 1);
    }
}
