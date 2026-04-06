/**
 * CLI handlers for `zbb registry <subcommand>`.
 * Manages the local Verdaccio npm registry stack.
 */

import { resolve as resolvePath, join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { readFile, writeFile, unlink, mkdir, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import type { Slot } from '../slot/Slot.js';

/**
 * Handle `zbb registry <subcommand>` routing.
 */
export async function handleRegistry(args: string[], slot: Slot): Promise<void> {
  const sub = args[0];

  switch (sub) {
    case 'start':
      return handleStart(slot);

    case 'stop':
      return handleStop(slot);

    case 'publish':
      return handlePublish(args.slice(1), slot);

    case 'install':
      return handleInstall(args.slice(1), slot);

    case 'list':
      return handleList(slot);

    case 'clear':
      return handleClear(args.slice(1), slot);

    case 'status':
      return handleStatus(slot);

    default:
      console.error(`Unknown registry command: ${sub ?? '(none)'}`);
      console.error('Usage: zbb registry <start|stop|publish|install|list|clear|status>');
      console.error('');
      console.error('  start              Start the local registry stack');
      console.error('  stop               Stop the local registry stack');
      console.error('  publish [path]     Publish a package to the local registry');
      console.error('  install [stack]    Run npm install with the local registry');
      console.error('  list               List locally published packages');
      console.error('  clear [--all]      Clear locally published packages');
      console.error('  status             Show registry status');
      process.exit(1);
  }
}

// ── Helpers ──────────────────────────────────────────────────

function getRegistryUrl(slot: Slot): string {
  const registryEnvPath = join(slot.path, 'stacks', 'registry', '.env');
  if (existsSync(registryEnvPath)) {
    const content = readFileSync(registryEnvPath, 'utf-8');
    for (const line of content.split('\n')) {
      const match = line.match(/^REGISTRY_URL=(.+)$/);
      if (match) return match[1];
    }
  }

  const slotEnvPath = join(slot.path, '.env');
  if (existsSync(slotEnvPath)) {
    const content = readFileSync(slotEnvPath, 'utf-8');
    for (const line of content.split('\n')) {
      const match = line.match(/^REGISTRY_URL=(.+)$/);
      if (match) return match[1];
    }
  }

  throw new Error(
    'Registry URL not found. Is the registry stack added and started?\n' +
    'Run: zbb registry start',
  );
}

async function isRegistryHealthy(slot: Slot): Promise<boolean> {
  const statePath = join(slot.path, 'stacks', 'registry', 'state.yaml');
  if (!existsSync(statePath)) return false;

  const { loadYamlOrDefault } = await import('../yaml.js');
  const state = await loadYamlOrDefault<Record<string, unknown>>(statePath, {});
  return state.status === 'healthy';
}

function exec(command: string, cwd: string): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn('bash', ['-c', command], {
      cwd,
      env: process.env,
      stdio: ['inherit', 'inherit', 'inherit'],
      detached: false,
    });
    child.on('exit', (code) => resolve(code ?? 1));
  });
}

function execCapture(command: string, cwd: string): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve) => {
    let stdout = '';
    const child = spawn('bash', ['-c', command], {
      cwd,
      env: process.env,
      stdio: ['ignore', 'pipe', 'inherit'],
      detached: false,
    });
    child.stdout!.on('data', (data: Buffer) => { stdout += data.toString(); });
    child.on('exit', (code) => resolve({ code: code ?? 1, stdout }));
  });
}

/**
 * Write a temp .npmrc that routes all scopes to the local registry.
 * npm scoped registry config (from ~/.npmrc) overrides --registry for scoped packages.
 */
async function writeTmpNpmrc(dir: string, registryUrl: string): Promise<string> {
  const tmpNpmrc = join(dir, '.npmrc.zbb');
  await writeFile(tmpNpmrc, [
    `registry=${registryUrl}`,
    `@zerobias-com:registry=${registryUrl}`,
    `@zerobias-org:registry=${registryUrl}`,
    `@auditlogic:registry=${registryUrl}`,
    `@auditmation:registry=${registryUrl}`,
    `@devsupply:registry=${registryUrl}`,
    `//localhost:${new URL(registryUrl).port}/:_authToken=fake-local-token`,
  ].join('\n') + '\n');
  return tmpNpmrc;
}

// ── Publish manifest (tracks what we published locally) ──────

interface PublishEntry {
  name: string;
  version: string;
  publishedAt: string;
}

function publishManifestPath(slot: Slot): string {
  return join(slot.path, 'stacks', 'registry', 'publishes.json');
}

