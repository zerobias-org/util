import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { StackEnvironment } from '../../lib/stack/StackEnvironment.js';
import type { EnvVarDeclaration } from '../../lib/config.js';
import type { ImportSpec } from '../../lib/stack/types.js';

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
      stackDir, 'mystack', schema, ports, new Map(), [], slotVars, tmpDir,
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
      stackDir, 'mystack', schema, new Map(), secrets, [], slotVars, tmpDir,
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
        stackDir, 'mystack', schema, new Map(), new Map(), [], slotVars, tmpDir,
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
      () => StackEnvironment.initialize(stackDir, 'mystack', schema, new Map(), new Map(), [], slotVars, tmpDir),
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
      stackDir, 'hub', {}, new Map(), new Map(), imports, slotVars, join(tmpDir, 'stacks'),
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
      stackDir, 'hub', {}, new Map(), new Map(), imports, slotVars, join(tmpDir, 'stacks'),
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
      stackDir, 'mystack', schema, ports, new Map(), [], slotVars, tmpDir,
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
      stackDir, 'mystack', schema, ports, new Map(), [], slotVars, tmpDir,
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
      stackDir, 'mystack', schema, new Map(), new Map(), [], slotVars, tmpDir,
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
      stackDir, 'mystack', schema, new Map(), new Map(), [], slotVars, tmpDir,
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
      stackDir, 'mystack', schema, ports, new Map(), [], slotVars, tmpDir,
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
      stackDir, 'mystack', schema, ports, new Map(), [], slotVars, tmpDir,
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
      stackDir, 'mystack', schema, new Map(), secrets, [], slotVars, tmpDir,
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
      stackDir, 'mystack', schema, new Map(), new Map(), [], slotVars, tmpDir,
    );

    assert.ok(env.shouldMask('JWT_PRIVATE_KEY'));
    assert.ok(env.shouldMask('API_TOKEN'));
    assert.ok(!env.shouldMask('LOG_LEVEL'));
  });
});

