/**
 * Build orchestration for monorepo workspaces.
 * Runs npm scripts across packages in dependency order.
 */

import { execFileSync, spawn } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync, renameSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { type MonorepoConfig, getZbbDir } from '../config.js';
import type { DependencyGraph, WorkspacePackage } from './Workspace.js';
import {
  type GateStamp,
  type PackageStampEntry,
  type TestSuiteEntry,
  GateStampResult,
  computeSourceHash,
  countExpectedTests,
  writeGateStamp,
  buildPackageStampEntry,
  readGateStamp,
  validatePackageStamp,
} from './GateStamp.js';

// ── Build Cache ─────────────────────────────────────────────────────

interface BuildCacheEntry {
  sourceHash: string;
  phases: Record<string, 'passed' | 'skipped' | 'not-found' | 'failed'>;
}

interface BuildCache {
  packages: Record<string, BuildCacheEntry>;
}

function readBuildCache(repoRoot: string): BuildCache {
  const cachePath = join(repoRoot, '.zbb-build-cache.json');
  if (!existsSync(cachePath)) return { packages: {} };
  try {
    return JSON.parse(readFileSync(cachePath, 'utf-8'));
  } catch { return { packages: {} }; }
}

function writeBuildCache(repoRoot: string, cache: BuildCache): void {
  const cachePath = join(repoRoot, '.zbb-build-cache.json');
  writeFileSync(cachePath, JSON.stringify(cache, null, 2) + '\n');
}

/**
 * Check if a specific phase is cached for a package.
 * Each phase is independently cached. Source hash change invalidates ALL phases.
 * For dep-independent phases (lint), only the package's own hash matters.
 * For dep-dependent phases (transpile), dep hashes must also match.
 */
function isPhaseCached(
  name: string,
  phase: string,
  cache: BuildCache,
  sourceHashes: Map<string, string>,
  graph: DependencyGraph,
  ignoreDeps?: boolean,
): boolean {
  const currentHash = sourceHashes.get(name);
  if (!currentHash) return false;
  const entry = cache.packages[name];
  if (!entry) return false;
  // Source changed → all phases invalidated
  if (entry.sourceHash !== currentHash) return false;
  // This specific phase must have passed
  const phaseResult = entry.phases[phase];
  if (phaseResult !== 'passed' && phaseResult !== 'skipped' && phaseResult !== 'not-found') return false;

  if (ignoreDeps) return true;

  // Check deps' hashes match their cached hashes
  const pkg = graph.packages.get(name);
  if (pkg) {
    for (const dep of pkg.internalDeps) {
      const depHash = sourceHashes.get(dep);
      const depEntry = cache.packages[dep];
      if (!depHash || !depEntry || depEntry.sourceHash !== depHash) return false;
    }
  }

  return true;
}

/**
 * Update a single phase result in the cache for a package.
 * Preserves other phases. Updates sourceHash to current.
 */
function updatePhaseCache(
  cache: BuildCache,
  name: string,
  phase: string,
  status: 'passed' | 'skipped' | 'not-found' | 'failed',
  sourceHash: string,
): void {
  if (!cache.packages[name] || cache.packages[name].sourceHash !== sourceHash) {
    // New hash → reset all phases
    cache.packages[name] = { sourceHash, phases: {} };
  }
  cache.packages[name].phases[phase] = status;
}
import { getCurrentBranch } from './ChangeDetector.js';

// ── Types ────────────────────────────────────────────────────────────

export interface BuildContext {
  repoRoot: string;
  graph: DependencyGraph;
  affectedOrdered: string[];
  config: MonorepoConfig;
  verbose?: boolean;
  skipDocker?: boolean;
}

interface PhaseResult {
  phase: string;
  status: 'passed' | 'skipped' | 'not-found';
}

// ── Helpers ──────────────────────────────────────────────────────────

const isCI = process.env.CI === 'true';

// ── Registry Integration ────────────────────────────────────────────

interface RegistrySwap {
  npmrcBackup?: string;
  lockfileBackup?: string;
  taintedPackages: string[];
}

/**
 * If a zbb slot is loaded with locally-published registry packages,
 * swap .npmrc to route through Verdaccio and taint node_modules.
 */
function injectRegistryForBuild(repoRoot: string): RegistrySwap {
  const swap: RegistrySwap = { taintedPackages: [] };
  const slotName = process.env.ZB_SLOT;
  if (!slotName) return swap;

  const slotsDir = join(getZbbDir(), 'slots', slotName, 'stacks');
  const publishManifest = join(slotsDir, 'registry', 'publishes.json');
  const registryEnvFile = join(slotsDir, 'registry', '.env');

  if (!existsSync(publishManifest) || !existsSync(registryEnvFile)) return swap;

  let publishes: Array<{ name: string; version: string }> = [];
  try {
    publishes = JSON.parse(readFileSync(publishManifest, 'utf-8'));
  } catch { /* ignore */ }
  if (publishes.length === 0) return swap;

  // Read registry URL
  let registryUrl = '';
  let registryPort = '';
  for (const line of readFileSync(registryEnvFile, 'utf-8').split('\n')) {
    const urlMatch = line.match(/^REGISTRY_URL=(.+)$/);
    if (urlMatch) registryUrl = urlMatch[1];
    const portMatch = line.match(/^REGISTRY_PORT=(.+)$/);
    if (portMatch) registryPort = portMatch[1];
  }
  if (!registryUrl) return swap;

  // Swap .npmrc
  const npmrcPath = join(repoRoot, '.npmrc');
  const npmrcBackup = npmrcPath + '.zbb-backup';
  if (existsSync(npmrcPath)) {
    
    renameSync(npmrcPath, npmrcBackup);
    writeFileSync(npmrcPath, [
      `@zerobias-com:registry=${registryUrl}`,
      `@zerobias-org:registry=${registryUrl}`,
      `@auditlogic:registry=${registryUrl}`,
      `@auditmation:registry=${registryUrl}`,
      `@devsupply:registry=${registryUrl}`,
      `//localhost:${registryPort}/:_authToken=fake-local-token`,
    ].join('\n') + '\n');
    swap.npmrcBackup = npmrcBackup;
    console.log('  [registry] Swapped .npmrc for local Verdaccio');
  }

  // Backup package-lock.json
  const lockfile = join(repoRoot, 'package-lock.json');
  const lockBackup = lockfile + '.zbb-backup';
  if (existsSync(lockfile)) {
    copyFileSync(lockfile, lockBackup);
    swap.lockfileBackup = lockBackup;
  }

  // Taint node_modules for locally-published packages
  for (const pkg of publishes) {
    const modDir = join(repoRoot, 'node_modules', pkg.name);
    if (existsSync(modDir)) {
      rmSync(modDir, { recursive: true });
      swap.taintedPackages.push(pkg.name);
      console.log(`  [registry] Tainted ${pkg.name} (will reinstall from Verdaccio)`);
    }
  }

  return swap;
}

