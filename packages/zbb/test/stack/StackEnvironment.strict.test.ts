import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { StackEnvironment } from '../../lib/stack/StackEnvironment.js';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'zbb-lockdown-'));
});
afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

// A stack whose zbb.yaml declares only DECLARED_VAR, but whose manifest
// also carries an orphaned user override (ORPHAN_VAR) and a framework slot
// var (ZB_SLOT) — the exact shape that leaked undeclared vars into commands.
async function fixture(): Promise<string> {
  const stackDir = join(tmpDir, 'mystack');
  await mkdir(stackDir, { recursive: true });
  await writeFile(join(stackDir, 'stack.yaml'), `name: "@x/mystack"\nsource: ${stackDir}\n`);
  await writeFile(
    join(stackDir, 'zbb.yaml'),
    'name: "@x/mystack"\nenv:\n  DECLARED_VAR:\n    type: string\n    default: d\n',
  );
  await writeFile(
    join(stackDir, 'manifest.yaml'),
    [
      'DECLARED_VAR:',
      '  resolution: default',
      '  value: d',
      '  source: schema',
      'ORPHAN_VAR:',
      '  resolution: override',
      '  value: leak',
      '  set_by: user',
      'ZB_SLOT:',
      '  resolution: inherited',
      '  value: test',
      '  source: slot',
      '',
    ].join('\n'),
  );
  return stackDir;
}

describe('StackEnvironment lock-down (always on)', () => {
  it('prunes undeclared manifest vars, keeps declared + framework', async () => {
    const stackDir = await fixture();
    const env = new StackEnvironment(stackDir);
    await env.resolve();

    assert.equal(env.get('DECLARED_VAR'), 'd');     // declared in zbb.yaml — kept
    assert.equal(env.get('ZB_SLOT'), 'test');       // framework slot var — kept
    assert.equal(env.get('ORPHAN_VAR'), undefined); // undeclared — PRUNED, unconditionally
  });

  it('refuses env set of an undeclared key', async () => {
    const stackDir = await fixture();
    const env = new StackEnvironment(stackDir);
    await env.resolve();

    await assert.rejects(() => env.set('NOT_DECLARED', 'x'), /not declared in this stack's zbb\.yaml/);
    await env.set('DECLARED_VAR', 'override-ok'); // declared → allowed
    assert.equal(env.get('DECLARED_VAR'), 'override-ok');
  });
});
