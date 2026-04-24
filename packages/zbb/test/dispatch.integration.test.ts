import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, chmod } from 'node:fs/promises';
import { readFileSync, existsSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

/**
 * End-to-end smoke test for the lifecycle dispatcher's walk-up + scope
 * wiring. We stand up a fake monorepo with a stub `gradlew` that prints
 * its argv to stderr (so stdout is the zbb-logged command line) then
 * run the real compiled `bin/zbb.mjs` from different cwds and inspect
 * the resulting argv.
 *
 * Scenarios:
 *   - cwd = monorepo root      → gradlew args DO NOT include -Pmonorepo.scope
 *   - cwd = workspace pkg      → gradlew args include -Pmonorepo.scope=<pkg-name>
 *   - cwd = nested sub-stack   → dispatch walks up to the monorepo root
 *                                lifecycle.build AND includes scope
 *   - cwd = non-workspace dir  → zbb exits 1 with scope-invalid error
 *   - `zbb publish` in a sub   → zbb exits 1 with publish-subdir-block error
 *
 * We bypass the `loaded slot` preflight by setting ZB_SLOT in the env,
 * and bypass `stack must be added` by giving the slot an empty state —
 * the dispatcher short-circuits at that check. To avoid that, we use
 * `gate --check` which is the slot-less fast path, and for publish we
 * expect to exit at the publish-subdir block BEFORE the slot check.
 */

const here = dirname(fileURLToPath(import.meta.url));
// packages/zbb/test/ → packages/zbb/bin/zbb.mjs
const zbbBin = join(here, '..', 'bin', 'zbb.mjs');

let tmpRoot: string;
let savedCwd: string;

before(() => {
  savedCwd = process.cwd();
});

after(() => {
  process.chdir(savedCwd);
});

beforeEach(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), 'zbb-dispatch-'));

  // Root package.json with workspaces
  await writeFile(
    join(tmpRoot, 'package.json'),
    JSON.stringify({ name: 'mono-root', workspaces: ['packages/*'] }, null, 2),
    'utf-8',
  );

  // Root zbb.yaml with monorepo block + lifecycle
  await writeFile(
    join(tmpRoot, 'zbb.yaml'),
    [
      'name: "@scope/root"',
      'version: "1.0.0"',
      'monorepo:',
      '  sourceDirs: [src]',
      'lifecycle:',
      '  build: ./gradlew monorepoBuild',
      '  gate: ./gradlew monorepoGate',
      '  gateCheck: ./gradlew monorepoGateCheck',
      '  publish: ./gradlew monorepoPublish',
      '',
    ].join('\n'),
    'utf-8',
  );

  // Stub gradlew — prints argv to a marker file we can read after.
  // Using env-var-injected marker path lets each test read its own
  // invocation log without sharing state.
  const stubGradlew = [
    '#!/usr/bin/env bash',
    'echo "$@" >> "$ZBB_TEST_GRADLEW_LOG"',
    'exit 0',
  ].join('\n');
  await writeFile(join(tmpRoot, 'gradlew'), stubGradlew, { mode: 0o755 });
  await chmod(join(tmpRoot, 'gradlew'), 0o755);
  // settings.gradle.kts so findGradleRoot resolves
  await writeFile(join(tmpRoot, 'settings.gradle.kts'), '// stub\n', 'utf-8');

  // Workspace pkg: packages/foo (pure npm, no build.gradle.kts, no zbb.yaml)
  await mkdir(join(tmpRoot, 'packages/foo'), { recursive: true });
  await writeFile(
    join(tmpRoot, 'packages/foo/package.json'),
    JSON.stringify({ name: '@scope/foo' }, null, 2),
    'utf-8',
  );

  // Workspace pkg: packages/bar — has its own zbb.yaml (nested stack)
  // with name but no build lifecycle. Tests walk-up-past-nested-stack.
  await mkdir(join(tmpRoot, 'packages/bar'), { recursive: true });
  await writeFile(
    join(tmpRoot, 'packages/bar/package.json'),
    JSON.stringify({ name: '@scope/bar' }, null, 2),
    'utf-8',
  );
  await writeFile(
    join(tmpRoot, 'packages/bar/zbb.yaml'),
    [
      'name: "@scope/bar"',
      'version: "1.0.0"',
      'lifecycle:',
      '  start: echo start',
      '',
    ].join('\n'),
    'utf-8',
  );
});

afterEach(async () => {
  process.chdir(savedCwd);
  await rm(tmpRoot, { recursive: true, force: true });
});

