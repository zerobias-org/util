#!/usr/bin/env node

/**
 * zbb — ZeroBias Build
 *
 * Run Gradle tasks from any subdirectory. Automatically detects which
 * Gradle subproject you're in and prefixes task names accordingly.
 *
 * Usage:
 *   zbb compile              # → ./gradlew :project-name:compile
 *   zbb test gate            # → ./gradlew :project-name:test :project-name:gate
 *   zbb -Pfoo=bar compile    # → ./gradlew -Pfoo=bar :project-name:compile
 *   zbb projects             # (from repo root) → ./gradlew projects
 *
 * Cache: .gradle/zbb-projects.json (auto-refreshed when settings.gradle.kts changes)
 */

import { existsSync, readFileSync, writeFileSync, statSync, mkdirSync } from "node:fs";
import { join, resolve, relative, sep } from "node:path";
import { execFileSync, execSync } from "node:child_process";
import { platform } from "node:os";

// ── Environment Setup ────────────────────────────────────────────────

/**
 * Prepare environment for Gradle execution.
 * - Sets JAVA_HOME to Java 21 (works around Java 25 issues with Gradle 8.10.2)
 * - Adds JVM args to suppress native access warnings (no debug output)
 */
function prepareEnv() {
  const env = { ...process.env };

  // Force Java 21 to avoid Gradle 8.10.2 issues with Java 25
  env.JAVA_HOME = "/usr/lib/jvm/java-21-openjdk-amd64";

  // Suppress Java 21 native access warnings (Gradle 9.3.1+)
  // Use GRADLE_OPTS to avoid "Picked up JAVA_TOOL_OPTIONS" message
  const jvmArgs = "--enable-native-access=ALL-UNNAMED";
  env.GRADLE_OPTS = env.GRADLE_OPTS
    ? `${env.GRADLE_OPTS} ${jvmArgs}`
    : jvmArgs;

  // Also set for Gradle daemon JVM
  const daemonArgs = `-Dorg.gradle.jvmargs=${jvmArgs}`;
  env.GRADLE_OPTS = `${env.GRADLE_OPTS} ${daemonArgs}`;

  return env;
}

// ── Helpers ──────────────────────────────────────────────────────────

function die(msg) {
  process.stderr.write(`zbb: ${msg}\n`);
  process.exit(1);
}

/**
 * Walk up from `startDir` looking for the Gradle wrapper script.
 * Returns { root, wrapper } or null.
 */
function findRepoRoot(startDir) {
  const wrapperName = platform() === "win32" ? "gradlew.bat" : "gradlew";
  let dir = startDir;
  while (true) {
    const candidate = join(dir, wrapperName);
    if (existsSync(candidate)) {
      return { root: dir, wrapper: candidate };
    }
    const parent = resolve(dir, "..");
    if (parent === dir) return null; // filesystem root
    dir = parent;
  }
}

/**
 * Find the newest mtime among settings files that affect project structure.
 */
