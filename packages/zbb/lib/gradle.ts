/**
 * Gradle wrapper logic — extracted from original bin/zbb.mjs
 *
 * Detects Gradle subproject from cwd, prefixes task names, manages cache.
 */

import { existsSync, readFileSync, writeFileSync, statSync, mkdirSync, readdirSync } from 'node:fs';
import type { Dirent } from 'node:fs';
import { join, resolve, relative, sep } from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { platform } from 'node:os';
import { findDefaultJavaHome } from './java-home.js';

// ── Environment Setup ────────────────────────────────────────────────

export function prepareGradleEnv(): Record<string, string> {
  const env: Record<string, string> = { ...process.env as Record<string, string> };

  // Force Java 21 to avoid Gradle 8.10.2 issues with Java 25. Resolution
  // walks platform-appropriate candidate paths; null means no Java 21
  // found locally and we leave JAVA_HOME unset for downstream tools to
  // diagnose.
  if (!env.JAVA_HOME) {
    const found = findDefaultJavaHome();
    if (found) env.JAVA_HOME = found;
  }

  // Suppress Java 21 native access warnings
  const jvmArgs = '--enable-native-access=ALL-UNNAMED';
  env.GRADLE_OPTS = env.GRADLE_OPTS
    ? `${env.GRADLE_OPTS} ${jvmArgs}`
    : jvmArgs;

  const daemonArgs = `-Dorg.gradle.jvmargs=${jvmArgs}`;
  env.GRADLE_OPTS = `${env.GRADLE_OPTS} ${daemonArgs}`;

  return env;
}

// ── Repo Root ────────────────────────────────────────────────────────

export interface GradleRepo {
  root: string;
  wrapper: string;
}

export function findGradleRoot(startDir: string): GradleRepo | null {
  const wrapperName = platform() === 'win32' ? 'gradlew.bat' : 'gradlew';
  let dir = startDir;
  while (true) {
    const candidate = join(dir, wrapperName);
    if (existsSync(candidate)) {
      return { root: dir, wrapper: candidate };
    }
    const parent = resolve(dir, '..');
    if (parent === dir) return null;
    dir = parent;
  }
}

// ── Cache ────────────────────────────────────────────────────────────

const CACHE_FILE = 'zbb-projects.json';

// Directories that never hold first-class gradle subprojects and are
// expensive (or self-referential) to walk while fingerprinting the repo.
const PRUNE_DIRS = new Set([
  'node_modules', '.git', '.gradle', 'build', 'dist', 'out', '.idea', '.vscode',
]);

function settingsMtime(root: string): number {
  const candidates = ['settings.gradle.kts', 'settings.gradle'];
  let newest = 0;
  for (const name of candidates) {
    const p = join(root, name);
    if (existsSync(p)) {
      const t = statSync(p).mtimeMs;
      if (t > newest) newest = t;
    }
  }
  return newest;
}

/**
 * Sorted, root-relative paths of every build.gradle.kts / build.gradle in
 * the repo (pruning node_modules/.git/.gradle/build/…). This is the set the
 * settings.gradle.kts `walkTopDown` auto-discovery turns into subprojects,
 * so it — not settings.gradle.kts's mtime — is what determines the project
 * map. Adding a module never touches settings.gradle.kts, so an mtime-only
 * cache key goes stale silently; fingerprinting the build-file set catches
 * adds/removes that dynamic discovery would pick up.
 */
function buildFileFingerprint(root: string): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // unreadable dir — skip rather than abort the whole scan
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (PRUNE_DIRS.has(e.name)) continue;
        walk(join(dir, e.name));
      } else if (e.name === 'build.gradle.kts' || e.name === 'build.gradle') {
        found.push(relative(root, join(dir, e.name)).split(sep).join('/'));
      }
    }
  };
  walk(root);
  found.sort();
  return found;
}

