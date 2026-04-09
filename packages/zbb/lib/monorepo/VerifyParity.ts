/**
 * `zbb monorepo verify-parity` — validate the new Gradle path produces
 * equivalent output to the legacy TS path for a repo.
 *
 * Run before merging each repo's migration PR. Stays around as a safety net
 * through phase 6, deleted in phase 7.
 *
 * Approach:
 *   1. Backup gate-stamp.json
 *   2. Run `ZBB_USE_LEGACY_MONOREPO=1 zbb gate --all`, save the resulting
 *      stamp to /tmp/zbb-parity-ts.json
 *   3. Restore the backup
 *   4. Run `zbb gate --all` (default Gradle path), save the resulting stamp
 *      to /tmp/zbb-parity-gradle.json
 *   5. Restore the backup
 *   6. Normalize both stamps (sort packages, strip volatile fields like
 *      timestamp+branch+rootDeps which can have ordering noise)
 *   7. Diff them
 *   8. Optionally: also diff `zbb publish --dry-run` output (would-publish
 *      package list + resolved deps) for both paths
 *
 * Reports a non-zero exit code on any drift.
 */

import { existsSync, readFileSync, writeFileSync, copyFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const COLOR = {
  reset: '\x1b[0m',
  dim: '\x1b[90m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
};

interface VerifyOptions {
  /** Skip the publish parity check (gate-only). Default: false (run both) */
  gateOnly?: boolean;
  /** Print verbose diffs even when stamps match */
  verbose?: boolean;
}

/**
 * Run both paths and report drift. Returns process exit code (0 = parity, 1 = drift).
 */
export async function verifyParity(repoRoot: string, options: VerifyOptions = {}): Promise<number> {
  const stampPath = join(repoRoot, 'gate-stamp.json');
  const backupPath = join(repoRoot, 'gate-stamp.json.zbb-parity-backup');
  const tsStampPath = '/tmp/zbb-parity-ts.json';
  const gradleStampPath = '/tmp/zbb-parity-gradle.json';

  // Step 0: backup the existing stamp (if any)
  const hadStamp = existsSync(stampPath);
  if (hadStamp) {
    copyFileSync(stampPath, backupPath);
  }

  // Cleanup helper
  const restore = (): void => {
    if (hadStamp && existsSync(backupPath)) {
      copyFileSync(backupPath, stampPath);
      unlinkSync(backupPath);
    } else if (existsSync(stampPath) && !hadStamp) {
      unlinkSync(stampPath);
    }
  };

  let exitCode = 0;

  try {
    process.stdout.write(`${COLOR.cyan}── verify-parity ──${COLOR.reset}\n`);
    process.stdout.write(`${COLOR.dim}repo: ${repoRoot}${COLOR.reset}\n\n`);

    // ── Step 1: legacy TS path ──
    process.stdout.write(`${COLOR.dim}[1/4] running legacy TS path...${COLOR.reset}\n`);
    const tsResult = runZbbGate(repoRoot, /* useLegacy */ true);
    if (tsResult.exitCode !== 0) {
      process.stderr.write(`${COLOR.red}✗ legacy TS gate failed (exit ${tsResult.exitCode})${COLOR.reset}\n`);
      process.stderr.write(tsResult.stderr);
      return 1;
    }
    if (!existsSync(stampPath)) {
      process.stderr.write(`${COLOR.red}✗ legacy TS gate did not produce gate-stamp.json${COLOR.reset}\n`);
      return 1;
    }
    copyFileSync(stampPath, tsStampPath);
    process.stdout.write(`${COLOR.green}    ✓ legacy stamp saved → ${tsStampPath}${COLOR.reset}\n`);

    // Restore the backup so the next run starts fresh (otherwise the second
    // run might use the first run's stamp file as a starting point)
    restore();
    if (hadStamp) {
      copyFileSync(stampPath, backupPath);
    }

    // ── Step 2: new Gradle path ──
    process.stdout.write(`${COLOR.dim}[2/4] running new Gradle path...${COLOR.reset}\n`);
    const gradleResult = runZbbGate(repoRoot, /* useLegacy */ false);
    if (gradleResult.exitCode !== 0) {
      process.stderr.write(`${COLOR.red}✗ new Gradle gate failed (exit ${gradleResult.exitCode})${COLOR.reset}\n`);
      process.stderr.write(gradleResult.stderr);
      return 1;
    }
    if (!existsSync(stampPath)) {
      process.stderr.write(`${COLOR.red}✗ new Gradle gate did not produce gate-stamp.json${COLOR.reset}\n`);
      return 1;
    }
    copyFileSync(stampPath, gradleStampPath);
    process.stdout.write(`${COLOR.green}    ✓ gradle stamp saved → ${gradleStampPath}${COLOR.reset}\n`);

    // ── Step 3: diff the stamps ──
    process.stdout.write(`${COLOR.dim}[3/4] diffing gate stamps...${COLOR.reset}\n`);
    const stampDrift = diffStamps(tsStampPath, gradleStampPath, options.verbose ?? false);
    if (stampDrift.length === 0) {
      process.stdout.write(`${COLOR.green}    ✓ stamps match (after normalization)${COLOR.reset}\n`);
    } else {
      exitCode = 1;
      process.stdout.write(`${COLOR.red}    ✗ stamps differ:${COLOR.reset}\n`);
      for (const line of stampDrift) {
        process.stdout.write(`      ${line}\n`);
      }
    }

    // ── Step 4: publish parity (optional) ──
    if (!options.gateOnly) {
      process.stdout.write(`${COLOR.dim}[4/4] diffing publish dry-run plans...${COLOR.reset}\n`);
      const publishDrift = diffPublishPlans(repoRoot, options.verbose ?? false);
      if (publishDrift.length === 0) {
        process.stdout.write(`${COLOR.green}    ✓ publish plans match${COLOR.reset}\n`);
      } else {
        exitCode = 1;
        process.stdout.write(`${COLOR.red}    ✗ publish plans differ:${COLOR.reset}\n`);
        for (const line of publishDrift) {
          process.stdout.write(`      ${line}\n`);
        }
      }
    }

    // ── Summary ──
    process.stdout.write('\n');
    if (exitCode === 0) {
      process.stdout.write(`${COLOR.green}✓ parity verified — TS and Gradle paths produce equivalent output${COLOR.reset}\n`);
    } else {
      process.stdout.write(`${COLOR.red}✗ parity check FAILED — see drift above${COLOR.reset}\n`);
      process.stdout.write(`${COLOR.dim}  ts stamp:     ${tsStampPath}${COLOR.reset}\n`);
      process.stdout.write(`${COLOR.dim}  gradle stamp: ${gradleStampPath}${COLOR.reset}\n`);
    }
    return exitCode;
  } finally {
    restore();
  }
}

// ── Spawn helper ──────────────────────────────────────────────────────

interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

function runZbbGate(repoRoot: string, useLegacy: boolean): RunResult {
  const env = { ...process.env };
  if (useLegacy) {
    env.ZBB_USE_LEGACY_MONOREPO = '1';
  } else {
    delete env.ZBB_USE_LEGACY_MONOREPO;
  }

  // Use the same zbb binary that's currently running so verify-parity uses
  // the local source (not the globally-installed version).
  const zbbBin = process.argv[1];

  const result = spawnSync('node', [zbbBin, 'gate', '--all'], {
    cwd: repoRoot,
    env,
    encoding: 'utf-8',
    timeout: 600_000, // 10 min for full gate
  });

  return {
    exitCode: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

function runZbbPublishDryRun(repoRoot: string, useLegacy: boolean): RunResult {
  const env = { ...process.env };
  if (useLegacy) {
    env.ZBB_USE_LEGACY_MONOREPO = '1';
  } else {
    delete env.ZBB_USE_LEGACY_MONOREPO;
  }

  const zbbBin = process.argv[1];
  const result = spawnSync('node', [zbbBin, 'publish', '--dry-run', '--force'], {
    cwd: repoRoot,
    env,
    encoding: 'utf-8',
    timeout: 300_000,
  });

  return {
    exitCode: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

// ── Stamp normalization + diff ────────────────────────────────────────

interface NormalizedStamp {
  version: number;
  packages: Record<string, NormalizedPackageEntry>;
}

interface NormalizedPackageEntry {
  version: string;
  sourceHash: string;
  testHash: string;
  tasks: Record<string, string>;
  tests: Record<string, { expected: number; ran: number; status: string }>;
  rootDeps: Record<string, string> | null;
}

/**
 * Normalize a stamp for byte-equality comparison:
 * - Sort top-level keys + package names + tasks + tests + rootDeps
 * - Strip volatile fields: timestamp, branch
 *
 * Returns the normalized stamp as a string for direct comparison.
 */
function normalizeStamp(stampPath: string): { stamp: NormalizedStamp; serialized: string } {
  const raw = JSON.parse(readFileSync(stampPath, 'utf-8'));

  const normalized: NormalizedStamp = {
    version: raw.version,
    packages: {},
  };

  // Sort packages alphabetically by name
  const pkgNames = Object.keys(raw.packages ?? {}).sort();
  for (const name of pkgNames) {
    const pkg = raw.packages[name];
    normalized.packages[name] = {
      version: pkg.version,
      sourceHash: pkg.sourceHash,
      testHash: pkg.testHash,
      tasks: sortObjectKeys(pkg.tasks ?? {}),
      tests: sortObjectKeys(pkg.tests ?? {}),
      rootDeps: pkg.rootDeps ? sortObjectKeys(pkg.rootDeps) : null,
    };
  }

  return {
    stamp: normalized,
    serialized: JSON.stringify(normalized, null, 2),
  };
}

function sortObjectKeys<T extends Record<string, unknown>>(obj: T): T {
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(obj).sort()) {
    sorted[key] = obj[key];
  }
  return sorted as T;
}

/**
 * Diff two stamps and return a list of human-readable difference messages.
 * Empty list = parity.
 */
function diffStamps(tsPath: string, gradlePath: string, verbose: boolean): string[] {
  const ts = normalizeStamp(tsPath);
  const gradle = normalizeStamp(gradlePath);

  if (ts.serialized === gradle.serialized) {
    return [];
  }

  const drift: string[] = [];

  // Top-level: package count
  const tsPkgs = new Set(Object.keys(ts.stamp.packages));
  const gradlePkgs = new Set(Object.keys(gradle.stamp.packages));

  for (const name of tsPkgs) {
    if (!gradlePkgs.has(name)) {
      drift.push(`${COLOR.red}- ${name}${COLOR.reset} (in TS only)`);
    }
  }
  for (const name of gradlePkgs) {
    if (!tsPkgs.has(name)) {
      drift.push(`${COLOR.green}+ ${name}${COLOR.reset} (in Gradle only)`);
    }
  }

  // Per-package field diffs
  for (const name of tsPkgs) {
    if (!gradlePkgs.has(name)) continue;
    const tsPkg = ts.stamp.packages[name];
    const gradlePkg = gradle.stamp.packages[name];

    if (tsPkg.sourceHash !== gradlePkg.sourceHash) {
      drift.push(`${name}: sourceHash differs`);
      if (verbose) {
        drift.push(`  TS:     ${tsPkg.sourceHash}`);
        drift.push(`  Gradle: ${gradlePkg.sourceHash}`);
      }
    }
    if (tsPkg.testHash !== gradlePkg.testHash) {
      drift.push(`${name}: testHash differs`);
      if (verbose) {
        drift.push(`  TS:     ${tsPkg.testHash}`);
        drift.push(`  Gradle: ${gradlePkg.testHash}`);
      }
    }
    if (JSON.stringify(tsPkg.tasks) !== JSON.stringify(gradlePkg.tasks)) {
      drift.push(`${name}: tasks differ`);
      if (verbose) {
        drift.push(`  TS:     ${JSON.stringify(tsPkg.tasks)}`);
        drift.push(`  Gradle: ${JSON.stringify(gradlePkg.tasks)}`);
      }
    }
    if (JSON.stringify(tsPkg.tests) !== JSON.stringify(gradlePkg.tests)) {
      drift.push(`${name}: tests differ`);
      if (verbose) {
        drift.push(`  TS:     ${JSON.stringify(tsPkg.tests)}`);
        drift.push(`  Gradle: ${JSON.stringify(gradlePkg.tests)}`);
      }
    }
    if (JSON.stringify(tsPkg.rootDeps) !== JSON.stringify(gradlePkg.rootDeps)) {
      drift.push(`${name}: rootDeps differ`);
      if (verbose) {
        drift.push(`  TS:     ${JSON.stringify(tsPkg.rootDeps)}`);
        drift.push(`  Gradle: ${JSON.stringify(gradlePkg.rootDeps)}`);
      }
    }
  }

  return drift;
}

// ── Publish plan diff ─────────────────────────────────────────────────

/**
 * Run publish --dry-run on both paths and diff the would-publish package list.
 */
function diffPublishPlans(repoRoot: string, verbose: boolean): string[] {
  const tsResult = runZbbPublishDryRun(repoRoot, /* useLegacy */ true);
  const gradleResult = runZbbPublishDryRun(repoRoot, /* useLegacy */ false);

  // Extract the package list from each path's output. The output formats
  // differ between the TS path and the Gradle path, so we use loose pattern
  // matching: any line containing "@<scope>/<pkg>" with version/status.
  const tsPkgs = extractPackagesFromPublishOutput(tsResult.stdout + tsResult.stderr);
  const gradlePkgs = extractPackagesFromPublishOutput(gradleResult.stdout + gradleResult.stderr);

  const drift: string[] = [];
  const allPkgs = new Set([...tsPkgs, ...gradlePkgs]);
  for (const pkg of [...allPkgs].sort()) {
    const inTs = tsPkgs.has(pkg);
    const inGradle = gradlePkgs.has(pkg);
    if (inTs && !inGradle) {
      drift.push(`${COLOR.red}- ${pkg}${COLOR.reset} (TS only)`);
    } else if (!inTs && inGradle) {
      drift.push(`${COLOR.green}+ ${pkg}${COLOR.reset} (Gradle only)`);
    }
  }

  if (verbose && drift.length === 0) {
    drift.push(`${COLOR.dim}both paths would publish: ${[...tsPkgs].sort().join(', ') || '(none)'}${COLOR.reset}`);
  }

  return drift;
}

/**
 * Extract package names from publish dry-run output.
 * Looks for lines mentioning "@<scope>/<pkg>" near "publish" or similar.
 */
function extractPackagesFromPublishOutput(output: string): Set<string> {
  const packages = new Set<string>();
  const pkgRegex = /(@[a-z0-9-]+\/[a-z0-9-]+)/gi;
  for (const line of output.split('\n')) {
    // Skip lines that are likely noise (gradle paths, etc.)
    if (line.includes('@zerobias-org/') && !line.includes('publish')) continue;
    let match;
    while ((match = pkgRegex.exec(line)) !== null) {
      const name = match[1];
      // Filter to monorepo packages only (zerobias-com scope)
      if (name.startsWith('@zerobias-com/')) {
        packages.add(name);
      }
    }
  }
  return packages;
}
