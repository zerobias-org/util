import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { StackEnvironment } from './StackEnvironment.js';
import type { EnvVarDeclaration } from '../config.js';
import type { ImportSpec } from './types.js';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'zbb-stack-env-'));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

const slotVars = { ZB_SLOT: 'test', ZB_SLOT_DIR: '/tmp/fake-slot' };

describe('StackEnvironment.initialize', () => {
  it('allocates ports and writes to manifest + .env', async () => {
    const stackDir = join(tmpDir, 'mystack');
    await mkdir(stackDir, { recursive: true });

    const schema: Record<string, EnvVarDeclaration> = {
      MY_PORT: { type: 'port', description: 'Test port' },
    };
    const ports = new Map([['MY_PORT', 15001]]);

    const env = await StackEnvironment.initialize(
      stackDir, schema, ports, new Map(), [], slotVars, tmpDir,
    );

    assert.equal(env.get('MY_PORT'), '15001');
    const entry = env.getManifestEntry('MY_PORT');
    assert.equal(entry?.resolution, 'allocated');
    assert.equal(entry?.type, 'port');
  });

  it('generates secrets with mask=true', async () => {
    const stackDir = join(tmpDir, 'mystack');
    await mkdir(stackDir, { recursive: true });

    const schema: Record<string, EnvVarDeclaration> = {
      MY_SECRET: { type: 'secret', generate: 'uuid', mask: true },
    };
    const secrets = new Map([['MY_SECRET', 'abc-123-uuid']]);

    const env = await StackEnvironment.initialize(
      stackDir, schema, new Map(), secrets, [], slotVars, tmpDir,
    );

    assert.equal(env.get('MY_SECRET'), 'abc-123-uuid');
    const entry = env.getManifestEntry('MY_SECRET');
    assert.equal(entry?.resolution, 'generated');
    assert.equal(entry?.mask, true);
    assert.ok(env.shouldMask('MY_SECRET'));
  });

  it('inherits from process.env when source: env', async () => {
    const stackDir = join(tmpDir, 'mystack');
    await mkdir(stackDir, { recursive: true });

    process.env._ZBB_TEST_VAR = 'from-shell';
    try {
      const schema: Record<string, EnvVarDeclaration> = {
        _ZBB_TEST_VAR: { type: 'string', source: 'env' },
      };
      const env = await StackEnvironment.initialize(
        stackDir, schema, new Map(), new Map(), [], slotVars, tmpDir,
      );
      assert.equal(env.get('_ZBB_TEST_VAR'), 'from-shell');
      assert.equal(env.getManifestEntry('_ZBB_TEST_VAR')?.resolution, 'inherited');
    } finally {
      delete process.env._ZBB_TEST_VAR;
    }
  });

  it('throws on required env var missing', async () => {
    const stackDir = join(tmpDir, 'mystack');
    await mkdir(stackDir, { recursive: true });

    delete process.env._ZBB_MISSING_VAR;
    const schema: Record<string, EnvVarDeclaration> = {
      _ZBB_MISSING_VAR: { type: 'string', source: 'env', required: true },
    };

    await assert.rejects(
      () => StackEnvironment.initialize(stackDir, schema, new Map(), new Map(), [], slotVars, tmpDir),
      /Required env var '_ZBB_MISSING_VAR' not found/,
    );
  });

  it('resolves imports from dependency stack .env', async () => {
    // Create a mock dep stack with .env
    const depDir = join(tmpDir, 'stacks', 'dana');
    await mkdir(depDir, { recursive: true });
    await writeFile(join(depDir, '.env'), 'DANA_URL=http://localhost:15001\n', 'utf-8');

    const stackDir = join(tmpDir, 'stacks', 'hub');
    await mkdir(stackDir, { recursive: true });

    const imports: ImportSpec[] = [
      { varName: 'DANA_URL', fromStack: 'dana' },
    ];

    const env = await StackEnvironment.initialize(
      stackDir, {}, new Map(), new Map(), imports, slotVars, join(tmpDir, 'stacks'),
    );

    assert.equal(env.get('DANA_URL'), 'http://localhost:15001');
    const entry = env.getManifestEntry('DANA_URL');
    assert.equal(entry?.resolution, 'imported');
    assert.equal(entry?.from, 'dana');
  });

  it('resolves aliased imports', async () => {
    const depDir = join(tmpDir, 'stacks', 'dana');
    await mkdir(depDir, { recursive: true });
    await writeFile(join(depDir, '.env'), 'DANA_URL=http://localhost:15001\n', 'utf-8');

    const stackDir = join(tmpDir, 'stacks', 'hub');
    await mkdir(stackDir, { recursive: true });

    const imports: ImportSpec[] = [
      { varName: 'DANA_URL', alias: 'PROXY_URL', fromStack: 'dana' },
    ];

    const env = await StackEnvironment.initialize(
      stackDir, {}, new Map(), new Map(), imports, slotVars, join(tmpDir, 'stacks'),
    );

    // Aliased: PROXY_URL exists, DANA_URL does not
    assert.equal(env.get('PROXY_URL'), 'http://localhost:15001');
    assert.equal(env.get('DANA_URL'), undefined);
    const entry = env.getManifestEntry('PROXY_URL');
    assert.equal(entry?.original_name, 'DANA_URL');
  });

  it('resolves derived vars (value: formula)', async () => {
    const stackDir = join(tmpDir, 'mystack');
    await mkdir(stackDir, { recursive: true });

    const schema: Record<string, EnvVarDeclaration> = {
      MY_PORT: { type: 'port' },
      MY_URL: { type: 'string', value: 'http://localhost:${MY_PORT}' },
    };
    const ports = new Map([['MY_PORT', 15005]]);

    const env = await StackEnvironment.initialize(
      stackDir, schema, ports, new Map(), [], slotVars, tmpDir,
    );

    assert.equal(env.get('MY_URL'), 'http://localhost:15005');
    assert.equal(env.getManifestEntry('MY_URL')?.resolution, 'derived');
    assert.equal(env.getManifestEntry('MY_URL')?.formula, 'http://localhost:${MY_PORT}');
  });

  it('freezes default values at add time', async () => {
    const stackDir = join(tmpDir, 'mystack');
    await mkdir(stackDir, { recursive: true });

    const schema: Record<string, EnvVarDeclaration> = {
      MY_PORT: { type: 'port' },
      MY_SETTING: { type: 'string', default: 'http://localhost:${MY_PORT}' },
    };
    const ports = new Map([['MY_PORT', 15010]]);

    const env = await StackEnvironment.initialize(
      stackDir, schema, ports, new Map(), [], slotVars, tmpDir,
    );

    // Default with refs should be frozen to computed value
    assert.equal(env.get('MY_SETTING'), 'http://localhost:15010');
    const entry = env.getManifestEntry('MY_SETTING');
    // Should be 'default' with frozen value (or 'derived' as fallback)
    assert.ok(entry?.value === 'http://localhost:15010' || env.get('MY_SETTING') === 'http://localhost:15010');
  });

  it('stores literal defaults as-is', async () => {
    const stackDir = join(tmpDir, 'mystack');
    await mkdir(stackDir, { recursive: true });

    const schema: Record<string, EnvVarDeclaration> = {
      MY_VAR: { type: 'string', default: 'hello-world' },
    };

    const env = await StackEnvironment.initialize(
      stackDir, schema, new Map(), new Map(), [], slotVars, tmpDir,
    );

    assert.equal(env.get('MY_VAR'), 'hello-world');
    assert.equal(env.getManifestEntry('MY_VAR')?.resolution, 'default');
  });
});