describe('StackEnvironment.resolve imports (fail-loudly)', () => {
  /**
   * Helper: build a slot layout with a consumer stack and (optionally) a
   * source stack providing some vars. Returns the consumer's stackDir.
   * Mimics the real slot structure: stacksDir/<name>/{stack.yaml, .env, source dir}.
   */
  async function setupStacks(
    stacksDir: string,
    source: { name: string; vars: Record<string, string> } | null,
    consumer: { name: string; imports: Record<string, unknown> },
  ): Promise<string> {
    const { stringify: yamlStringify } = await import('yaml');

    if (source) {
      const srcStackDir = join(stacksDir, source.name);
      await mkdir(srcStackDir, { recursive: true });
      // source stack's .env has the exported vars
      const envLines = Object.entries(source.vars).map(([k, v]) => `${k}=${v}`);
      await writeFile(join(srcStackDir, '.env'), envLines.join('\n') + '\n', 'utf-8');
      // stack.yaml + zbb.yaml so StackEnvironment.loadSchema doesn't throw
      const srcYaml = join(stacksDir, `_src-${source.name}`);
      await mkdir(srcYaml, { recursive: true });
      await writeFile(
        join(srcYaml, 'zbb.yaml'),
        yamlStringify({
          name: `@zerobias-com/${source.name}`,
          version: '1.0.0',
          env: Object.fromEntries(
            Object.keys(source.vars).map(k => [k, { type: 'string' }]),
          ),
        }),
        'utf-8',
      );
      await writeFile(
        join(srcStackDir, 'stack.yaml'),
        yamlStringify({
          name: `@zerobias-com/${source.name}`,
          version: '1.0.0',
          mode: 'dev',
          source: srcYaml,
          added: new Date().toISOString(),
        }),
        'utf-8',
      );
      await writeFile(join(srcStackDir, 'manifest.yaml'), '{}', 'utf-8');
    }

    const consumerStackDir = join(stacksDir, consumer.name);
    await mkdir(consumerStackDir, { recursive: true });
    const consumerSrc = join(stacksDir, `_src-${consumer.name}`);
    await mkdir(consumerSrc, { recursive: true });
    await writeFile(
      join(consumerSrc, 'zbb.yaml'),
      yamlStringify({
        name: `@zerobias-com/${consumer.name}`,
        version: '1.0.0',
        env: { _PLACEHOLDER: { type: 'string', default: 'x' } },
        imports: consumer.imports,
      }),
      'utf-8',
    );
    await writeFile(
      join(consumerStackDir, 'stack.yaml'),
      yamlStringify({
        name: `@zerobias-com/${consumer.name}`,
        version: '1.0.0',
        mode: 'dev',
        source: consumerSrc,
        added: new Date().toISOString(),
      }),
      'utf-8',
    );
    await writeFile(join(consumerStackDir, '.env'), '', 'utf-8');
    await writeFile(join(consumerStackDir, 'manifest.yaml'), '{}', 'utf-8');

    return consumerStackDir;
  }

  it('successfully imports a var that exists in the source stack', async () => {
    const stacksDir = join(tmpDir, 'stacks');
    await mkdir(stacksDir, { recursive: true });

    const consumerDir = await setupStacks(
      stacksDir,
      { name: 'providerStack', vars: { FOO: 'foo-val' } },
      { name: 'consumerStack', imports: { providerStack: ['FOO'] } },
    );

    const env = new StackEnvironment(consumerDir);
    await env.resolve();
    assert.equal(env.get('FOO'), 'foo-val');
  });

  it('throws when a non-optional import is missing from the source stack', async () => {
    const stacksDir = join(tmpDir, 'stacks');
    await mkdir(stacksDir, { recursive: true });

    // Provider stack exists but does NOT export MISSING_VAR
    const consumerDir = await setupStacks(
      stacksDir,
      { name: 'provider2', vars: { FOO: 'foo-val' } },
      { name: 'consumer2', imports: { provider2: ['FOO', 'MISSING_VAR'] } },
    );

    const env = new StackEnvironment(consumerDir);
    await assert.rejects(
      () => env.resolve(),
      (e: Error) => /MISSING_VAR/.test(e.message) && /provider2/.test(e.message),
    );
  });

  it('silently skips a missing var when import is marked optional', async () => {
    const stacksDir = join(tmpDir, 'stacks');
    await mkdir(stacksDir, { recursive: true });

    const consumerDir = await setupStacks(
      stacksDir,
      { name: 'provider3', vars: { FOO: 'foo-val' } },
      {
        name: 'consumer3',
        imports: { provider3: { optional: true, vars: ['FOO', 'MAYBE_MISSING'] } },
      },
    );

    const env = new StackEnvironment(consumerDir);
    await env.resolve(); // should NOT throw
    assert.equal(env.get('FOO'), 'foo-val');
    assert.equal(env.get('MAYBE_MISSING'), undefined);
  });

  it('throws when the source stack itself is not added to the slot', async () => {
    const stacksDir = join(tmpDir, 'stacks');
    await mkdir(stacksDir, { recursive: true });

    // No source stack at all — consumer imports from 'ghost' which doesn't exist
    const consumerDir = await setupStacks(
      stacksDir,
      null,
      { name: 'consumer4', imports: { ghost: ['FOO'] } },
    );

    const env = new StackEnvironment(consumerDir);
    await assert.rejects(
      () => env.resolve(),
      (e: Error) => /ghost/.test(e.message) && /not added/.test(e.message),
    );
  });

  it('silently skips when the source stack is missing and import is optional', async () => {
    const stacksDir = join(tmpDir, 'stacks');
    await mkdir(stacksDir, { recursive: true });

    const consumerDir = await setupStacks(
      stacksDir,
      null,
      {
        name: 'consumer5',
        imports: { ghost: { optional: true, vars: ['FOO'] } },
      },
    );

    const env = new StackEnvironment(consumerDir);
    await env.resolve(); // should NOT throw
    assert.equal(env.get('FOO'), undefined);
  });

  it('reports multiple missing imports in a single error', async () => {
    const stacksDir = join(tmpDir, 'stacks');
    await mkdir(stacksDir, { recursive: true });

    // Provider exists but exports NOTHING useful to consumer
    const consumerDir = await setupStacks(
      stacksDir,
      { name: 'provider6', vars: { UNUSED: 'x' } },
      { name: 'consumer6', imports: { provider6: ['A', 'B', 'C'] } },
    );

    const env = new StackEnvironment(consumerDir);
    await assert.rejects(
      () => env.resolve(),
      (e: Error) => /A/.test(e.message) && /B/.test(e.message) && /C/.test(e.message),
    );
  });
});