/**
 * Restore .npmrc and package-lock.json after build.
 */
function restoreRegistrySwap(swap: RegistrySwap, repoRoot: string): void {
  if (swap.npmrcBackup) {
    const npmrcPath = join(repoRoot, '.npmrc');
    try {
      if (existsSync(npmrcPath)) rmSync(npmrcPath);
      renameSync(swap.npmrcBackup, npmrcPath);
      console.log('  [registry] Restored .npmrc');
    } catch { /* ignore */ }
  }
  if (swap.lockfileBackup) {
    const lockfile = join(repoRoot, 'package-lock.json');
    try {
      if (existsSync(lockfile)) rmSync(lockfile);
      renameSync(swap.lockfileBackup, lockfile);
      console.log('  [registry] Restored package-lock.json');
    } catch { /* ignore */ }
  }
}

interface ScriptResult {
  status: 'passed' | 'skipped' | 'not-found' | 'failed';
  error?: string;
}

function runNpmScript(
  pkg: WorkspacePackage,
  script: string,
  options?: { verbose?: boolean; allowFailure?: boolean; showOutput?: boolean; env?: Record<string, string | undefined> },
): ScriptResult {
  // Check if the package has this script
  const scriptBody = pkg.scripts[script];
  if (!scriptBody) return { status: 'not-found' };

  // Scripts that are empty or just echo "no tests" count as skipped
  if (!scriptBody.trim() || /^echo\s/.test(scriptBody.trim())) {
    return { status: 'skipped' };
  }

  const shortName = pkg.name.replace(/^@[^/]+\//, '');
  const inherit = options?.showOutput || options?.verbose;

  try {
    if (options?.verbose) {
      console.log(`    npm run ${script}`);
    }

    execFileSync('npm', ['run', script], {
      cwd: pkg.dir,
      stdio: inherit ? 'inherit' : ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, FORCE_COLOR: '1', ...options?.env },
      timeout: 300_000, // 5 min per phase
    });

    return { status: 'passed' };
  } catch (error: any) {
    if (inherit) {
      // Output was already shown via inherited stdio
      const msg = `${shortName}: "npm run ${script}" failed (exit ${error.status})`;
      if (options?.allowFailure) {
        return { status: 'failed', error: msg };
      }
      throw new Error(msg);
    }

    const stderr = error.stderr?.toString() ?? '';
    const stdout = error.stdout?.toString() ?? '';
    const output = stderr || stdout;
    const msg = `${shortName}: "npm run ${script}" failed (exit ${error.status})`;

    // Show captured output on failure
    if (output.trim()) {
      console.log(output.trimEnd());
    }

    if (options?.allowFailure) {
      return { status: 'failed', error: msg };
    }

    throw new Error(msg);
  }
}

function removeArtifacts(pkgDir: string): void {
  for (const dir of ['dist', 'generated', 'build']) {
    const target = join(pkgDir, dir);
    if (existsSync(target)) rmSync(target, { recursive: true });
  }
  const buildInfo = join(pkgDir, 'tsconfig.tsbuildinfo');
  if (existsSync(buildInfo)) rmSync(buildInfo);
}

function printPhaseHeader(phase: string, packageCount: number): void {
  console.log(`\n── ${phase} (${packageCount} package${packageCount === 1 ? '' : 's'}) ──`);
}

/**
 * Run an npm script across packages concurrently, respecting dependency order.
 * A package starts once all its internal deps (within the affected set) have completed.
 * Logs ⏳ when spawning, ✓ on success, ✗ on failure.
 */
/**
 * Run an npm script across packages concurrently, respecting dependency order.
 * A package starts once all its internal deps (within the affected set) have completed.
 * Uses in-place terminal updates: each package gets one line that updates from ⏳ → ✓/✗.
 */