async function getPublishManifest(slot: Slot): Promise<PublishEntry[]> {
  const path = publishManifestPath(slot);
  if (!existsSync(path)) return [];
  try {
    return JSON.parse(await readFile(path, 'utf-8'));
  } catch {
    return [];
  }
}

async function trackPublish(slot: Slot, name: string, version: string): Promise<void> {
  const manifest = await getPublishManifest(slot);
  // Replace existing entry for same package
  const filtered = manifest.filter(e => e.name !== name);
  filtered.push({ name, version, publishedAt: new Date().toISOString() });
  await writeFile(publishManifestPath(slot), JSON.stringify(filtered, null, 2) + '\n');
}

async function clearPublishManifest(slot: Slot): Promise<void> {
  const path = publishManifestPath(slot);
  try { await unlink(path); } catch { /* ignore */ }
}

// ── Start / Stop ─────────────────────────────────────────────

async function handleStart(slot: Slot): Promise<void> {
  const registryDir = join(slot.path, 'stacks', 'registry');
  if (!existsSync(registryDir)) {
    console.log('Adding registry stack...');
    await slot.stacks.add('registry');
  }

  console.log('Starting registry...');
  await slot.stacks.start('registry');
  console.log('Registry started');
}

async function handleStop(slot: Slot): Promise<void> {
  await slot.stacks.stop('registry');
  console.log('Registry stopped');
}

// ── Publish ──────────────────────────────────────────────────

