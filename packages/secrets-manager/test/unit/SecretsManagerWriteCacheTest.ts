/* eslint-disable */
import { GetParameterCommand, PutParameterCommand } from '@aws-sdk/client-ssm';
import { expect } from 'chai';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import * as process from 'process';
import { SecretNode } from '../../generated/model/index.js';
import { AwsNode } from '../../src/AwsNode.js';
import { AwsSsmNode } from '../../src/AwsSsmNode.js';
import { SecretsManagerImpl } from '../../src/SecretsManagerImpl.js';
import { VaultNode } from '../../src/VaultNode.js';
import { logger } from '../../src/common.js';

let secrets: SecretsManagerImpl;
let secretRoot: string;
let previousSecretRoot: string | undefined;
let previousDisableExternal: string | undefined;
let previousWritableSecret: string | undefined;

// Dummy values only — nothing here is a real secret.
async function seed(name: string, content: Record<string, unknown>): Promise<void> {
  await writeFile(path.join(secretRoot, `${name}.json`), JSON.stringify(content));
}

/**
 * Holds the first backend fetch that waits on it until `release()`, so a test can land a write while
 * that read is in flight. `reached()` resolves once the fetch is being held.
 */
function hold() {
  let markReached!: () => void;
  let release!: () => void;
  const reached = new Promise<void>((resolve) => { markReached = resolve; });
  const released = new Promise<void>((resolve) => { release = resolve; });
  let used = false;
  return {
    wait: async () => {
      if (!used) {
        used = true;
        markReached();
        await released;
      }
    },
    reached: () => reached,
    release: () => release(),
  };
}

