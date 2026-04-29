/**
 * Shared test helpers for stack tests.
 * Not a .test.ts — won't run standalone.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { stringify as yamlStringify } from 'yaml';

/**
 * Create a minimal slot directory structure for testing.
 */
export async function createTestSlot(
  tmpDir: string,
  options?: { portRange?: [number, number]; name?: string },
): Promise<string> {
  const slotDir = tmpDir;
  const name = options?.name ?? 'test';
  const portRange = options?.portRange ?? [15000, 15099];

  await mkdir(join(slotDir, 'stacks'), { recursive: true });
  await mkdir(join(slotDir, 'config'), { recursive: true });
  await mkdir(join(slotDir, 'logs'), { recursive: true });
  await mkdir(join(slotDir, 'state'), { recursive: true });
  await mkdir(join(slotDir, 'state', 'tmp'), { recursive: true });

  await writeFile(
    join(slotDir, 'slot.yaml'),
    yamlStringify({
      name,
      created: new Date().toISOString(),
      portRange,
    }),
    'utf-8',
  );

  // Write empty slot-level .env and manifest
  await writeFile(join(slotDir, '.env'), '', 'utf-8');
  await writeFile(
    join(slotDir, 'manifest.yaml'),
    yamlStringify({}),
    'utf-8',
  );

  return slotDir;
}

/**
 * Create a mock stack source directory with a zbb.yaml manifest.
 */
export async function createMockStackSource(
  tmpDir: string,
  manifest: Record<string, unknown>,
): Promise<string> {
  await mkdir(tmpDir, { recursive: true });
  // Ensure env declarations exist so StackEnvironment.loadSchema succeeds
  if (!manifest.env) {
    manifest = { ...manifest, env: { _PLACEHOLDER: { type: 'string', default: 'test' } } };
  }
  await writeFile(
    join(tmpDir, 'zbb.yaml'),
    yamlStringify(manifest),
    'utf-8',
  );
  return tmpDir;
}

/**
 * Create a mock dependency stack already "added" to a slot.
 * Writes stack.yaml, manifest.yaml, .env, and state.yaml.
 */
export async function createAddedStack(
  stacksDir: string,
  name: string,
  options: {
    identity?: Record<string, unknown>;
    env?: Record<string, string>;
    manifest?: Record<string, unknown>;
    state?: Record<string, unknown>;
    sourceDir?: string;
  } = {},
): Promise<string> {
  const stackDir = join(stacksDir, name);
  await mkdir(stackDir, { recursive: true });
  await mkdir(join(stackDir, 'logs'), { recursive: true });
  await mkdir(join(stackDir, 'state'), { recursive: true });
  await mkdir(join(stackDir, 'state', 'secrets'), { recursive: true });

  // Determine source dir — create a zbb.yaml with env declarations if none provided
  const sourceDir = options.sourceDir ?? options.identity?.source as string ?? join(stacksDir, `_src-${name}`);
  if (!options.sourceDir && !options.identity?.source) {
    await mkdir(sourceDir, { recursive: true });
    const envDecls: Record<string, unknown> = {};
    for (const key of Object.keys(options.env ?? {})) {
      envDecls[key] = { type: 'string' };
    }
    // Ensure at least one env declaration so loadSchema doesn't fail
    if (Object.keys(envDecls).length === 0) {
      envDecls['_PLACEHOLDER'] = { type: 'string', default: 'test' };
    }
    await writeFile(
      join(sourceDir, 'zbb.yaml'),
      yamlStringify({ name: `@zerobias-com/${name}`, version: '1.0.0', env: envDecls }),
      'utf-8',
    );
  }

  await writeFile(
    join(stackDir, 'stack.yaml'),
    yamlStringify(options.identity ?? {
      name: `@zerobias-com/${name}`,
      version: '1.0.0',
      mode: 'dev',
      source: sourceDir,
      added: new Date().toISOString(),
    }),
    'utf-8',
  );

  // Write .env
  const envLines = Object.entries(options.env ?? {})
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`);
  await writeFile(join(stackDir, '.env'), envLines.join('\n') + '\n', 'utf-8');

  // Write manifest
  await writeFile(
    join(stackDir, 'manifest.yaml'),
    yamlStringify(options.manifest ?? {}),
    'utf-8',
  );

  // Write state
  await writeFile(
    join(stackDir, 'state.yaml'),
    yamlStringify(options.state ?? { status: 'stopped' }),
    'utf-8',
  );

  return stackDir;
}