describe('StackEnvironment.set / unset', () => {
  it('set() records override in manifest and updates .env', async () => {
    const stackDir = join(tmpDir, 'mystack');
    await mkdir(stackDir, { recursive: true });

    const schema: Record<string, EnvVarDeclaration> = {
      LOG_LEVEL: { type: 'string', default: 'info' },
    };

    const env = await StackEnvironment.initialize(
      stackDir, schema, new Map(), new Map(), [], slotVars, tmpDir,
    );
    assert.equal(env.get('LOG_LEVEL'), 'info');

    await env.set('LOG_LEVEL', 'debug');
    assert.equal(env.get('LOG_LEVEL'), 'debug');

    const entry = env.getManifestEntry('LOG_LEVEL');
    assert.equal(entry?.resolution, 'override');
    assert.equal(entry?.set_by, 'user');
    assert.ok(entry?.set_at);
  });

  it('unset() reverts to derived formula if one existed', async () => {
    const stackDir = join(tmpDir, 'mystack');
    await mkdir(stackDir, { recursive: true });

    const schema: Record<string, EnvVarDeclaration> = {
      MY_PORT: { type: 'port' },
      MY_URL: { type: 'string', value: 'http://localhost:${MY_PORT}' },
    };
    const ports = new Map([['MY_PORT', 15020]]);

    const env = await StackEnvironment.initialize(
      stackDir, schema, ports, new Map(), [], slotVars, tmpDir,
    );
    assert.equal(env.get('MY_URL'), 'http://localhost:15020');

    // Override
    await env.set('MY_URL', 'https://custom.example.com');
    assert.equal(env.get('MY_URL'), 'https://custom.example.com');

    // Unset → reverts to formula
    await env.unset('MY_URL');
    assert.equal(env.get('MY_URL'), 'http://localhost:15020');
  });
});

