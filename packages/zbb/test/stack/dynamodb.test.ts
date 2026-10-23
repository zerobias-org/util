import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { parse as yamlParse } from 'yaml';

const stackDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'stacks', 'dynamodb');
const helper = join(stackDir, 'ensure-tables.sh');

/** Run the ensure-tables helper with a minimal env (plus overrides) and capture its result. */
function runHelper(args: string[], env: Record<string, string> = {}) {
  return spawnSync('bash', [helper, ...args], {
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin', ...env },
    encoding: 'utf-8',
  });
}

describe('built-in dynamodb stack manifest', () => {
  it('declares every export and exports no AWS_* vars', async () => {
    const manifest = yamlParse(await readFile(join(stackDir, 'zbb.yaml'), 'utf-8'));
    assert.equal(manifest.name, '@zerobias-com/dynamodb');
    for (const name of manifest.exports) {
      assert.ok(manifest.env[name], `${name} is exported but not declared`);
      assert.ok(!name.startsWith('AWS_'), `${name} would collide with stacks that import AWS_* from minio`);
    }
    assert.ok(manifest.exports.includes('DYNAMODB_ENDPOINT'));
    assert.ok(manifest.exports.includes('DYNAMODB_ENSURE_TABLES'));
  });
});

describe('built-in dynamodb ensure-tables.sh', () => {
  let tmp: string;
  before(async () => { tmp = await mkdtemp(join(tmpdir(), 'zbb-ddb-')); });
  after(async () => { await rm(tmp, { recursive: true, force: true }); });

  it('fails clearly without DYNAMODB_URL', () => {
    const result = runHelper(['tables.json']);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /DYNAMODB_URL is not set/);
  });

  it('rejects a descriptor that is not an array of CreateTable inputs', async () => {
    const file = join(tmp, 'bad.json');
    await writeFile(file, JSON.stringify({ TableName: 'not-an-array' }));
    const result = runHelper([file], { DYNAMODB_URL: 'http://127.0.0.1:9' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /must be a JSON array of CreateTable inputs/);
  });

  it('rejects an unreadable descriptor before contacting DynamoDB', () => {
    const result = runHelper([join(tmp, 'missing.json')], { DYNAMODB_URL: 'http://127.0.0.1:9' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /not readable/);
  });

  it('requires descriptors for --check', () => {
    const result = runHelper(['--check'], { DYNAMODB_URL: 'http://127.0.0.1:9' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /usage: ensure-tables.sh --check/);
  });
});