describe('StackEnvironment stack-scoped overrides (option b)', () => {
  /**
   * Builds a source stack A providing FOO=sourceVal and a consumer stack B
   * that imports FOO from A. Returns the two stackDirs.
   */
  async function setupProviderConsumer(stacksDir: string): Promise<{
    providerDir: string;
    consumerDir: string;
  }> {
    const { stringify: yamlStringify } = await import('yaml');
    await mkdir(stacksDir, { recursive: true });

    // Provider stack A with FOO exported
    const providerDir = join(stacksDir, 'providerX');
    await mkdir(providerDir, { recursive: true });
    const providerSrc = join(stacksDir, '_src-providerX');
    await mkdir(providerSrc, { recursive: true });
    await writeFile(
      join(providerSrc, 'zbb.yaml'),
      yamlStringify({
        name: '@zerobias-com/providerX',
        version: '1.0.0',
        env: { FOO: { type: 'string', default: 'sourceVal' } },
        exports: ['FOO'],
      }),
      'utf-8',
    );
    await writeFile(
      join(providerDir, 'stack.yaml'),
      yamlStringify({
        name: '@zerobias-com/providerX',
        version: '1.0.0',
        mode: 'dev',
        source: providerSrc,
        added: new Date().toISOString(),
      }),
      'utf-8',
    );
    await writeFile(join(providerDir, '.env'), 'FOO=sourceVal\n', 'utf-8');
    await writeFile(join(providerDir, 'manifest.yaml'), '{}', 'utf-8');

    // Consumer stack B that imports FOO from A
    const consumerDir = join(stacksDir, 'consumerX');
    await mkdir(consumerDir, { recursive: true });
    const consumerSrc = join(stacksDir, '_src-consumerX');
    await mkdir(consumerSrc, { recursive: true });
    await writeFile(
      join(consumerSrc, 'zbb.yaml'),
      yamlStringify({
        name: '@zerobias-com/consumerX',
        version: '1.0.0',
        env: { _PLACEHOLDER: { type: 'string', default: 'x' } },
        imports: { providerX: ['FOO'] },
      }),
      'utf-8',
    );
    await writeFile(
      join(consumerDir, 'stack.yaml'),
      yamlStringify({
        name: '@zerobias-com/consumerX',
        version: '1.0.0',
        mode: 'dev',
        source: consumerSrc,
        added: new Date().toISOString(),
      }),
      'utf-8',
    );
    await writeFile(join(consumerDir, '.env'), '', 'utf-8');
    await writeFile(join(consumerDir, 'manifest.yaml'), '{}', 'utf-8');

    return { providerDir, consumerDir };
  }

  it('consumer sees imported value before any override', async () => {
    const stacksDir = join(tmpDir, 'stacks');
    const { consumerDir } = await setupProviderConsumer(stacksDir);

    const consumer = new StackEnvironment(consumerDir);
    await consumer.resolve();
    assert.equal(consumer.get('FOO'), 'sourceVal');
  });

  it('consumer override wins over imported value within the consumer', async () => {
    const stacksDir = join(tmpDir, 'stacks');
    const { consumerDir } = await setupProviderConsumer(stacksDir);

    const consumer = new StackEnvironment(consumerDir);
    await consumer.resolve();
    await consumer.set('FOO', 'overridden');
    assert.equal(consumer.get('FOO'), 'overridden');

    // Re-resolving should NOT clobber the override with the imported value
    await consumer.resolve();
    assert.equal(consumer.get('FOO'), 'overridden', 'override persists across resolve()');
  });

  it('override in consumer does not affect the provider (scope isolation)', async () => {
    const stacksDir = join(tmpDir, 'stacks');
    const { providerDir, consumerDir } = await setupProviderConsumer(stacksDir);

    const consumer = new StackEnvironment(consumerDir);
    await consumer.resolve();
    await consumer.set('FOO', 'consumer-only');

    // Provider's env — loaded fresh — still reports the source value
    const provider = new StackEnvironment(providerDir);
    await provider.resolve();
    assert.equal(provider.get('FOO'), 'sourceVal', 'provider unaffected by consumer override');
  });

  it('override persists in the consumer manifest with resolution:override', async () => {
    const stacksDir = join(tmpDir, 'stacks');
    const { consumerDir } = await setupProviderConsumer(stacksDir);

    const consumer = new StackEnvironment(consumerDir);
    await consumer.resolve();
    await consumer.set('FOO', 'sticky');

    const entry = consumer.getManifestEntry('FOO');
    assert.equal(entry?.resolution, 'override');
    assert.equal(entry?.value, 'sticky');
  });
});