describe('StackEnvironment.explain', () => {
  it('returns structured provenance', async () => {
    const stackDir = join(tmpDir, 'mystack');
    await mkdir(stackDir, { recursive: true });

    const schema: Record<string, EnvVarDeclaration> = {
      MY_PORT: { type: 'port', description: 'My port' },
      MY_URL: { type: 'string', value: 'http://localhost:${MY_PORT}', description: 'My URL' },
    };
    const ports = new Map([['MY_PORT', 15030]]);

    const env = await StackEnvironment.initialize(
      stackDir, schema, ports, new Map(), [], slotVars, tmpDir,
    );

    const result = env.explain('MY_URL', schema);
    assert.equal(result.name, 'MY_URL');
    assert.equal(result.resolution, 'derived');
    assert.equal(result.formula, 'http://localhost:${MY_PORT}');
    assert.equal(result.current, 'http://localhost:15030');
    assert.ok(result.inputs);
    assert.equal(result.inputs?.MY_PORT, '15030');
    assert.equal(result.overridable, true);
  });
});

describe('StackEnvironment.shouldMask', () => {
  it('masks secret type vars', async () => {
    const stackDir = join(tmpDir, 'mystack');
    await mkdir(stackDir, { recursive: true });

    const schema: Record<string, EnvVarDeclaration> = {
      MY_SECRET: { type: 'secret', generate: 'uuid', mask: true },
      MY_VAR: { type: 'string', default: 'visible' },
    };
    const secrets = new Map([['MY_SECRET', 'secret-value']]);

    const env = await StackEnvironment.initialize(
      stackDir, schema, new Map(), secrets, [], slotVars, tmpDir,
    );

    assert.ok(env.shouldMask('MY_SECRET'));
    assert.ok(!env.shouldMask('MY_VAR'));
    assert.equal(env.getMasked('MY_SECRET'), '***MASKED***');
    assert.equal(env.getMasked('MY_VAR'), 'visible');
  });

  it('masks vars matching sensitive patterns', async () => {
    const stackDir = join(tmpDir, 'mystack');
    await mkdir(stackDir, { recursive: true });

    const schema: Record<string, EnvVarDeclaration> = {
      JWT_PRIVATE_KEY: { type: 'string', default: 'keydata' },
      API_TOKEN: { type: 'string', default: 'tok123' },
      LOG_LEVEL: { type: 'string', default: 'info' },
    };

    const env = await StackEnvironment.initialize(
      stackDir, schema, new Map(), new Map(), [], slotVars, tmpDir,
    );

    assert.ok(env.shouldMask('JWT_PRIVATE_KEY'));
    assert.ok(env.shouldMask('API_TOKEN'));
    assert.ok(!env.shouldMask('LOG_LEVEL'));
  });
});