/** Run zbb with a captured gradlew argv log. Returns {exit, stdout, stderr, gradlewArgv}. */
function runZbb(args: string[], cwd: string): {
  status: number;
  stdout: string;
  stderr: string;
  gradlewArgv: string[];
} {
  const logPath = join(tmpRoot, 'gradlew-argv.log');
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ZBB_TEST_GRADLEW_LOG: logPath,
    // Sanitize — we don't want the user's real ZB_SLOT influencing the
    // dispatch in the middle of a test.
    ZB_SLOT: undefined,
    ZB_STACK: undefined,
    // Skip the TTY display path — we want plain inherited stdio.
    ZBB_FORCE_TTY: '0',
    HOME: homedir(),
  };

  const result = spawnSync('node', [zbbBin, ...args], {
    cwd,
    env,
    encoding: 'utf-8',
    // Short timeout — stub gradlew exits immediately, dispatcher is fast.
    timeout: 30_000,
  });

  let gradlewArgv: string[] = [];
  if (existsSync(logPath)) {
    gradlewArgv = readFileSync(logPath, 'utf-8')
      .trim()
      .split('\n')
      .filter((l: string) => l.length > 0);
  }

  return {
    status: result.status ?? -1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    gradlewArgv,
  };
}

describe('dispatch integration — monorepo scope wiring', () => {
  it('adds NO -Pmonorepo.scope when invoked at the monorepo root', () => {
    const r = runZbb(['gate', '--check'], tmpRoot);
    assert.equal(r.status, 0, `expected exit 0, got ${r.status}. stderr: ${r.stderr}`);
    assert.ok(r.gradlewArgv.length > 0, 'expected gradlew to be invoked');
    assert.ok(!r.gradlewArgv[0].includes('-Pmonorepo.scope'),
      `root invocation should not carry scope flag. argv: ${r.gradlewArgv.join(' | ')}`);
  });

  it('adds -Pmonorepo.scope=<pkg-name> when invoked from a pure-npm workspace package', () => {
    const cwd = join(tmpRoot, 'packages/foo');
    const r = runZbb(['gate', '--check'], cwd);
    assert.equal(r.status, 0, `expected exit 0, got ${r.status}. stderr: ${r.stderr}`);
    assert.ok(r.gradlewArgv[0].includes('-Pmonorepo.scope=@scope/foo'),
      `expected scope flag for @scope/foo. argv: ${r.gradlewArgv[0]}`);
  });

  it('walks past a nested stack zbb.yaml to pick up the monorepo-root lifecycle AND scope', () => {
    const cwd = join(tmpRoot, 'packages/bar');
    const r = runZbb(['gate', '--check'], cwd);
    assert.equal(r.status, 0, `expected exit 0, got ${r.status}. stderr: ${r.stderr}`);
    // bar/zbb.yaml only declares `start`, not `gateCheck` — dispatcher
    // walks up and finds the root's lifecycle.gateCheck.
    assert.ok(r.gradlewArgv[0].includes('monorepoGateCheck'),
      `expected to resolve to monorepoGateCheck from root. argv: ${r.gradlewArgv[0]}`);
    assert.ok(r.gradlewArgv[0].includes('-Pmonorepo.scope=@scope/bar'),
      `expected scope flag for @scope/bar. argv: ${r.gradlewArgv[0]}`);
  });

  it('refuses to dispatch when cwd is not a workspace member', async () => {
    // scripts/ has a package.json but is NOT in the workspaces array.
    await mkdir(join(tmpRoot, 'scripts'), { recursive: true });
    await writeFile(
      join(tmpRoot, 'scripts/package.json'),
      JSON.stringify({ name: '@scope/scripts' }, null, 2),
      'utf-8',
    );
    const r = runZbb(['gate', '--check'], join(tmpRoot, 'scripts'));
    assert.notEqual(r.status, 0, 'expected non-zero exit for non-workspace dir');
    assert.match(r.stderr, /workspace member/);
    assert.equal(r.gradlewArgv.length, 0, 'gradlew should not be invoked');
  });

  it('blocks `zbb publish` from a workspace subpackage', () => {
    // Use `publish` (not `gate --check`) — this hits the publish-subdir
    // block BEFORE the slot preflight, so no ZB_SLOT needed.
    const r = runZbb(['publish'], join(tmpRoot, 'packages/foo'));
    assert.notEqual(r.status, 0, 'publish from subpackage should exit non-zero');
    assert.match(r.stderr, /publish must be run from the monorepo root/);
    assert.equal(r.gradlewArgv.length, 0, 'gradlew should not be invoked for blocked publish');
  });

  it('allows `zbb publish` at the monorepo root (dispatches, reaches slot check)', () => {
    // At the root, publish is not blocked — it proceeds to the slot
    // preflight. Without ZB_SLOT set, it exits 1 with the slot error,
    // NOT the publish-subdir error.
    const r = runZbb(['publish'], tmpRoot);
    assert.notEqual(r.status, 0);
    assert.doesNotMatch(r.stderr, /must be run from the monorepo root/,
      'root publish should not hit the subdir-block error');
    assert.match(r.stderr, /loaded slot/i,
      'root publish should hit the slot preflight');
  });
});
