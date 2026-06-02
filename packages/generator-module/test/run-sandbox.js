/**
 * Programmatic test runner: invokes the generator inside test/sandbox with
 * pre-filled prompts. Defaults to --install=true (runs ./gradlew :path:build);
 * set SKIP_BUILD=1 to skip the gradle build.
 *
 * Run: node test/run-sandbox.js
 *
 * The generated module lands at test/sandbox/package/<vendor>/<product>/
 * and is gitignored.
 */

import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import helpers from 'yeoman-test';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const sandbox = path.join(__dirname, 'sandbox');
const generated = path.join(sandbox, 'package');

if (fs.existsSync(generated)) {
  fs.rmSync(generated, { recursive: true, force: true });
}

const runBuild = process.env.SKIP_BUILD !== '1';

try {
  await helpers
    .run(path.join(__dirname, '..', 'app', 'index.js'))
    .cd(sandbox)
    .withOptions({ install: runBuild, skipInstall: !runBuild })
    .withAnswers({
      productPackage: '@zerobias-org/product-github-github',
      modulePackage: '@auditlogic/module-github-github',
      packageVersion: '0.0.0',
      description: 'Sandbox-scaffolded GitHub module for generator-module test',
      repository: 'git@github.com:auditlogic/module.git',
      author: 'team@zerobias.com',
      moduleType: 'connector',
    });

  console.log('✅ Generator ran successfully.');
  console.log(`   Output under: ${generated}/`);
} catch (err) {
  console.error('❌ Generator failed:', err);
  process.exit(1);
}