async function handlePublish(args: string[], slot: Slot): Promise<void> {
  const healthy = await isRegistryHealthy(slot);
  if (!healthy) {
    console.error('Registry is not running. Start it first: zbb registry start');
    process.exit(1);
  }

  const registryUrl = getRegistryUrl(slot);
  const targetPath = args[0] ? resolvePath(args[0]) : process.cwd();

  const pkgJsonPath = join(targetPath, 'package.json');
  if (!existsSync(pkgJsonPath)) {
    console.error(`No package.json found at ${targetPath}`);
    process.exit(1);
  }

  const pkgJson = JSON.parse(await readFile(pkgJsonPath, 'utf-8'));
  const { name, version } = pkgJson;

  if (!name || !version) {
    console.error('package.json is missing name or version');
    process.exit(1);
  }

  console.log(`Publishing ${name}@${version} to local registry...`);

  // Build first (if build script exists)
  if (pkgJson.scripts?.build || pkgJson.scripts?.transpile) {
    const buildCmd = pkgJson.scripts.build ? 'npm run build' : 'npm run transpile';
    console.log(`  Building: ${buildCmd}`);
    const buildCode = await exec(buildCmd, targetPath);
    if (buildCode !== 0) {
      console.error('  Build failed');
      process.exit(buildCode);
    }
  }

  // Pack the package
  const { code: packCode, stdout: packOutput } = await execCapture('npm pack --json 2>/dev/null || npm pack', targetPath);
  if (packCode !== 0) {
    console.error('  npm pack failed');
    process.exit(packCode);
  }

  // Find the tarball filename
  let tarballFile = packOutput.trim().split('\n').pop()?.trim() ?? '';
  try {
    const parsed = JSON.parse(packOutput);
    if (Array.isArray(parsed) && parsed[0]?.filename) tarballFile = parsed[0].filename;
  } catch { /* use raw */ }

  const tarballPath = join(targetPath, tarballFile);

  // Repack with publishConfig removed.
  // npm publish reads publishConfig.registry from the tarball's package.json,
  // overriding --registry and --userconfig. We strip it to force local publish.
  const tmpDir = join(targetPath, '.zbb-publish-tmp');
  await mkdir(tmpDir, { recursive: true });

  await exec(`tar xzf "${tarballPath}" -C "${tmpDir}"`, targetPath);
  const innerPkgPath = join(tmpDir, 'package', 'package.json');
  const innerPkg = JSON.parse(await readFile(innerPkgPath, 'utf-8'));
  delete innerPkg.publishConfig;
  await writeFile(innerPkgPath, JSON.stringify(innerPkg, null, 2) + '\n');

  // Repack
  const { stdout: repackOut } = await execCapture('npm pack --json 2>/dev/null || npm pack', join(tmpDir, 'package'));
  let repackTarball = repackOut.trim().split('\n').pop()?.trim() ?? '';
  try {
    const parsed = JSON.parse(repackOut);
    if (Array.isArray(parsed) && parsed[0]?.filename) repackTarball = parsed[0].filename;
  } catch { /* use raw */ }
  const repackPath = join(tmpDir, 'package', repackTarball);

  // Write temp .npmrc to bypass scoped registry config
  const tmpNpmrc = await writeTmpNpmrc(tmpDir, registryUrl);

  // Unpublish cached upstream version first, then publish local copy
  await exec(
    `npm unpublish "${name}@${version}" --userconfig "${tmpNpmrc}" --force 2>/dev/null`,
    join(tmpDir, 'package'),
  );

  const publishCode = await exec(
    `npm publish "${repackPath}" --userconfig "${tmpNpmrc}"`,
    join(tmpDir, 'package'),
  );

  // Clean up
  try { await rm(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  try { await unlink(tarballPath); } catch { /* ignore */ }

  if (publishCode !== 0) {
    console.error(`  Failed to publish ${name}@${version}`);
    process.exit(publishCode);
  }

  await trackPublish(slot, name, version);
  console.log(`Published ${name}@${version} to local registry (${registryUrl})`);
}

// ── Install ──────────────────────────────────────────────────

async function handleInstall(args: string[], slot: Slot): Promise<void> {
  const healthy = await isRegistryHealthy(slot);
  if (!healthy) {
    console.error('Registry is not running. Start it first: zbb registry start');
    process.exit(1);
  }

  const registryUrl = getRegistryUrl(slot);

  let targetPath: string;
  if (args[0]) {
    try {
      const stack = await slot.stacks.load(args[0]);
      targetPath = stack.identity.source || stack.path;
    } catch {
      targetPath = resolvePath(args[0]);
    }
  } else {
    targetPath = process.cwd();
  }

  if (!existsSync(join(targetPath, 'package.json'))) {
    console.error(`No package.json found at ${targetPath}`);
    process.exit(1);
  }

  // npm reads both --userconfig AND the project-level .npmrc in cwd.
  // Project .npmrc often has scoped registries that override our local registry.
  // Temporarily swap the project .npmrc with one that routes everything to Verdaccio.
  const projectNpmrc = join(targetPath, '.npmrc');
  const backupNpmrc = join(targetPath, '.npmrc.zbb-backup');
  const hadProjectNpmrc = existsSync(projectNpmrc);

  if (hadProjectNpmrc) {
    const { rename } = await import('node:fs/promises');
    await rename(projectNpmrc, backupNpmrc);
  }

  await writeTmpNpmrc(targetPath, registryUrl);
  // writeTmpNpmrc writes to .npmrc.zbb — rename to .npmrc so npm picks it up
  const { rename: renameFile } = await import('node:fs/promises');
  await renameFile(join(targetPath, '.npmrc.zbb'), projectNpmrc);

  // Taint locally-published packages in node_modules so npm re-fetches from Verdaccio
  const publishes = await getPublishManifest(slot);
  for (const pkg of publishes) {
    const modDir = join(targetPath, 'node_modules', pkg.name);
    if (existsSync(modDir)) {
      const { rm: rmDir } = await import('node:fs/promises');
      await rmDir(modDir, { recursive: true, force: true });
      console.log(`  Tainted ${pkg.name} (will reinstall from Verdaccio)`);
    }
  }

  console.log(`Running npm install with local registry (${registryUrl})...`);
  const code = await exec(
    `npm install`,
    targetPath,
  );

  // Restore original .npmrc
  try { await unlink(projectNpmrc); } catch { /* ignore */ }
  if (hadProjectNpmrc) {
    await renameFile(backupNpmrc, projectNpmrc);
  }

  if (code !== 0) {
    console.error('npm install failed');
    process.exit(code);
  }

  console.log('Done');
}

// ── List ─────────────────────────────────────────────────────

async function handleList(slot: Slot): Promise<void> {
  const publishes = await getPublishManifest(slot);

  if (publishes.length === 0) {
    console.log('No locally published packages');
    return;
  }

  console.log('Locally published packages:\n');
  const header = '  NAME                                VERSION     PUBLISHED';
  console.log(header);
  for (const pkg of publishes) {
    const n = pkg.name.padEnd(36);
    const v = pkg.version.padEnd(12);
    const t = new Date(pkg.publishedAt).toLocaleString();
    console.log(`  ${n}${v}${t}`);
  }
}

// ── Clear ────────────────────────────────────────────────────

async function handleClear(args: string[], slot: Slot): Promise<void> {
  const clearAll = args.includes('--all');

  if (clearAll) {
    const stackName = slot.env.get('STACK_NAME') ?? slot.name;
    console.log('Clearing all registry data (including upstream cache)...');

    // Taint node_modules and invalidate Gradle stamps before clearing manifest
    const publishes = await getPublishManifest(slot);
    const stacks = await slot.stacks.list();
    const { rm: rmPath, readdir: readdirPath } = await import('node:fs/promises');
    for (const stack of stacks) {
      const srcDir = stack.identity.source;
      if (!srcDir) continue;

      for (const pkg of publishes) {
        const modDir = join(srcDir, 'node_modules', pkg.name);
        if (existsSync(modDir)) {
          await rmPath(modDir, { recursive: true, force: true });
          console.log(`  Tainted ${pkg.name} in ${stack.name}/node_modules`);
        }
      }

      try {
        const entries = await readdirPath(srcDir, { withFileTypes: true });
        for (const entry of entries) {
          if (!entry.isDirectory()) continue;
          const buildDir = join(srcDir, entry.name, 'build');
          if (!existsSync(buildDir)) continue;
          for (const stamp of ['npm-pack.stamp', 'docker-image.stamp']) {
            const stampPath = join(buildDir, stamp);
            if (existsSync(stampPath)) {
              await rmPath(stampPath);
              console.log(`  Invalidated ${stack.name}/${entry.name}/build/${stamp}`);
            }
          }
        }
      } catch { /* ignore */ }
    }

    try { await slot.stacks.stop('registry'); } catch { /* may not be running */ }

    await exec(
      `docker volume rm ${stackName}_verdaccio-storage 2>/dev/null; true`,
      process.cwd(),
    );

    await clearPublishManifest(slot);
    console.log('Cleared all registry data');
    console.log('Run "zbb registry start" to restart with a clean cache');
  } else {
    const healthy = await isRegistryHealthy(slot);
    if (!healthy) {
      console.error('Registry is not running. Start it first, or use --all to clear the volume');
      process.exit(1);
    }

    const registryUrl = getRegistryUrl(slot);
    const publishes = await getPublishManifest(slot);

    if (publishes.length === 0) {
      console.log('No locally published packages to clear');
      return;
    }

    const tmpNpmrc = await writeTmpNpmrc(join(slot.path, 'stacks', 'registry'), registryUrl);

    let cleared = 0;
    for (const pkg of publishes) {
      const code = await exec(
        `npm unpublish "${pkg.name}@${pkg.version}" --userconfig "${tmpNpmrc}" --force 2>/dev/null`,
        process.cwd(),
      );
      if (code === 0) {
        console.log(`  Cleared ${pkg.name}@${pkg.version}`);
        cleared += 1;
      }
    }

    try { await unlink(tmpNpmrc); } catch { /* ignore */ }

    // Taint node_modules and invalidate Gradle stamps in all stack source directories
    // so next build re-fetches from upstream instead of keeping the stale Verdaccio version
    const stacks = await slot.stacks.list();
    const { rm: rmPath, readdir: readdirPath } = await import('node:fs/promises');
    for (const stack of stacks) {
      const srcDir = stack.identity.source;
      if (!srcDir) continue;

      for (const pkg of publishes) {
        const modDir = join(srcDir, 'node_modules', pkg.name);
        if (existsSync(modDir)) {
          await rmPath(modDir, { recursive: true, force: true });
          console.log(`  Tainted ${pkg.name} in ${stack.name}/node_modules`);
        }
      }

      // Invalidate Gradle stamps so next build re-packs and re-builds docker
      try {
        const entries = await readdirPath(srcDir, { withFileTypes: true });
        for (const entry of entries) {
          if (!entry.isDirectory()) continue;
          const buildDir = join(srcDir, entry.name, 'build');
          if (!existsSync(buildDir)) continue;
          for (const stamp of ['npm-pack.stamp', 'docker-image.stamp']) {
            const stampPath = join(buildDir, stamp);
            if (existsSync(stampPath)) {
              await rmPath(stampPath);
              console.log(`  Invalidated ${stack.name}/${entry.name}/build/${stamp}`);
            }
          }
        }
      } catch { /* ignore */ }
    }

    await clearPublishManifest(slot);
    console.log(`Cleared ${cleared} locally published package(s)`);
  }
}

// ── Status ───────────────────────────────────────────────────

async function handleStatus(slot: Slot): Promise<void> {
  const registryDir = join(slot.path, 'stacks', 'registry');
  if (!existsSync(registryDir)) {
    console.log('Registry stack is not added to this slot');
    console.log('Run: zbb registry start');
    return;
  }

  const healthy = await isRegistryHealthy(slot);
  const registryUrl = healthy ? getRegistryUrl(slot) : null;
  const publishes = await getPublishManifest(slot);

  console.log(`Registry:  ${healthy ? 'running' : 'stopped'}`);
  if (registryUrl) {
    console.log(`URL:       ${registryUrl}`);
    console.log(`Web UI:    ${registryUrl}`);
  }
  console.log(`Published: ${publishes.length} package(s)`);

  const npmrcPath = join(registryDir, '.npmrc');
  if (existsSync(npmrcPath)) {
    console.log(`\n.npmrc:    ${npmrcPath}`);
  }
}
