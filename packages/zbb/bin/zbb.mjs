#!/usr/bin/env node

/**
 * zbb — ZeroBias Build
 *
 * Runs compiled JS from dist/. Build with: npm run build
 */

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const cliEntry = join(__dirname, '..', 'dist', 'cli-entry.js');

import(cliEntry).then(m => m.main(process.argv)).catch(err => {
  console.error(err.message);
  process.exit(1);
});
