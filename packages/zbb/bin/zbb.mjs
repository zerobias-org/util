#!/usr/bin/env node

/**
 * zbb — ZeroBias Build
 *
 * Thin shim that re-execs with --experimental-strip-types to load TypeScript.
 * All logic lives in lib/cli.ts.
 */

import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const cliEntry = join(__dirname, '..', 'lib', 'cli-entry.ts');

try {
  execFileSync(process.execPath, [
    '--experimental-strip-types',
    cliEntry,
    ...process.argv.slice(2),
  ], {
    stdio: 'inherit',
  });
} catch (err) {
  process.exit(err.status ?? 1);
}
