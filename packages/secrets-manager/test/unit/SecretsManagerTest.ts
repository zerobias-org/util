/* eslint-disable */
import { UUID } from '@zerobias-org/types-core-js';
import { expect } from 'chai';
import path from 'node:path';
import { rm, writeFile } from 'fs/promises';
import * as process from 'process';
import { SecretNode } from '../../src/index.js';
import { SecretsManagerImpl } from '../../src/SecretsManagerImpl.js';
import { logger } from '../../src/common.js';

let secrets: SecretsManagerImpl;

const tempSecret = {
  foo: 'bar',
  baz: {
    quux: 'quuux'
  },
  zoo: {
    test: {
      test1: 'test1'
    }
  },
};
let tempSecretFile: string;
let tempSecretId: UUID;
let tempSecretPath: string;
let tempSecretFileDoesntExist: string;
let tempSecretIdDoesntExist: UUID;
let tempSecretPathDoesntExist: string;

describe('SecretsManagerTest', function () {
  logger.info('Running SecretsManagerTest Unit Tests...');
  this.timeout(20000);

  before('Setup', async function() {
    process.env.HUB_DISABLE_EXTERNAL_PROVIDERS = 'true';
    process.env.FILE_SECRET_ROOT = process.cwd();
    process.env.WRITABLE_PATH = process.env.FILE_SECRET_ROOT;

    tempSecretId = UUID.generateV4();
    tempSecretFile = path.join(process.cwd(), `${tempSecretId}.json`);
    tempSecretPath = `file.${tempSecretId}`;
    tempSecretIdDoesntExist = UUID.generateV4();
    tempSecretFileDoesntExist = path.join(process.cwd(), `${tempSecretIdDoesntExist}.json`);
    tempSecretPathDoesntExist = `file.${tempSecretIdDoesntExist}`;
    // logger.info('Temporary file path: %s', tempSecretFile);

    secrets = new SecretsManagerImpl();
    await secrets.init();
    // initialize temp file
    await writeFile(tempSecretFile, JSON.stringify(tempSecret));
  });

  it('should always contain environment secret nodes', async () => {
    const nodes = await secrets.listNodes();
    // logger.info(JSON.stringify(nodes));
    expect(nodes).to.be.ok;
    expect(nodes.length).to.be.gte(1);
    expect(nodes[0].path).to.be.eq('env');
    expect(nodes[0].type).to.be.eq(SecretNode.TypeEnum.Node);
  });

  it('should list all env vars', async () => {
    const nodes = await secrets.listNodes('env');
    // logger.info(JSON.stringify(nodes));
    expect(nodes).to.be.ok;
    expect(nodes.length).to.be.gte(1);
  });

  it('should always contain file secret nodes', async () => {
    const nodes = await secrets.listNodes();
    // logger.info(JSON.stringify(nodes));
    expect(nodes).to.be.ok;
    expect(nodes.length).to.be.gte(1);
    expect(nodes[1].path).to.be.eq('file');
    expect(nodes[1].type).to.be.eq(SecretNode.TypeEnum.Node);
  });

  it('should list all root files', async () => {
    const nodes = await secrets.listNodes('file');
    // logger.info(JSON.stringify(nodes));
    expect(nodes).to.be.ok;
    expect(nodes.length).to.be.gte(1);
  });

  it('should read a JSON file', async () => {
    const nodes = await secrets.listNodes(tempSecretPath);
    // logger.info(JSON.stringify(nodes));
    expect(nodes).to.be.ok;
    expect(nodes.length).to.be.eq(3);
  });

  it('should read a value from a JSON file', async () => {
    const value1 = await secrets.getValue(`${tempSecretPath}.foo`);
    expect(value1).to.be.eq(tempSecret.foo);
    const value2 = await secrets.getValue(`${tempSecretPath}.zoo.test.test1`);
    expect(value2).to.be.eq(tempSecret.zoo.test.test1);
  });

  it('should read a value from a JSON file hitting cache', async () => {
    const value1 = await secrets.getValue(`${tempSecretPath}.foo`);
    expect(value1).to.be.eq(tempSecret.foo);
    const value2 = await secrets.getValue(`${tempSecretPath}.zoo.test.test1`);
    expect(value2).to.be.eq(tempSecret.zoo.test.test1);
  });

  it('should write over JSON file with new secret', async () => {
    await secrets.setValue(`${tempSecretPath}`, { test: 'test'});
    const nodes = await secrets.listNodes(tempSecretPath);
    // logger.info(JSON.stringify(nodes));
    expect(nodes).to.be.ok;
    expect(nodes.length).to.be.eq(1);
    const value = await secrets.getValue(`${tempSecretPath}.test`);
    expect(value).to.be.eq('test');
  });

  it('should write new value to a JSON file', async () => {
    await secrets.setValue(`${tempSecretPath}.new`, 'test');
    const value = await secrets.getValue(`${tempSecretPath}.new`);
    expect(value).to.be.eq('test');
  });

  it('should write nested new value to a JSON file', async () => {
    await secrets.setValue(`${tempSecretPath}.new.test1.test2.test3`, 'testing');
    const value = await secrets.getValue(`${tempSecretPath}.new.test1.test2.test3`);
    expect(value).to.be.eq('testing');
  });

  it('should write nested value to a JSON file that doesnt exist', async () => {
    await secrets.setValue(`${tempSecretPathDoesntExist}.new.test1.test2.test3`, 'testing');
    const value = await secrets.getValue(`${tempSecretPathDoesntExist}.new.test1.test2.test3`);
    expect(value).to.be.eq('testing');
  });

  it('should validate cacahed file children and values', async () => {
    const children = (secrets as any).managers.file.children;
    expect(Object.keys(children).length).to.be.greaterThan(0);
    const values = (secrets as any).managers.file.values;
    // logger.info(JSON.stringify(values));
    expect(Object.keys(values).length).to.be.greaterThan(0);
  });

  it('should expire the cache', async () => {
    await new Promise(r => setTimeout(r, 6000));
    const children = (secrets as any).managers.file.children;
    expect(Object.keys(children).length).to.be.equals(0);
    const values = (secrets as any).managers.file.values;
    expect(Object.keys(values).length).to.be.equals(0);
  });

  it('should list all env vars after a cache wipe', async () => {
    const nodes = await secrets.listNodes('env');
    // logger.info(JSON.stringify(nodes));
    expect(nodes).to.be.ok;
    expect(nodes.length).to.be.gte(1);
  });

  after('should clean up', async () => {
    if (tempSecretFile) {
      await rm(tempSecretFile);
      await rm(tempSecretFileDoesntExist);
    }
  });
});