function settingsMtime(root) {
  const candidates = ["settings.gradle.kts", "settings.gradle"];
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

// ── Cache ────────────────────────────────────────────────────────────

const CACHE_FILE = "zbb-projects.json";

/**
 * Load cached project mappings. Returns null if stale or missing.
 */
function loadCache(root) {
  const cacheDir = join(root, ".gradle");
  const cachePath = join(cacheDir, CACHE_FILE);
  if (!existsSync(cachePath)) return null;

  try {
    const data = JSON.parse(readFileSync(cachePath, "utf-8"));
    if (data.settingsMtime === settingsMtime(root)) {
      return data.projects; // { ":project-name": "relative/path", ... }
    }
  } catch {
    // corrupt cache — rebuild
  }
  return null;
}

/**
 * Run `./gradlew -q projectPaths` and cache the result.
 */
function buildCache(root, wrapper) {
  let output;
  try {
    output = execFileSync(wrapper, ["-q", "projectPaths"], {
      cwd: root,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      env: prepareEnv(),
      timeout: 120_000,
    });
  } catch (err) {
    // If the projectPaths task doesn't exist, return empty mapping
    const stderr = err.stderr || "";
    if (stderr.includes("Task 'projectPaths' not found")) {
      return {};
    }
    die(`failed to run '${wrapper} -q projectPaths':\n${stderr}`);
  }

  const projects = {};
  for (const line of output.split("\n")) {
    const eq = line.indexOf("=");
    if (eq > 0) {
      const projectPath = line.substring(0, eq).trim();
      const relDir = line.substring(eq + 1).trim();
      projects[projectPath] = relDir;
    }
  }

  // Write cache
  const cacheDir = join(root, ".gradle");
  if (!existsSync(cacheDir)) mkdirSync(cacheDir, { recursive: true });
  const cachePath = join(cacheDir, CACHE_FILE);
  const cacheData = { settingsMtime: settingsMtime(root), projects };
  writeFileSync(cachePath, JSON.stringify(cacheData, null, 2), "utf-8");

  return projects;
}

// ── Project Detection ────────────────────────────────────────────────

/**
 * Match cwd to a Gradle subproject. Returns the project path (e.g. ":module-foo")
 * or null if cwd is the repo root or not inside any known project.
 */
function detectProject(root, projects) {
  const cwd = process.cwd();
  const rel = relative(root, cwd);

  // At repo root
  if (!rel || rel === ".") return null;

  // Normalize to forward slashes for comparison
  const relNorm = rel.split(sep).join("/");

  // Find the project whose directory is an ancestor of (or equal to) cwd.
  // If multiple match (nested projects), pick the deepest (longest path).
  let bestMatch = null;
  let bestLen = -1;

  for (const [projectPath, projectDir] of Object.entries(projects)) {
    const dirNorm = projectDir.split(sep).join("/");
    if (relNorm === dirNorm || relNorm.startsWith(dirNorm + "/")) {
      if (dirNorm.length > bestLen) {
        bestLen = dirNorm.length;
        bestMatch = projectPath;
      }
    }
  }

  return bestMatch;
}

// ── Argument Processing ──────────────────────────────────────────────

/**
 * Classify each arg: Gradle flags (start with -) pass through unchanged,
 * bare words that look like task names get prefixed with the project path.
 *
 * An arg is treated as a task name if it:
 * - Does NOT start with '-'
 * - Does NOT already contain ':' (already qualified)
 */
function prefixArgs(args, projectPath) {
  return args.map((arg) => {
    if (arg.startsWith("-") || arg.includes(":")) return arg;
    return `${projectPath}:${arg}`;
  });
}

// ── Main ─────────────────────────────────────────────────────────────

function main() {
  const args = process.argv.slice(2);

  // Find repo root first
  const found = findRepoRoot(process.cwd());

  // Handle --help: context-aware help
  if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
    if (!found) {
      // Not in a Gradle project
      console.error(`zbb: requires a Gradle project

Please run zbb from a directory containing build.gradle.kts or gradlew.
To see available tasks in a Gradle project, use: zbb --help`);
      process.exit(1);
    }

    // Inside Gradle project: show tasks
    const { root, wrapper } = found;
    try {
      execFileSync(wrapper, ["-q", "tasks"], {
        cwd: root,
        stdio: "inherit",
        env: prepareEnv(),
        timeout: 120_000,
      });
      process.exit(0);
    } catch (err) {
      process.exit(err.status ?? 1);
    }
  }

  // Ensure we're in a Gradle project for normal operations
  if (!found) {
    die("requires a Gradle project. Run from a directory with build.gradle.kts or gradlew");
  }
  const { root, wrapper } = found;

  // Handle --refresh-cache
  const refreshIdx = args.indexOf("--refresh-cache");
  if (refreshIdx !== -1) {
    args.splice(refreshIdx, 1);
    buildCache(root, wrapper);
    if (args.length === 0) {
      console.log("zbb: cache refreshed");
      process.exit(0);
    }
  }

  // Load or build project mapping
  let projects = loadCache(root);
  if (projects === null) {
    projects = buildCache(root, wrapper);
  }

  // Detect current project
  const projectPath = detectProject(root, projects);

  // Build final args
  const gradleArgs = projectPath ? prefixArgs(args, projectPath) : args;

  // Exec gradlew with prepared environment (Java 21, native access flags)
  try {
    const result = execFileSync(wrapper, gradleArgs, {
      cwd: root,
      stdio: "inherit",
      env: prepareEnv(),
      timeout: 600_000,
    });
    process.exit(0);
  } catch (err) {
    // execFileSync throws on non-zero exit; forward the exit code
    process.exit(err.status ?? 1);
  }
}

main();