async function runPhaseConcurrently(
  packageNames: string[],
  graph: DependencyGraph,
  phase: string,
  options?: { verbose?: boolean; config?: MonorepoConfig; repoRoot?: string; buildCache?: BuildCache; sourceHashes?: Map<string, string>; ignoreDeps?: boolean },
): Promise<Map<string, 'passed' | 'skipped' | 'not-found' | 'failed'>> {
  const results = new Map<string, 'passed' | 'skipped' | 'not-found' | 'failed'>();
  const completed = new Set<string>();
  const pending = new Set(packageNames);
  const affectedSet = new Set(packageNames);

  // Skip packages that don't have the script
  for (const name of [...pending]) {
    const pkg = graph.packages.get(name)!;
    const scriptBody = pkg.scripts[phase];
    if (!scriptBody || !scriptBody.trim() || /^echo\s/.test(scriptBody.trim())) {
      results.set(name, scriptBody ? 'skipped' : 'not-found');
      completed.add(name);
      pending.delete(name);
    }
  }

  // Check build cache — skip packages with matching source hash
  if (options?.buildCache && options?.sourceHashes) {
    for (const name of [...pending]) {
      const hash = options.sourceHashes.get(name);
      if (hash && isPhaseCached(name, phase, options.buildCache, options.sourceHashes!, graph, options.ignoreDeps)) {
        results.set(name, 'passed');
        completed.add(name);
        pending.delete(name);
      }
    }
  }

  if (pending.size === 0) {
    // All cached — show them and return
    const nameLen = Math.max(...packageNames.map(n =>
      graph.packages.get(n)!.name.replace(/^@[^/]+\//, '').length
    ));
    for (const name of packageNames) {
      if (completed.has(name)) {
        const short = graph.packages.get(name)!.name.replace(/^@[^/]+\//, '').padEnd(nameLen);
        console.log(`  \x1b[34m◆ ${short} \x1b[90m(cached)\x1b[0m`);
      }
    }
    return results;
  }

  function depsCompleted(name: string): boolean {
    if (options?.ignoreDeps) return true;
    const pkg = graph.packages.get(name)!;
    for (const dep of pkg.internalDeps) {
      if (affectedSet.has(dep) && !completed.has(dep)) return false;
    }
    return true;
  }

  let resolveWaiter: (() => void) | null = null;
  function signal(): void { if (resolveWaiter) { resolveWaiter(); resolveWaiter = null; } }
  function waitForSignal(): Promise<void> { return new Promise(r => { resolveWaiter = r; }); }

  const inFlight = new Set<string>();
  let failed = false;
  let failError: Error | null = null;

  // Track display state for in-place updates
  // Each package in this phase gets a slot in the display list
  const isTTY = process.stdout.isTTY;
  const displayOrder: string[] = [];
  const displayStatus = new Map<string, string>();
  const spinnerFrames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  const activeSpinners = new Set<string>();
  const startTimes = new Map<string, number>();
  let spinnerIdx = 0;
  let spinnerTimer: ReturnType<typeof setInterval> | null = null;

  // Calculate max short name length for alignment
  const maxNameLen = Math.max(...packageNames.map(n =>
    graph.packages.get(n)!.name.replace(/^@[^/]+\//, '').length
  ));

  function sn(name: string): string {
    return graph.packages.get(name)!.name.replace(/^@[^/]+\//, '');
  }

  function pad(name: string): string {
    return sn(name).padEnd(maxNameLen);
  }

  function elapsed(name: string): string {
    const start = startTimes.get(name);
    if (!start) return '';
    const ms = Date.now() - start;
    return `\x1b[90m${(ms / 1000).toFixed(1)}s\x1b[0m`;
  }

  function renderDisplay(): void {
    if (!isTTY || displayOrder.length === 0) return;
    process.stdout.write(`\x1b[${displayOrder.length}A`);
    for (const name of displayOrder) {
      process.stdout.write(`\x1b[2K${displayStatus.get(name) ?? ''}\n`);
    }
  }

  function updateSpinners(): void {
    spinnerIdx = (spinnerIdx + 1) % spinnerFrames.length;
    const frame = spinnerFrames[spinnerIdx];
    for (const name of activeSpinners) {
      displayStatus.set(name, `  \x1b[36m${frame} ${pad(name)} ${elapsed(name)}\x1b[0m`);
    }
    renderDisplay();
  }

  function startSpinnerTimer(): void {
    if (!isTTY || spinnerTimer) return;
    spinnerTimer = setInterval(updateSpinners, 80);
  }

  function stopSpinnerTimer(): void {
    if (spinnerTimer) { clearInterval(spinnerTimer); spinnerTimer = null; }
  }

  function setFinalStatus(name: string, icon: string, color: string, suffix?: string): void {
    activeSpinners.delete(name);
    const time = suffix ?? elapsed(name);
    const text = `  ${color}${icon} ${pad(name)}\x1b[0m ${time}`;
    displayStatus.set(name, text);
    if (isTTY) {
      renderDisplay();
    } else {
      console.log(text);
    }
  }

  function addToDisplay(name: string): void {
    if (!displayOrder.includes(name)) {
      displayOrder.push(name);
      if (isTTY) process.stdout.write('\n');
    }
  }

  function spawnOne(name: string): void {
    inFlight.add(name);
    startTimes.set(name, Date.now());
    activeSpinners.add(name);
    addToDisplay(name);
    displayStatus.set(name, `  \x1b[36m${spinnerFrames[spinnerIdx]} ${pad(name)} ${elapsed(name)}\x1b[0m`);
    startSpinnerTimer();
    if (isTTY) renderDisplay();

    const pkg = graph.packages.get(name)!;
    const child = spawn('npm', ['run', phase], {
      cwd: pkg.dir,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, FORCE_COLOR: '1' },
    });

    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (d: Buffer) => { stdout += d.toString(); });
    child.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });

    child.on('exit', (code) => {
      inFlight.delete(name);
      completed.add(name);

      if (code === 0) {
        results.set(name, 'passed');
        setFinalStatus(name, '✓', '\x1b[32m');
      } else {
        results.set(name, 'failed');
        setFinalStatus(name, '✗', '\x1b[31m');
        // Print the actual build output (stdout has compiler errors, stderr has npm wrapper)
        // Show stdout first (contains the real errors), then stderr if different
        const output = [stdout.trim(), stderr.trim()].filter(Boolean).join('\n');
        if (output) {
          // Move past the display area before printing error details
          console.log(`\n\x1b[31m── ${sn(name)}: ${phase} errors ──\x1b[0m`);
          console.log(output);
          console.log('');
        }
        failed = true;
        failError = new Error(`${sn(name)}: "npm run ${phase}" failed (exit ${code})`);
        // Mark this phase as failed in cache (preserves other phases like lint)
        // Also invalidate this phase for all dependents
        if (options?.buildCache && options?.sourceHashes) {
          const hash = options.sourceHashes.get(name) ?? '';
          updatePhaseCache(options.buildCache, name, phase, 'failed', hash);
          const deps = graph.dependents.get(name);
          if (deps) {
            for (const dep of deps) {
              const depHash = options.sourceHashes.get(dep) ?? '';
              updatePhaseCache(options.buildCache, dep, phase, 'failed', depHash);
            }
          }
          if (options.repoRoot) writeBuildCache(options.repoRoot, options.buildCache);
        }
      }
      signal();
    });

    child.on('error', (err) => {
      inFlight.delete(name);
      completed.add(name);
      results.set(name, 'failed');
      setFinalStatus(name, '✗', '\x1b[31m');
      failed = true;
      failError = new Error(`${sn(name)}: spawn error: ${err.message}`);
      signal();
    });
  }

  // Pre-populate display — cached packages show ◆, pending show ◯
  for (const name of packageNames) {
    addToDisplay(name);
    if (completed.has(name)) {
      displayStatus.set(name, `  \x1b[34m◆ ${pad(name)} \x1b[90m(cached)\x1b[0m`);
      if (!isTTY) console.log(`  \x1b[34m◆ ${pad(name)} \x1b[90m(cached)\x1b[0m`);
    } else {
      displayStatus.set(name, `  \x1b[90m◯ ${pad(name)}\x1b[0m`);
    }
  }
  if (isTTY) renderDisplay();

  // Main loop
  while (pending.size > 0 || inFlight.size > 0) {
    if (failed) { stopSpinnerTimer(); throw failError!; }

    for (const name of [...pending]) {
      if (depsCompleted(name)) {
        pending.delete(name);
        spawnOne(name);
      }
    }

    if (inFlight.size > 0) {
      await waitForSignal();
    }
  }

  stopSpinnerTimer();
  if (failed) throw failError!;
  return results;
}

// ── Clean ────────────────────────────────────────────────────────────