describe('SecretsManagerWriteCacheTest', function () {
  logger.info('Running SecretsManagerWriteCacheTest Unit Tests...');
  this.timeout(20000);

  before('Setup', async function() {
    previousSecretRoot = process.env.FILE_SECRET_ROOT;
    previousDisableExternal = process.env.HUB_DISABLE_EXTERNAL_PROVIDERS;
    previousWritableSecret = process.env.WRITABLE_SECRET;
    secretRoot = await mkdtemp(path.join(os.tmpdir(), 'secrets-manager-write-cache-'));
    process.env.HUB_DISABLE_EXTERNAL_PROVIDERS = 'true';
    process.env.FILE_SECRET_ROOT = secretRoot;
    process.env.WRITABLE_SECRET = 'awsssm./dummy/writable';

    secrets = new SecretsManagerImpl();
    await secrets.init();
  });

  it('should read the new values right after an object write at the parent path', async () => {
    await seed('parent', { expiresIn: 3842, marker: 'old' });
    expect(await secrets.getValue('file.parent.expiresIn')).to.be.eq(3842);
    expect(await secrets.getValue('file.parent.marker')).to.be.eq('old');

    await secrets.setValue('file.parent', { expiresIn: 4918, marker: 'new' });

    expect(await secrets.getValue('file.parent.expiresIn')).to.be.eq(4918);
    expect(await secrets.getValue('file.parent.marker')).to.be.eq('new');
  });

  it('should read the new value right after a write at a leaf path', async () => {
    await seed('leaf', { expiresIn: 3842, marker: 'old' });
    expect(await secrets.getValue('file.leaf.expiresIn')).to.be.eq(3842);
    expect(await secrets.getValue('file.leaf.marker')).to.be.eq('old');

    await secrets.setValue('file.leaf.expiresIn', 4918);

    expect(await secrets.getValue('file.leaf.expiresIn')).to.be.eq(4918);
    expect(await secrets.getValue('file.leaf.marker')).to.be.eq('old');
  });

  it('should drop a cached value that a write below it replaced', async () => {
    await seed('above', { state: 'old' });
    expect(await secrets.getValue('file.above.state')).to.be.eq('old');

    // `state` was a leaf; writing below it turns it into an object.
    await secrets.setValue('file.above.state.inner', 'new');

    expect(await secrets.getValue('file.above.state.inner')).to.be.eq('new');
    try {
      await secrets.getValue('file.above.state');
      expect.fail('the cached leaf value should be gone');
    } catch (err: any) {
      expect(err.message).to.include('non-leaf');
    }
  });

  it('should keep serving an unrelated cached value from the cache', async () => {
    await seed('written', { expiresIn: 3842 });
    await seed('written2', { keep: 'cached' });
    await seed('unrelated', { keep: 'cached' });
    expect(await secrets.getValue('file.written.expiresIn')).to.be.eq(3842);
    expect(await secrets.getValue('file.written2.keep')).to.be.eq('cached');
    expect(await secrets.getValue('file.unrelated.keep')).to.be.eq('cached');

    // Change the other files behind the manager's back: a read that still returns 'cached'
    // can only have come from the cache.
    await seed('written2', { keep: 'on-disk' });
    await seed('unrelated', { keep: 'on-disk' });
    await secrets.setValue('file.written', { expiresIn: 4918 });

    expect(await secrets.getValue('file.written.expiresIn')).to.be.eq(4918);
    // `written2` shares a name prefix with the written path but is a different secret.
    expect(await secrets.getValue('file.written2.keep')).to.be.eq('cached');
    expect(await secrets.getValue('file.unrelated.keep')).to.be.eq('cached');
  });

  // The remote providers cannot be reached from a unit test, so the three below run the real node
  // classes over an in-memory stand-in for their client.

  it('should read the new value right after a vault secret write', async () => {
    const store: Record<string, Record<string, unknown>> = {
      written: { expiresIn: 3842 },
      unrelated: { keep: 'cached' },
    };
    const client = {
      listMounts: async () => [{ name: 'kv/' }],
      listSecrets: async () => Object.keys(store),
      getSecret: async (_mount: string, name: string) => ({ data: { ...store[name] } }),
      upsertSecret: async (_mount: string, name: string, json: Record<string, unknown>) => {
        store[name] = json;
      },
    };
    (secrets as any).managers.vault = new VaultNode(client as any, 'vault', SecretNode.TypeEnum.Node);
    expect(await secrets.getValue('vault.kv.written.expiresIn')).to.be.eq(3842);
    expect(await secrets.getValue('vault.kv.unrelated.keep')).to.be.eq('cached');

    store.unrelated = { keep: 'in-backend' };
    await secrets.setValue('vault.kv.written', { expiresIn: 4918 });

    expect(await secrets.getValue('vault.kv.written.expiresIn')).to.be.eq(4918);
    expect(await secrets.getValue('vault.kv.unrelated.keep')).to.be.eq('cached');
  });

  it('should read the new value right after an aws secret write', async () => {
    const store: Record<string, string> = {
      written: JSON.stringify({ expiresIn: 3842 }),
      unrelated: JSON.stringify({ keep: 'cached' }),
    };
    const client = {
      listSecretNames: async () => Object.keys(store),
      getSecretString: async (name: string) => store[name],
      putSecretValue: async (name: string, value: string) => {
        store[name] = value;
      },
    };
    (secrets as any).managers.aws = new AwsNode(client as any, 'aws', SecretNode.TypeEnum.Node);
    expect(await secrets.getValue('aws.written.expiresIn')).to.be.eq(3842);
    expect(await secrets.getValue('aws.unrelated.keep')).to.be.eq('cached');

    store.unrelated = JSON.stringify({ keep: 'in-backend' });
    await secrets.setValue('aws.written', { expiresIn: 4918 });

    expect(await secrets.getValue('aws.written.expiresIn')).to.be.eq(4918);
    expect(await secrets.getValue('aws.unrelated.keep')).to.be.eq('cached');
  });

  it('should read the new value right after an awsssm write under WRITABLE_SECRET', async () => {
    const store: Record<string, string> = {
      '/dummy/writable/object': JSON.stringify({ expiresIn: 3842 }),
      '/dummy/writable/plain': 'old',
    };
    const client = {
      send: async (command: unknown) => {
        if (command instanceof GetParameterCommand) {
          return { Parameter: { Value: store[command.input.Name!] } };
        }
        if (command instanceof PutParameterCommand) {
          store[command.input.Name!] = command.input.Value!;
        }
        return {};
      },
    };
    (secrets as any).managers.awsssm = new AwsSsmNode(client as any, 'awsssm', SecretNode.TypeEnum.Node);
    expect(await secrets.getValue('awsssm./dummy/writable.object.expiresIn')).to.be.eq(3842);
    expect(await secrets.getValue('awsssm./dummy/writable.plain')).to.be.eq('old');

    await secrets.setValue('awsssm./dummy/writable.object', { expiresIn: 4918 });
    await secrets.setValue('awsssm./dummy/writable.plain', 'new');

    expect(await secrets.getValue('awsssm./dummy/writable.object.expiresIn')).to.be.eq(4918);
    expect(await secrets.getValue('awsssm./dummy/writable.plain')).to.be.eq('new');
  });

  it('should expire a value cached on its first read, without holding the process open', async function () {
    const timeoutMs = 1000 * Number(process.env.CACHE_TIMEOUT_SECONDS ?? 300);
    if (timeoutMs > 10_000) {
      this.skip();
    }
    await seed('once', { value: 'old' });
    // A fresh manager, so no timer armed by an earlier test can empty the cache for this one.
    const fresh = new SecretsManagerImpl();
    await fresh.init();
    expect(await fresh.getValue('file.once.value')).to.be.eq('old');
    const timer = (fresh as any).managers.file.cacheTimeoutId;
    expect(timer, 'the first read arms the cache timer').to.not.be.eq(undefined);
    expect(timer.hasRef(), 'the cache timer keeps the process alive').to.be.eq(false);

    // Changed behind the manager's back, so nothing invalidates it: only the timer can.
    await seed('once', { value: 'new' });
    await new Promise((resolve) => setTimeout(resolve, timeoutMs + 1000));

    expect(await fresh.getValue('file.once.value')).to.be.eq('new');
  });

  // A read already in flight when a write lands returns what it fetched, but must not cache it.

  it('should not cache what a vault read fetched before a write landed', async () => {
    const store: Record<string, Record<string, unknown>> = { raced: { expiresIn: 3842 } };
    const held = hold();
    const client = {
      listMounts: async () => [{ name: 'kv/' }],
      listSecrets: async () => Object.keys(store),
      getSecret: async (_mount: string, name: string) => {
        const data = { ...store[name] };
        await held.wait();
        return { data };
      },
      upsertSecret: async (_mount: string, name: string, json: Record<string, unknown>) => {
        store[name] = json;
      },
    };
    (secrets as any).managers.vault = new VaultNode(client as any, 'vault', SecretNode.TypeEnum.Node);

    const read = secrets.getValue('vault.kv.raced.expiresIn');
    await held.reached();
    await secrets.setValue('vault.kv.raced', { expiresIn: 4918 });
    held.release();

    expect(await read).to.be.eq(3842);
    expect(await secrets.getValue('vault.kv.raced.expiresIn')).to.be.eq(4918);
  });

  it('should not cache the aws secret content a read fetched before a write landed', async () => {
    const store: Record<string, string> = { raced: JSON.stringify({ expiresIn: 3842 }) };
    const held = hold();
    const client = {
      listSecretNames: async () => Object.keys(store),
      getSecretString: async (name: string) => {
        const value = store[name];
        await held.wait();
        return value;
      },
      putSecretValue: async (name: string, value: string) => {
        store[name] = value;
      },
    };
    const root = new AwsNode(client as any, 'aws', SecretNode.TypeEnum.Node);
    (secrets as any).managers.aws = root;

    const read = secrets.getValue('aws.raced.expiresIn');
    await held.reached();
    await secrets.setValue('aws.raced', { expiresIn: 4918 });
    held.release();

    expect(await read).to.be.eq(3842);
    // Drop the cached value too: the secret's content cached below the root must be fresh on its own.
    delete root.values['raced.expiresIn'];
    expect(await secrets.getValue('aws.raced.expiresIn')).to.be.eq(4918);
  });

  it('should not cache the awsssm parameter a read fetched before a write landed', async () => {
    const store: Record<string, string> = { '/dummy/writable/raced': JSON.stringify({ expiresIn: 3842 }) };
    const held = hold();
    const client = {
      send: async (command: unknown) => {
        if (command instanceof GetParameterCommand) {
          const value = store[command.input.Name!];
          await held.wait();
          return { Parameter: { Value: value } };
        }
        if (command instanceof PutParameterCommand) {
          store[command.input.Name!] = command.input.Value!;
        }
        return {};
      },
    };
    (secrets as any).managers.awsssm = new AwsSsmNode(client as any, 'awsssm', SecretNode.TypeEnum.Node);

    const read = secrets.getValue('awsssm./dummy/writable.raced.expiresIn');
    await held.reached();
    await secrets.setValue('awsssm./dummy/writable.raced', { expiresIn: 4918 });
    held.release();

    expect(await read).to.be.eq(3842);
    expect(await secrets.getValue('awsssm./dummy/writable.raced.expiresIn')).to.be.eq(4918);
  });

  after('should clean up', async () => {
    if (secretRoot) {
      await rm(secretRoot, { recursive: true, force: true });
    }
    if (previousSecretRoot === undefined) {
      delete process.env.FILE_SECRET_ROOT;
    } else {
      process.env.FILE_SECRET_ROOT = previousSecretRoot;
    }
    if (previousDisableExternal === undefined) {
      delete process.env.HUB_DISABLE_EXTERNAL_PROVIDERS;
    } else {
      process.env.HUB_DISABLE_EXTERNAL_PROVIDERS = previousDisableExternal;
    }
    if (previousWritableSecret === undefined) {
      delete process.env.WRITABLE_SECRET;
    } else {
      process.env.WRITABLE_SECRET = previousWritableSecret;
    }
  });
});
