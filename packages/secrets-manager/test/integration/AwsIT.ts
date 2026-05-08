import { expect } from 'chai';

import { logger } from '../../src/common.js';
import { SecretsManagerImpl } from '../../src/SecretsManagerImpl.js';

let secrets: SecretsManagerImpl;

const awsTestSecretPath = 'aws.auditmation/node/it';
const writePath = `${awsTestSecretPath}.writable${new Date().getTime()}`;
const writeSecret = writePath.replace('.writable', '/writable').replace('aws.', '');
const badWritePath = `${awsTestSecretPath}.$%writable${new Date().getTime()}`;

describe('Aws Secrets Manager', function () {
  this.timeout(30000);

  before('Setup', async function () {
    logger.info('Running AWS Secrets Manager Integration Tests...');
    process.env.NO_VAULT_RETRY = 'false';
    process.env.WRITABLE_SECRET = awsTestSecretPath;
    secrets = new SecretsManagerImpl();
    await secrets.init();

    // Skip if AWS provider is not active. The env-var presence check that used to
    // wrap these tests was unreliable: in slots that point AWS_ENDPOINT at a local
    // S3 mock (e.g. MinIO), the env vars are present but the provider can't actually
    // talk to AWS Secrets Manager. Mirrors the runtime active-check pattern in
    // AwsSsmIT.ts and AzureIT.ts.
    try {
      const root = await secrets.getRoot('aws');
      if (!root.active) {
        logger.info('AWS Secrets Manager provider inactive — skipping integration tests');
        return this.skip();
      }
    } catch {
      logger.info('AWS Secrets Manager provider unavailable — skipping integration tests');
      return this.skip();
    }
  });

  it('should validate writable is true and write success is true', async () => {
    const root = await secrets.getRoot('aws');
    expect(root.writable).to.be.true;
    expect(root.writeSuccess).to.be.true;
    expect(root.writeError).to.be.undefined;
  });

  it('should list AWS root nodes', async () => {
    const nodes = await secrets.listNodes('aws');
    expect(nodes).to.be.ok;
    expect(nodes.length).to.be.gte(1);
  });

  it('should navigate a deep path in AWS', async () => {
    const nodes = await secrets.listNodes('aws.test/rk');
    expect(nodes).to.be.ok;
    expect(nodes.length).to.be.gte(1);
    expect(nodes[0].writable).to.be.true;
  });

  it('should navigate an AWS path into a JSON object', async () => {
    const nodes = await secrets.listNodes('aws.test/rk.baz');
    expect(nodes).to.be.ok;
    expect(nodes.length).to.be.gte(1);
    expect(nodes[0].writable).to.be.true;
  });

  it('should write a secret value', async () => {
    const value = {
      foo: 'bar',
      baz: { quux: 'quuux' },
    };
    const node = await secrets.setValue(writePath, value);
    const val = await secrets.getValue(`${writePath}.foo`);
    expect(val).to.be.eq('bar');
    expect(node).to.be.ok;
    // expect(node.path).to.be.eq(`aws.${writeSecret}`);

    const nodes = await secrets.listNodes(writePath);
    expect(nodes).to.be.ok;
    expect(nodes.length).to.be.eq(2);

    const fooVal = await secrets.getValue(`${writePath}.foo`);
    expect(fooVal).to.be.eq(value.foo);

    const quuxVal = await secrets.getValue(`${writePath}.baz.quux`);
    expect(quuxVal).to.be.eq(value.baz.quux);
  });

  it('should write a nested secret value', async () => {
    const path = `${writePath}.answer`;
    const node = await secrets.setValue(path, 42);
    expect(node).to.be.ok;
    // expect(node.path).to.be.eq(path);

    const answer = await secrets.getValue(path);
    expect(answer).to.be.eq(42);
  });

  after('should clean up', async () => {
    try {
      if (writePath) {
        const aws = secrets['managers']['aws'];
        if (aws) {
          logger.info(`Cleaing up secret: ${writeSecret}`);
          await aws['secretsManager']['delete'](writeSecret);
        }
      }
    } catch (e) {
      // don't care
    }
  });
});

describe('Aws Secrets Manager Bad Write Path Test', function () {
  this.timeout(30000);

  before('Setup', async function () {
    logger.info('Running Aws Secrets Manager Bad Write Path Test...');
    process.env.NO_VAULT_RETRY = 'false';
    process.env.WRITABLE_SECRET = badWritePath;
    secrets = new SecretsManagerImpl();
    await secrets.init();

    try {
      const root = await secrets.getRoot('aws');
      if (!root.active) return this.skip();
    } catch {
      return this.skip();
    }
  });

  it('should validate writable is true and write success is false', async () => {
    const root = await secrets.getRoot('aws');
    expect(root.writable).to.be.true;
    expect(root.writeSuccess).to.be.false;
    expect(root.writeError).to.be.ok;
  });
});