export async function clean(ctx: BuildContext): Promise<void> {
  const { graph, affectedOrdered, config, verbose, repoRoot } = ctx;
  printPhaseHeader('clean', affectedOrdered.length);

  // Use the same concurrent runner — create a virtual "clean" phase
  // that runs the clean script + removes standard artifacts
  const completed = new Set<string>();
  const pending = new Set(affectedOrdered);
  const inFlight = new Set<string>();
  const affectedSet = new Set(affectedOrdered);

  let resolveWaiter: (() => void) | null = null;
  function signal(): void { if (resolveWaiter) { resolveWaiter(); resolveWaiter = null; } }
  function waitForSignal(): Promise<void> { return new Promise(r => { resolveWaiter = r; }); }

  const isTTY = process.stdout.isTTY;
  const displayOrder: string[] = [];
  const displayStatus = new Map<string, string>();
  const spinnerFrames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  const activeSpinners = new Set<string>();
  let spinnerIdx = 0;
  let spinnerTimer: ReturnType<typeof setInterval> | null = null;

  const maxNameLen = Math.max(...affectedOrdered.map(n =>
    graph.packages.get(n)!.name.replace(/^@[^/]+\//, '').length
  ));

  function sn(name: string): string {
    return graph.packages.get(name)!.name.replace(/^@[^/]+\//, '');
  }

  function pad(name: string): string {
    return sn(name).padEnd(maxNameLen);
  }

  function renderDisplay(): void {
    if (!isTTY || displayOrder.length === 0) return;
    process.stdout.write(`\x1b[${displayOrder.length}A`);
    for (const name of displayOrder) {
      process.stdout.write(`\x1b[2K${displayStatus.get(name) ?? ''}\n`);
    }
  }

  function updateSpinners(): void {
    spinnerIdx = (spinnerIdx + 1) % spinnerFrames.length;
    for (const name of activeSpinners) {
      displayStatus.set(name, `  \x1b[36m${spinnerFrames[spinnerIdx]} ${pad(name)}\x1b[0m`);
    }
    renderDisplay();
  }

  function startSpinnerTimer(): void {
    if (!isTTY || spinnerTimer) return;
    spinnerTimer = setInterval(updateSpinners, 80);
  }

  function stopSpinnerTimer(): void {
    if (spinnerTimer) { clearInterval(spinnerTimer); spinnerTimer = null; }
  }

  function depsCompleted(name: string): boolean {
    const pkg = graph.packages.get(name)!;
    for (const dep of pkg.internalDeps) {
      if (affectedSet.has(dep) && !completed.has(dep)) return false;
    }
    return true;
  }

  // Pre-populate display
  for (const name of affectedOrdered) {
    displayOrder.push(name);
    if (isTTY) process.stdout.write('\n');
    displayStatus.set(name, depsCompleted(name)
      ? `  \x1b[90m◯ ${pad(name)}\x1b[0m`
      : `  \x1b[90m◯ ${pad(name)}\x1b[0m`);
  }
  if (isTTY) renderDisplay();

  function spawnClean(name: string): void {
    const pkg = graph.packages.get(name)!;
    inFlight.add(name);
    activeSpinners.add(name);
    displayStatus.set(name, `  \x1b[36m${spinnerFrames[spinnerIdx]} ${pad(name)}\x1b[0m`);
    startSpinnerTimer();
    if (isTTY) renderDisplay();

    if (pkg.scripts.clean) {
      const child = spawn('npm', ['run', 'clean'], {
        cwd: pkg.dir,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, FORCE_COLOR: '1' },
      });

      child.on('exit', () => {
        removeArtifacts(pkg.dir);
        inFlight.delete(name);
        activeSpinners.delete(name);
        completed.add(name);
        displayStatus.set(name, `  \x1b[32m✓ ${pad(name)}\x1b[0m`);
        if (isTTY) renderDisplay(); else console.log(`  \x1b[32m✓ ${pad(name)}\x1b[0m`);
        signal();
      });

      child.on('error', () => {
        removeArtifacts(pkg.dir);
        inFlight.delete(name);
        activeSpinners.delete(name);
        completed.add(name);
        displayStatus.set(name, `  \x1b[32m✓ ${pad(name)}\x1b[0m`);
        if (isTTY) renderDisplay(); else console.log(`  \x1b[32m✓ ${pad(name)}\x1b[0m`);
        signal();
      });
    } else {
      removeArtifacts(pkg.dir);
      inFlight.delete(name);
      activeSpinners.delete(name);
      completed.add(name);
      displayStatus.set(name, `  \x1b[32m✓ ${pad(name)}\x1b[0m`);
      if (isTTY) renderDisplay(); else console.log(`  \x1b[32m✓ ${pad(name)}\x1b[0m`);
      signal();
    }
  }

  while (pending.size > 0 || inFlight.size > 0) {
    for (const name of [...pending]) {
      if (depsCompleted(name)) {
        pending.delete(name);
        spawnClean(name);
      }
    }
    if (inFlight.size > 0) {
      await waitForSignal();
    }
  }

  stopSpinnerTimer();

  // Clean Docker context package/ directories
  if (config.images) {
    let dockerCleaned = 0;
    for (const [dir, imageConfig] of Object.entries(config.images)) {
      const contextDir = join(repoRoot, imageConfig.context);
      const packageDir = join(contextDir, 'package');
      if (existsSync(packageDir)) {
        rmSync(packageDir, { recursive: true });
        dockerCleaned += 1;
      }
      // Clean stale lockfiles in Docker context
      const staleLock = join(contextDir, 'package-lock.json');
      if (existsSync(staleLock)) rmSync(staleLock);
    }
    if (dockerCleaned > 0) {
      console.log(`  [docker] Cleaned ${dockerCleaned} context(s)`);
    }
  }

  // Clean root-level build artifacts
  const rootCleanDirs = ['.nx', 'node_modules/.cache'];
  let rootCleaned = 0;
  for (const dir of rootCleanDirs) {
    const target = join(repoRoot, dir);
    if (existsSync(target)) {
      rmSync(target, { recursive: true });
      rootCleaned += 1;
    }
  }
  // Clean zbb backup files, build cache, and gate stamp
  for (const file of ['.npmrc.zbb-backup', 'package-lock.json.zbb-backup', '.zbb-build-cache.json', 'gate-stamp.json']) {
    const target = join(repoRoot, file);
    if (existsSync(target)) { rmSync(target); rootCleaned += 1; }
  }
  if (rootCleaned > 0) {
    console.log(`\n  \x1b[90m[root] Cleaned ${rootCleaned} artifact(s)\x1b[0m`);
  }
}

// ── Build ────────────────────────────────────────────────────────────

export async function build(ctx: BuildContext): Promise<Map<string, Record<string, 'passed' | 'skipped' | 'not-found'>>> {
  const { graph, affectedOrdered, config, verbose } = ctx;
  const phases = config.buildPhases ?? ['lint', 'generate', 'transpile'];
  const allTaskResults = new Map<string, Record<string, 'passed' | 'skipped' | 'not-found'>>();

  // Registry injection: if slot is loaded with locally-published packages,
  // swap .npmrc and taint node_modules so npm install picks up local versions
  const registrySwap = injectRegistryForBuild(ctx.repoRoot);

  // Build cache: compute source hashes for ALL packages (not just affected)
  // so dependency hash checks work even when a dep isn't in the affected set
  const buildCache = readBuildCache(ctx.repoRoot);
  const sourceHashes = new Map<string, string>();
  for (const [name, pkg] of graph.packages) {
    sourceHashes.set(name, computeSourceHash(pkg, config));
  }

  try {

  for (const phase of phases) {
    // Collect packages that have this script or a cache entry
    const packagesWithPhase = affectedOrdered.filter(name => {
      const pkg = graph.packages.get(name)!;
      const body = pkg.scripts[phase];
      return body && body.trim() && !/^echo\s/.test(body.trim());
    });

    if (packagesWithPhase.length === 0) continue;

    printPhaseHeader(phase, packagesWithPhase.length);

    // Run packages concurrently, respecting dependency order.
    // Lint doesn't depend on build outputs — all packages can lint concurrently.
    const ignoreDeps = phase === 'lint';
    const results = await runPhaseConcurrently(packagesWithPhase, graph, phase, {
      verbose, config, repoRoot: ctx.repoRoot, buildCache, sourceHashes, ignoreDeps,
    });

    for (const [name, status] of results) {
      if (!allTaskResults.has(name)) allTaskResults.set(name, {});
      allTaskResults.get(name)![phase] = status === 'failed' ? 'skipped' : status;

      // Write cache immediately per phase so passing results survive a later failure
      const hash = sourceHashes.get(name);
      if (hash) {
        updatePhaseCache(buildCache, name, phase, status, hash);
      }
    }
    writeBuildCache(ctx.repoRoot, buildCache);
  }

  // Docker build phase — build images concurrently
  if (!ctx.skipDocker && config.images) {
    const dockerPackages = affectedOrdered.filter(name => {
      const pkg = graph.packages.get(name)!;
      return config.images![pkg.relDir];
    });

    if (dockerPackages.length > 0) {
      printPhaseHeader('docker', dockerPackages.length);
      await buildDockerImages(dockerPackages, graph, config, ctx);

      // Prune dangling images after Docker builds
      try {
        execFileSync('docker', ['image', 'prune', '-f'], { stdio: 'pipe' });
      } catch { /* ignore */ }
    }
  }

  return allTaskResults;

  } finally {
    restoreRegistrySwap(registrySwap, ctx.repoRoot);
  }
}

// ── Docker Build (concurrent) ───────────────────────────────────────

async function buildDockerImages(
  packageNames: string[],
  graph: DependencyGraph,
  config: MonorepoConfig,
  ctx: BuildContext,
): Promise<void> {
  const isTTY = process.stdout.isTTY;
  const maxNameLen = Math.max(...packageNames.map(n =>
    graph.packages.get(n)!.name.replace(/^@[^/]+\//, '').length
  ));
  const displayOrder: string[] = [];
  const displayStatus = new Map<string, string>();
  const spinnerFrames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  const activeSpinners = new Map<string, string>(); // name → current stage text
  const startTimes = new Map<string, number>();
  let spinnerIdx = 0;
  let spinnerTimer: ReturnType<typeof setInterval> | null = null;

  function sn(name: string): string { return graph.packages.get(name)!.name.replace(/^@[^/]+\//, ''); }
  function pad(name: string): string { return sn(name).padEnd(maxNameLen); }
  function elapsed(name: string): string {
    const start = startTimes.get(name);
    if (!start) return '';
    return `\x1b[90m${((Date.now() - start) / 1000).toFixed(1)}s\x1b[0m`;
  }

  function renderDisplay(): void {
    if (!isTTY || displayOrder.length === 0) return;
    process.stdout.write(`\x1b[${displayOrder.length}A`);
    for (const name of displayOrder) {
      process.stdout.write(`\x1b[2K${displayStatus.get(name) ?? ''}\n`);
    }
  }

  function updateSpinners(): void {
    spinnerIdx = (spinnerIdx + 1) % spinnerFrames.length;
    for (const [name, stage] of activeSpinners) {
      displayStatus.set(name, `  \x1b[36m${spinnerFrames[spinnerIdx]} ${pad(name)} ${stage} ${elapsed(name)}\x1b[0m`);
    }
    renderDisplay();
  }

  function startSpinnerTimer(): void {
    if (!isTTY || spinnerTimer) return;
    spinnerTimer = setInterval(updateSpinners, 80);
  }
  function stopSpinnerTimer(): void {
    if (spinnerTimer) { clearInterval(spinnerTimer); spinnerTimer = null; }
  }

  // Pre-populate display
  for (const name of packageNames) {
    displayOrder.push(name);
    if (isTTY) process.stdout.write('\n');
    displayStatus.set(name, `  \x1b[90m◯ ${pad(name)}\x1b[0m`);
  }
  if (isTTY) renderDisplay();

  let resolveWaiter: (() => void) | null = null;
  function signal(): void { if (resolveWaiter) { resolveWaiter(); resolveWaiter = null; } }
  function waitForSignal(): Promise<void> { return new Promise(r => { resolveWaiter = r; }); }

  const inFlight = new Set<string>();
  const completed = new Set<string>();
  const pending = new Set(packageNames);
  let failed = false;
  let failError: Error | null = null;

  function buildOne(name: string): void {
    const pkg = graph.packages.get(name)!;
    const imageConfig = config.images![pkg.relDir];
    const imageTag = `${imageConfig.name}:dev`;
    const contextDir = join(ctx.repoRoot, imageConfig.context);

    inFlight.add(name);
    startTimes.set(name, Date.now());
    activeSpinners.set(name, 'packing');
    startSpinnerTimer();
    if (isTTY) renderDisplay();

    // Run the entire pack + build pipeline in a child process to keep it non-blocking
    const script = `
      set -e
      CONTEXT="${contextDir}"
      PKG_DIR="${pkg.dir}"
      REPO_ROOT="${ctx.repoRoot}"
      IMAGE_TAG="${imageTag}"

      # Clean context
      rm -f "$CONTEXT/package-lock.json"
      rm -rf "$CONTEXT/package"

      # Prepublish standalone if available
      PREPUB="$REPO_ROOT/node_modules/@zerobias-org/devops-tools/scripts/prepublish-standalone.sh"
      if [ -f "$PREPUB" ]; then
        bash "$PREPUB" "$REPO_ROOT" --library 2>&1
      fi

      # Pack
      TGZ=$(cd "$PKG_DIR" && npm pack --pack-destination "$CONTEXT" 2>/dev/null | tail -1)
      tar xzf "$CONTEXT/$TGZ" -C "$CONTEXT"
      rm -f "$CONTEXT/$TGZ"

      # Restore prepublish backup
      [ -f "$PKG_DIR/package.json.prepublish-backup" ] && mv "$PKG_DIR/package.json.prepublish-backup" "$PKG_DIR/package.json" || true

      # Build
      docker build --progress=plain \\
        -t "$IMAGE_TAG" \\
        --build-arg npm_token="${process.env.NPM_TOKEN ?? ''}" \\
        --build-arg zb_token="${process.env.ZB_TOKEN ?? ''}" \\
        . 2>&1

      # Restore prepublish backup (in case build failed before restore)
      [ -f "$PKG_DIR/package.json.prepublish-backup" ] && mv "$PKG_DIR/package.json.prepublish-backup" "$PKG_DIR/package.json" || true
    `;

    const child = spawn('bash', ['-c', script], {
      cwd: contextDir,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: process.env,
    });

    let stdout = '';
    let stderr = '';
    let stage = 'packing';
    child.stdout?.on('data', (d: Buffer) => {
      stdout += d.toString();
      // Detect stage transitions from output
      if (stdout.includes('docker build') && stage === 'packing') {
        stage = 'building';
        activeSpinners.set(name, 'building');
      }
    });
    child.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });

    child.on('exit', (code) => {
      inFlight.delete(name);
      activeSpinners.delete(name);
      completed.add(name);

      if (code === 0) {
        displayStatus.set(name, `  \x1b[32m✓ ${pad(name)} ${elapsed(name)}\x1b[0m`);
        if (!isTTY) console.log(`  \x1b[32m✓ ${pad(name)} ${elapsed(name)}\x1b[0m`);
      } else {
        displayStatus.set(name, `  \x1b[31m✗ ${pad(name)} ${elapsed(name)}\x1b[0m`);
        if (!isTTY) console.log(`  \x1b[31m✗ ${pad(name)} ${elapsed(name)}\x1b[0m`);
        failed = true;
        const output = [stdout.trim(), stderr.trim()].filter(Boolean).join('\n');
        failError = new Error(`Docker build failed for ${sn(name)}`);
        if (output) {
          console.log(`\n\x1b[31m── ${sn(name)}: docker errors ──\x1b[0m`);
          console.log(output);
        }
      }
      if (isTTY) renderDisplay();
      signal();
    });

    child.on('error', (err) => {
      inFlight.delete(name);
      activeSpinners.delete(name);
      completed.add(name);
      displayStatus.set(name, `  \x1b[31m✗ ${pad(name)}\x1b[0m`);
      failed = true;
      failError = new Error(`Docker build spawn error for ${sn(name)}: ${err.message}`);
      if (isTTY) renderDisplay();
      signal();
    });
  }

  // All Docker builds can run concurrently (no inter-package deps for Docker)
  for (const name of [...pending]) {
    pending.delete(name);
    buildOne(name);
  }

  // Wait for all to complete
  while (inFlight.size > 0) {
    await waitForSignal();
    if (failed) { stopSpinnerTimer(); throw failError!; }
  }

  stopSpinnerTimer();
  if (failed) throw failError!;
}

// ── Neon Database Branching ──────────────────────────────────────────

interface NeonBranch {
  branchId: string;
  host: string;
  password: string;
  role: string;
  database: string;
}

function neonCreateBranch(
  apiKey: string,
  projectId: string,
  parentBranch: string,
  branchName: string,
  dbRole: string,
  dbName: string,
): NeonBranch {
  const baseUrl = `https://console.neon.tech/api/v2/projects/${projectId}`;

  // Step 1: Look up parent branch ID
  const branchesOutput = execFileSync('curl', [
    '-sf',
    '-H', `Authorization: Bearer ${apiKey}`,
    `${baseUrl}/branches`,
  ], { encoding: 'utf-8', timeout: 30_000 });

  const parentIdMatch = branchesOutput.match(
    new RegExp(`"id"\\s*:\\s*"(br-[^"]+)"[^}]*?"name"\\s*:\\s*"${parentBranch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`)
  ) ?? branchesOutput.match(
    new RegExp(`"name"\\s*:\\s*"${parentBranch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"[^}]*?"id"\\s*:\\s*"(br-[^"]+)"`)
  );
  if (!parentIdMatch) {
    throw new Error(`Parent branch '${parentBranch}' not found in project ${projectId}`);
  }
  const parentId = parentIdMatch[1];

  // Step 2: Create branch
  const createPayload = JSON.stringify({
    branch: { name: branchName, parent_id: parentId },
    endpoints: [{ type: 'read_write', suspend_timeout_seconds: 300 }],
  });

  const createOutput = execFileSync('curl', [
    '-sf',
    '-H', `Authorization: Bearer ${apiKey}`,
    '-H', 'Content-Type: application/json',
    '-X', 'POST',
    '-d', createPayload,
    `${baseUrl}/branches`,
  ], { encoding: 'utf-8', timeout: 60_000 });

  const branchId = createOutput.match(/"id"\s*:\s*"(br-[^"]+)"/)?.[1];
  const host = createOutput.match(/"host"\s*:\s*"([^"]+)"/)?.[1];
  if (!branchId || !host) {
    throw new Error(`Failed to parse Neon branch response: ${createOutput.substring(0, 200)}`);
  }

  // Step 3: Get role password
  const passwordOutput = execFileSync('curl', [
    '-sf',
    '-H', `Authorization: Bearer ${apiKey}`,
    `${baseUrl}/branches/${branchId}/roles/${dbRole}/reveal_password`,
  ], { encoding: 'utf-8', timeout: 30_000 });

  const password = passwordOutput.match(/"password"\s*:\s*"([^"]+)"/)?.[1];
  if (!password) {
    throw new Error(`Failed to get password for role ${dbRole}`);
  }

  return { branchId, host, password, role: dbRole, database: dbName };
}