function fingerprintsEqual(a: string[] | undefined, b: string[]): boolean {
  if (!a || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

export function loadProjectCache(root: string): Record<string, string> | null {
  const cachePath = join(root, '.gradle', CACHE_FILE);
  if (!existsSync(cachePath)) return null;

  try {
    const data = JSON.parse(readFileSync(cachePath, 'utf-8'));
    // Valid only when BOTH the settings file is unchanged AND the discovered
    // build-file set matches. The latter is what catches modules added since
    // the cache was written (dynamic `walkTopDown` discovery). Caches written
    // by older zbb lack `buildFiles` → fingerprintsEqual returns false →
    // forced rebuild, which is the safe outcome.
    if (
      data.settingsMtime === settingsMtime(root) &&
      fingerprintsEqual(data.buildFiles, buildFileFingerprint(root))
    ) {
      return data.projects;
    }
  } catch {
    // corrupt cache
  }
  return null;
}

export function buildProjectCache(root: string, wrapper: string): Record<string, string> {
  let output: string;
  try {
    output = execFileSync(wrapper, ['-q', 'projectPaths'], {
      cwd: root,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      env: prepareGradleEnv(),
      timeout: 120_000,
    });
  } catch (err: any) {
    const stderr = err.stderr || '';
    if (stderr.includes("Task 'projectPaths' not found")) {
      return {};
    }
    throw new Error(`Failed to run '${wrapper} -q projectPaths':\n${stderr}`);
  }

  const projects: Record<string, string> = {};
  for (const line of output.split('\n')) {
    const eq = line.indexOf('=');
    if (eq > 0) {
      projects[line.substring(0, eq).trim()] = line.substring(eq + 1).trim();
    }
  }

  const cacheDir = join(root, '.gradle');
  if (!existsSync(cacheDir)) mkdirSync(cacheDir, { recursive: true });
  writeFileSync(
    join(cacheDir, CACHE_FILE),
    JSON.stringify(
      { settingsMtime: settingsMtime(root), buildFiles: buildFileFingerprint(root), projects },
      null,
      2,
    ),
    'utf-8',
  );

  return projects;
}

// ── Project Detection ────────────────────────────────────────────────

export function detectProject(root: string, projects: Record<string, string>): string | null {
  const cwd = process.cwd();
  const rel = relative(root, cwd);
  if (!rel || rel === '.') return null;

  const relNorm = rel.split(sep).join('/');
  let bestMatch: string | null = null;
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

export function prefixArgs(args: string[], projectPath: string): string[] {
  return args.map(arg => {
    if (arg.startsWith('-') || arg.includes(':')) return arg;
    return `${projectPath}:${arg}`;
  });
}

// ── Deprecated Stack Aliases ─────────────────────────────────────────

const DEPRECATED_ALIASES: Record<string, string> = {
  up: 'zbb stack start',
  down: 'zbb stack stop',
  destroy: 'zbb reset',
  info: 'zbb stack info',
};

/**
 * Check if a command is a deprecated stack alias.
 * Returns the suggested replacement, or null if not a deprecated alias.
 */
export function checkDeprecatedAlias(command: string): string | null {
  return DEPRECATED_ALIASES[command] ?? null;
}

// ── Execute ──────────────────────────────────────────────────────────

export function runGradle(args: string[]): void {
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

  // Spawn gradle in its OWN process group (detached: true) so that we
  // can forward Ctrl+C to the whole tree — gradlew → java daemon → npm
  // child processes → etc. Without this, execFileSync blocks the event
  // loop (no chance to install a SIGINT handler), and pressing Ctrl+C
  // leaves orphaned npm / java children running in the background.
  //
  // On Ctrl+C we:
  //   1. kill(-child.pid, SIGINT)  — sends SIGINT to the whole group
  //   2. run `./gradlew --stop` — kills any still-alive gradle daemon
  //      that ducked out of the process group (the daemon intentionally
  //      detaches itself on startup for reuse across invocations).
  const child = spawn(wrapper, gradleArgs, {
    cwd: root,
    stdio: 'inherit',
    env: prepareGradleEnv(),
    detached: true,
  });

  let signalForwarded = false;
  const forwardSignal = (sig: NodeJS.Signals) => {
    if (signalForwarded) {
      // User hit Ctrl+C twice — hard-kill the group and exit now.
      try { if (child.pid) process.kill(-child.pid, 'SIGKILL'); } catch {}
      process.exit(130);
    }
    signalForwarded = true;
    try {
      if (child.pid) process.kill(-child.pid, sig);
    } catch {}
    // Best-effort: ask the gradle daemon to stop so orphaned java
    // daemons don't keep building after gradlew exits. Run async,
    // don't block the signal handler.
    try {
      spawn(wrapper, ['--stop'], {
        cwd: root,
        stdio: 'ignore',
        env: prepareGradleEnv(),
        detached: true,
      }).unref();
    } catch {}
  };
  process.on('SIGINT', () => forwardSignal('SIGINT'));
  process.on('SIGTERM', () => forwardSignal('SIGTERM'));

  child.on('exit', (code, signal) => {
    if (signal) {
      // Node exit codes for signals: 128 + signal number.
      process.exit(128 + (signal === 'SIGINT' ? 2 : signal === 'SIGTERM' ? 15 : 1));
    }
    process.exit(code ?? 1);
  });
  child.on('error', (err) => {
    process.stderr.write(`zbb: failed to launch gradle: ${err.message}\n`);
    process.exit(1);
  });
}
