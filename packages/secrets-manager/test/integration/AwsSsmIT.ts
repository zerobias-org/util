import { DeleteParameterCommand } from '@aws-sdk/client-ssm';
import { expect } from 'chai';
import { SecretsManagerImpl } from '../../src/SecretsManagerImpl.js';
import { ROOT } from '../../src/AwsSsmNode.js';
import { logger } from '../../src/common.js';

let secrets: SecretsManagerImpl;

const jsonPath = `${ROOT}./hub/it/json`;
const strPath = `${ROOT}./hub/it/string`;
const writePath = `${ROOT}./hub/it/write`;
const badWritePath = `${ROOT}.a/hub/it/write`;

describe('AWS SSM Parameter Store', function () {
  this.timeout(30000);

  before('Setup', async function () {
    logger.info('Running AWS SSM Parameter Store Integration Tests...');
    process.env.NO_VAULT_RETRY = 'false';
    process.env.WRITABLE_SECRET = writePath;
    secrets = new SecretsManagerImpl();
    await secrets.init();

    // Skip if AWS SSM provider is not active (no credentials available)
    try {
      const root = await secrets.getRoot('awsssm');
      if (!root.active) {
        logger.info('AWS SSM provider inactive — skipping integration tests');
        return this.skip();
      }
    } catch {
      logger.info('AWS SSM provider unavailable — skipping integration tests');
      return this.skip();
    }

    await new Promise(r => setTimeout(r, 10000));
  });

  it('should validate writable is true and writeSuccess is true', async () => {
    const root = await secrets.getRoot('awsssm');
    expect(root.writable).to.be.true;
    expect(root.writeSuccess).to.be.true;
    expect(root.writeError).to.be.undefined;
  });

  it('should list all parameters at the root', async () => {
    const nodes = await secrets.listNodes(ROOT);
    expect(nodes.length).to.be.gte(2);
  });

  it('should get a string value', async () => {
    const val = await secrets.getValue(strPath);
    expect(val).to.be.eq('foobar');
  });

  it('should fail when getting json top path', async () => {
    try {
      await secrets.getValue(jsonPath);
      expect('Should not have gotten here').to.eq('');
    } catch (err: any) {
      expect(err.message).to.include('Cannot retrieve value from a non-leaf node');
    }
  });

  it('should get a value from a json parameter', async () => {
    const val1 = await secrets.getValue(`${jsonPath}.foo`);
    expect(val1).to.be.eq('bar');
    
    const val2 = await secrets.getValue(`${jsonPath}.hello`);
    expect(val2).to.be.eq('world');
  });

  it('should fail when getting json deeper not secret', async () => {
    try {
      await secrets.getValue(`${jsonPath}.test`);
      expect('Should not have gotten here').to.eq('');
    } catch (err: any) {
      expect(err.message).to.include('No such Node');
    }
  });

  it('should fail when getting json deeper not secret', async () => {
    try {
      await secrets.getValue(`${jsonPath}.test1`);
      expect('Should not have gotten here').to.eq('');
    } catch (err: any) {
      expect(err.message).to.include('Cannot retrieve value from a non-leaf node');
    }
  });

  it('should getting list of nodes for json deeper not secret', async () => {
    const nodes = await secrets.listNodes(`${jsonPath}.test1`);
    expect(nodes.length).to.be.eq(1);
  });

  it('should get a value from a deeper json parameter', async () => {
    const val = await secrets.getValue(`${jsonPath}.test1.test`);
    expect(val).to.be.eq('test');
  });

  it('should write a param', async () => {
    await secrets.setValue(`${writePath}.42.bar`, 'baz');
    let val = await secrets.getValue(`${writePath}.42.bar`);
    expect(val).to.be.eq('baz');

    await secrets.setValue(`${writePath}.42.foo.nest`, 'value');
    val = await secrets.getValue(`${writePath}.42.foo.nest`);
    expect(val).to.be.eq('value');

    val = await secrets.getValue(`${writePath}.42.bar`);
    expect(val).to.be.eq('baz');
  });

  it('should write over param and still get cached value', async () => {
    await secrets.setValue(`${writePath}.42.bar`, 'zab');
    let val = await secrets.getValue(`${writePath}.42.bar`);
    expect(val).to.be.eq('baz');
  });

  it('should wait for cache to clear and see new value', async () => {
    await new Promise(r => setTimeout(r, 5000));
    let val = await secrets.getValue(`${writePath}.42.bar`);
    expect(val).to.be.eq('zab');
  });

  it('should get a string value', async () => {
    const val = await secrets.getValue(strPath);
    expect(val).to.be.eq('foobar');
  });

  after('clean up', async () => {
    try {
      (secrets as any).managers[ROOT].client.send(new DeleteParameterCommand({ Name: '/hub/it/write/42' }));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(`Error deleting writable secret ${writePath}: ${msg}`);
    }
  });
});

describe('AWS SSM Parameter Store Bad Write Path Test', function () {
  this.timeout(30000);

  before('Setup', async function () {
    logger.info('Running AWS SSM Parameter Store Bad Write Path Test...');
    process.env.NO_VAULT_RETRY = 'false';
    process.env.WRITABLE_SECRET = badWritePath;
    secrets = new SecretsManagerImpl();
    await secrets.init();

    // Skip if AWS SSM provider is not active (no credentials available)
    try {
      const root = await secrets.getRoot('awsssm');
      if (!root.active) {
        return this.skip();
      }
    } catch {
      return this.skip();
    }
  });

  it('should validate writable is true and writeSuccess is false', async () => {
    const root = await secrets.getRoot('awsssm');
    expect(root.writable).to.be.true;
    expect(root.writeSuccess).to.be.false;
    expect(root.writeError).to.be.ok;
  });
});