function neonDeleteBranch(apiKey: string, projectId: string, branchId: string): void {
  execFileSync('curl', [
    '-sf',
    '-H', `Authorization: Bearer ${apiKey}`,
    '-X', 'DELETE',
    `https://console.neon.tech/api/v2/projects/${projectId}/branches/${branchId}`,
  ], { encoding: 'utf-8', timeout: 30_000 });
}

// ── Test ─────────────────────────────────────────────────────────────

export interface TestOutput {
  results: Map<string, Record<string, TestSuiteEntry>>;
  failed: boolean;
}

export async function test(ctx: BuildContext): Promise<TestOutput> {
  const { graph, affectedOrdered, config, verbose, repoRoot } = ctx;
  const phases = config.testPhases ?? ['test'];
  const allTestResults = new Map<string, Record<string, TestSuiteEntry>>();

  // Collect packages that have test scripts
  const packagesWithTests = affectedOrdered.filter(name => {
    const pkg = graph.packages.get(name)!;
    return phases.some(phase => {
      const body = pkg.scripts[phase];
      return body && body.trim() && !/^echo\s/.test(body.trim());
    });
  });

  // Pre-populate results for packages without tests — mark as skipped
  for (const name of affectedOrdered) {
    if (!packagesWithTests.includes(name)) {
      const pkg = graph.packages.get(name)!;
      const testSuiteResults: Record<string, TestSuiteEntry> = {};
      for (const suite of ['unit', 'integration', 'e2e']) {
        testSuiteResults[suite] = { expected: 0, ran: 0, status: 'skipped' };
      }
      allTestResults.set(name, testSuiteResults);
    }
  }

  if (packagesWithTests.length === 0) {
    console.log('\n── test (0 packages) ──');
    console.log('  No packages with test scripts.');
    return { results: allTestResults, failed: false };
  }

  // Neon database config
  const dbConfig = config.testDatabase;
  const dbPackageSet = new Set(dbConfig?.packages ?? []);
  const needsNeon = dbConfig && dbConfig.provider === 'neon';

  if (needsNeon) {
    const apiKey = process.env.NEON_API_KEY;
    const projectId = process.env.NEON_PROJECT_ID;
    if (!apiKey || !projectId) {
      console.error('\x1b[31mNeon test database required but NEON_API_KEY or NEON_PROJECT_ID not set.\x1b[0m');
      console.error('Set from Vault: vault kv get operations-kv/neon/content');
      process.exit(1);
    }
  }

  printPhaseHeader('test', packagesWithTests.length);
  let testsFailed = false;

  // Track all Neon branches for guaranteed cleanup
  const neonBranches: Array<{ branchId: string; shortName: string }> = [];
  const apiKey = process.env.NEON_API_KEY ?? '';
  const projectId = process.env.NEON_PROJECT_ID ?? '';

  try {
    // Run all test packages concurrently — each DB package gets its own Neon branch
    const testPromises: Array<Promise<void>> = [];

    for (const name of affectedOrdered) {
      const pkg = graph.packages.get(name)!;
      const shortName = pkg.name.replace(/^@[^/]+\//, '');
      const packageNeedsDb = needsNeon && dbPackageSet.has(pkg.relDir);

      const promise = (async () => {
        const testSuiteResults: Record<string, TestSuiteEntry> = {};

        // Count expected tests per suite
        for (const [suite, dir] of Object.entries({
          unit: join(pkg.dir, 'test', 'unit'),
          integration: join(pkg.dir, 'test', 'integration'),
          e2e: join(pkg.dir, 'test', 'e2e'),
        })) {
          const expected = countExpectedTests(dir);
          testSuiteResults[suite] = { expected, ran: 0, status: expected === 0 ? 'skipped' : 'not-run' };
        }

        // Create per-package Neon branch if needed
        let branchId: string | null = null;
        const pgEnv: Record<string, string> = {};

        if (packageNeedsDb) {
          const parentBranch = process.env.NEON_PARENT_BRANCH ?? dbConfig!.parentBranch;
          const dbRole = process.env.NEON_DB_ROLE ?? 'neondb_owner';
          const dbName = process.env.NEON_DB_NAME ?? 'zerobias';
          const branchName = `zbb-${shortName}-${Date.now()}`;

          console.log(`  \x1b[90m${shortName}: creating neon branch...\x1b[0m`);

          try {
            const neon = neonCreateBranch(apiKey, projectId, parentBranch, branchName, dbRole, dbName);
            branchId = neon.branchId;
            neonBranches.push({ branchId, shortName });

            pgEnv.PGHOST = neon.host;
            pgEnv.PGPORT = '5432';
            pgEnv.PGUSER = neon.role;
            pgEnv.PGPASSWORD = neon.password;
            pgEnv.PGDATABASE = neon.database;
            pgEnv.PGSSLMODE = 'require';

            console.log(`  \x1b[90m${shortName}: branch ready (${neon.host})\x1b[0m`);
          } catch (error: any) {
            console.error(`  \x1b[31m✗ ${shortName}: failed to create neon branch\x1b[0m`);
            console.error(`    ${error.message}`);
            testsFailed = true;
            allTestResults.set(name, testSuiteResults);
            return;
          }
        }

        // Run test phases with package-specific PG env
        for (const phase of phases) {
          console.log(`  ${shortName}: npm run ${phase}`);

          // For DB packages, spawn with custom env (not process.env override)
          const customEnv = packageNeedsDb ? { ...process.env, ...pgEnv } : undefined;

          const { status, error } = runNpmScript(pkg, phase, {
            showOutput: true,
            allowFailure: true,
            env: customEnv,
          });

          if (status === 'passed') {
            console.log(`  \x1b[32m✓ ${shortName}\x1b[0m`);
            for (const entry of Object.values(testSuiteResults)) {
              if (entry.expected > 0) { entry.ran = entry.expected; entry.status = 'passed'; }
            }
          } else if (status === 'failed') {
            console.log(`  \x1b[31m✗ ${shortName} (test failures)\x1b[0m`);
            if (error) console.log(`    ${error.split('\n')[0]}`);
            testsFailed = true;
          } else {
            for (const entry of Object.values(testSuiteResults)) {
              if (entry.status === 'not-run') entry.status = 'skipped';
            }
          }
        }

        allTestResults.set(name, testSuiteResults);
      })();

      testPromises.push(promise);
    }

    await Promise.all(testPromises);

  } finally {
    // Always clean up ALL Neon branches
    if (neonBranches.length > 0) {
      console.log(`\n── neon cleanup ──`);
      for (const { branchId, shortName } of neonBranches) {
        try {
          neonDeleteBranch(apiKey, projectId, branchId);
          console.log(`  \x1b[32m✓\x1b[0m ${shortName}: branch deleted (${branchId})`);
        } catch (err: any) {
          console.error(`  \x1b[33m⚠\x1b[0m ${shortName}: failed to delete branch ${branchId}: ${err.message}`);
        }
      }
    }
  }

  return { results: allTestResults, failed: testsFailed };
}

// ── Install ──────────────────────────────────────────────────────────

export function install(repoRoot: string): void {
  console.log('\n── install ──');
  const cmd = isCI ? 'ci' : 'install';
  process.stdout.write(`  npm ${cmd}... `);

  execFileSync('npm', [cmd], {
    cwd: repoRoot,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, FORCE_COLOR: '1' },
    timeout: 300_000,
  });

  console.log('done');
}

// ── Credential Sync ──────────────────────────────────────────────────

/**
 * Sync fresh credentials into process.env before tests run.
 * ~/.vault-token (written by `vault login`) is fresher than the slot's VAULT_TOKEN,
 * which may be stale from when the slot was created.
 */
function syncCredentials(): void {
  const tokenFile = join(homedir(), '.vault-token');
  if (existsSync(tokenFile)) {
    const token = readFileSync(tokenFile, 'utf-8').trim();
    if (token && token !== process.env.VAULT_TOKEN) {
      process.env.VAULT_TOKEN = token;
    }
  }
}

// ── Gate (full pipeline with caching) ────────────────────────────────

export async function gate(ctx: BuildContext): Promise<void> {
  const { repoRoot, graph, affectedOrdered, config } = ctx;

  if (affectedOrdered.length === 0) {
    console.log('No packages affected — nothing to gate.');
    const existingStamp = readGateStamp(repoRoot) ?? { version: 1, branch: '', timestamp: '', packages: {} };
    existingStamp.branch = getCurrentBranch(repoRoot);
    existingStamp.timestamp = new Date().toISOString();
    writeGateStamp(repoRoot, existingStamp);
    return;
  }

  // Check existing stamp to determine what can be skipped
  const existingStamp = readGateStamp(repoRoot);
  const validPackages: string[] = [];
  const testsChangedPackages: string[] = [];
  const fullGatePackages: string[] = [];

  console.log('\n── cache check ──');
  for (const name of affectedOrdered) {
    const pkg = graph.packages.get(name)!;
    const shortName = pkg.name.replace(/^@[^/]+\//, '');
    const result = validatePackageStamp(pkg, existingStamp, config);

    switch (result) {
      case GateStampResult.VALID:
        validPackages.push(name);
        console.log(`  \x1b[32m✓\x1b[0m ${shortName} \x1b[32m— up to date, skipping\x1b[0m`);
        break;
      case GateStampResult.TESTS_CHANGED:
        testsChangedPackages.push(name);
        console.log(`  \x1b[33m~\x1b[0m ${shortName} \x1b[33m— tests changed, re-running tests only\x1b[0m`);
        break;
      default:
        fullGatePackages.push(name);
        console.log(`  \x1b[31m✗\x1b[0m ${shortName} \x1b[31m— full gate needed\x1b[0m`);
    }
  }

  const needsBuild = fullGatePackages.length > 0;
  const needsTest = testsChangedPackages.length > 0 || fullGatePackages.length > 0;

  if (!needsBuild && !needsTest) {
    console.log('\nAll packages up to date — nothing to do.');
    // Update timestamp only
    if (existingStamp) {
      existingStamp.branch = getCurrentBranch(repoRoot);
      existingStamp.timestamp = new Date().toISOString();
      writeGateStamp(repoRoot, existingStamp);
    }
    return;
  }

  // Install dependencies at workspace root (needed for both build and test)
  install(repoRoot);

  // Build only packages that need full gate
  const taskResults = new Map<string, Record<string, 'passed' | 'skipped' | 'not-found'>>();

  if (needsBuild) {
    const buildCtx = { ...ctx, affectedOrdered: fullGatePackages };
    const buildResults = await build(buildCtx);
    for (const [k, v] of buildResults) taskResults.set(k, v);
  }

  // Sync fresh credentials (e.g., ~/.vault-token) before running tests
  syncCredentials();

  // Test: packages needing full gate + packages with only test changes
  const packagesToTest = [...fullGatePackages, ...testsChangedPackages];
  const testOutput = await test({ ...ctx, affectedOrdered: packagesToTest });
  const testResults = testOutput.results;
  const testsFailed = testOutput.failed;

  // Write gate stamp — merge new results with cached valid packages
  console.log('\n── gate-stamp ──');
  const stamp: GateStamp = {
    version: 1,
    branch: getCurrentBranch(repoRoot),
    timestamp: new Date().toISOString(),
    packages: existingStamp?.packages ?? {},
  };

  // Keep valid packages as-is in stamp (already cached)
  // Update packages that were rebuilt or retested
  const phases = config.buildPhases ?? ['lint', 'generate', 'transpile'];
  const testPhases = config.testPhases ?? ['test'];

  for (const name of [...fullGatePackages, ...testsChangedPackages]) {
    const pkg = graph.packages.get(name)!;
    const tasks = taskResults.get(name) ?? {};
    const tests = testResults.get(name) ?? {};

    const allTasks: Record<string, 'passed' | 'skipped' | 'not-found'> = {};
    for (const phase of [...phases, ...testPhases]) {
      allTasks[phase] = tasks[phase] ?? 'skipped';
    }

    // For tests-changed packages that weren't rebuilt, carry forward build task results
    if (testsChangedPackages.includes(name) && !fullGatePackages.includes(name)) {
      const cachedEntry = existingStamp?.packages[name];
      if (cachedEntry) {
        for (const phase of phases) {
          allTasks[phase] = cachedEntry.tasks[phase] as any ?? 'skipped';
        }
      }
    }

    stamp.packages[name] = buildPackageStampEntry(pkg, config, allTasks, tests);
  }

  // Print test summary
  let totalExpected = 0;
  let totalPassed = 0;
  for (const [, tests] of testResults) {
    for (const [, entry] of Object.entries(tests) as Array<[string, TestSuiteEntry]>) {
      if (entry.expected > 0) {
        totalExpected += entry.expected;
        totalPassed += entry.ran;
      }
    }
  }
  if (totalExpected > 0) {
    console.log(`  Tests: ${totalPassed}/${totalExpected} passed`);
  }

  if (testsFailed) {
    console.error('\n\x1b[31mGate failed — test failures detected. Stamp NOT written.\x1b[0m');
    process.exit(1);
  }

  // Only write stamp if all tests passed
  writeGateStamp(repoRoot, stamp);

  const skipped = validPackages.length;
  const rebuilt = fullGatePackages.length;
  const retested = testsChangedPackages.length;
  console.log(`  \x1b[32m✓ gate-stamp.json written (${skipped} cached, ${rebuilt} rebuilt, ${retested} retested)\x1b[0m`);
}
