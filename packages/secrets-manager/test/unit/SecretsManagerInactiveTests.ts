/* eslint-disable */
import { expect } from 'chai';
import * as process from 'process';
import { SecretNode } from '../../src/index.js';
import { SecretsManagerImpl } from '../../src/SecretsManagerImpl.js';
import { logger } from '../../src/common.js';

let secrets: SecretsManagerImpl;

describe('SecretsManagerInactiveTests', function () {
  logger.info('Running SecretsManagerInactiveTests Unit Tests...');
  this.timeout(30000);

  before('Setup', async function() {
    process.env.WRITABLE_SECRET = 'awsssm./testing/test';
    process.env.AZURE_SUBSCRIPTION_ID = 'asdca12314';
    process.env.NO_VAULT_RETRY = 'false';
    process.env.HUB_DISABLE_EXTERNAL_PROVIDERS = 'false';
    process.env.FILE_SECRET_ROOT = '/bad/file/path';
    process.env.AWS_ENDPOINT = '0000';
    process.env.VAULT_ADDR = '00000';
    process.env.VAULT_TOKEN = '00000';
    secrets = new SecretsManagerImpl();
    await secrets.init();
  });

  it('should always contain environment secret nodes', async () => {
    const nodes = await secrets.listNodes();
    expect(nodes).to.be.ok;
    expect(nodes.length).to.be.eq(6);
    expect(nodes[0].path).to.be.eq('env');
    expect(nodes[0].type).to.be.eq(SecretNode.TypeEnum.Node);
  });

  it('should list all env vars', async () => {
    const nodes = await secrets.listNodes('env');
    expect(nodes).to.be.ok;
    expect(nodes.length).to.be.gte(1);
  });

  it('should have file secret node in inactive state', async () => {
    const nodes = await secrets.listNodes();
    expect(nodes).to.be.ok;
    expect(nodes.length).to.be.eq(6);
    let fileNode: SecretNode | undefined;
    for (const node of nodes) {
      if (node.path === 'file') {
        fileNode = node;
      }
    }

    expect(fileNode).to.be.not.eq(undefined);
    logger.info(JSON.stringify(fileNode));
    expect(fileNode!.type).to.be.eq(SecretNode.TypeEnum.Node);
    expect(fileNode!.active).to.be.eq(false);
    expect(fileNode!.writable).to.be.eq(false);
    expect(fileNode!.writeSuccess).to.be.eq(false);
    expect(fileNode!.connectError).to.be.eq('FILE_SECRET_NODE path does not exist.');
  });
  
  it('should fail when getting file root', async () => {
    try {
      await secrets.listNodes('file');
    } catch (err: any) {
      expect(err.message).to.include('is inactive');
    }
  });

  it.skip('should have aws secret node in inactive state', async () => {
    const nodes = await secrets.listNodes();
    expect(nodes).to.be.ok;
    expect(nodes.length).to.be.eq(6);
    let awsNode: SecretNode | undefined;
    for (const node of nodes) {
      if (node.path === 'aws') {
        awsNode = node;
      }
    }

    expect(awsNode).to.be.not.eq(undefined);
    logger.info(JSON.stringify(awsNode));
    expect(awsNode!.type).to.be.eq(SecretNode.TypeEnum.Node);
    expect(awsNode!.active).to.be.eq(false);
    expect(awsNode!.writable).to.be.eq(false);
    expect(awsNode!.writeSuccess).to.be.eq(false);
    expect(awsNode!.connectError).to.not.eq(undefined);
  });
  
  it('should fail when getting aws root', async () => {
    try {
      await secrets.listNodes('aws');
    } catch (err: any) {
      expect(err.message).to.include('is inactive');
    }
  });

  it('should have awsssm secret node in inactive state and writable', async () => {
    const nodes = await secrets.listNodes();
    expect(nodes).to.be.ok;
    expect(nodes.length).to.be.eq(6);
    let awsssmNode: SecretNode | undefined;
    for (const node of nodes) {
      if (node.path === 'awsssm') {
        awsssmNode = node;
      }
    }

    expect(awsssmNode).to.be.not.eq(undefined);
    logger.info(JSON.stringify(awsssmNode));
    expect(awsssmNode!.type).to.be.eq(SecretNode.TypeEnum.Node);
    expect(awsssmNode!.active).to.be.eq(false);
    expect(awsssmNode!.writable).to.be.eq(false);
    expect(awsssmNode!.writeSuccess).to.be.eq(false);
    expect(awsssmNode!.connectError).to.not.eq(undefined);
  });
  
  it('should fail when getting awsssm root', async () => {
    try {
      await secrets.listNodes('awsssm');
    } catch (err: any) {
      expect(err.message).to.include('is inactive');
    }
  });

  it.skip('should have vault secret node in inactive state', async () => {
    const nodes = await secrets.listNodes();
    expect(nodes).to.be.ok;
    expect(nodes.length).to.be.eq(6);
    let vaultNode: SecretNode | undefined;
    for (const node of nodes) {
      if (node.path === 'vault') {
        vaultNode = node;
      }
    }

    expect(vaultNode).to.be.not.eq(undefined);
    logger.info(JSON.stringify(vaultNode));
    expect(vaultNode!.type).to.be.eq(SecretNode.TypeEnum.Node);
    expect(vaultNode!.active).to.be.eq(false);
    expect(vaultNode!.writable).to.be.eq(false);
    expect(vaultNode!.writeSuccess).to.be.eq(false);
    expect(vaultNode!.connectError).to.not.eq(undefined);
  });
  
  it('should fail when getting vault root', async () => {
    try {
      await secrets.listNodes('vault');
    } catch (err: any) {
      expect(err.message).to.include('is inactive');
    }
  });

  it('should have azure secret node in inactive state', async () => {
    const nodes = await secrets.listNodes();
    expect(nodes).to.be.ok;
    expect(nodes.length).to.be.eq(6);
    let azureNode: SecretNode | undefined;
    for (const node of nodes) {
      if (node.path === 'azure') {
        azureNode = node;
      }
    }

    expect(azureNode).to.be.not.eq(undefined);
    logger.info(JSON.stringify(azureNode));
    expect(azureNode!.type).to.be.eq(SecretNode.TypeEnum.Node);
    expect(azureNode!.active).to.be.eq(false);
    expect(azureNode!.writable).to.be.eq(false);
    expect(azureNode!.writeSuccess).to.be.eq(false);
    expect(azureNode!.connectError).to.not.eq(undefined);
  });
  
  it('should fail when getting azure root', async () => {
    try {
      await secrets.listNodes('azure');
    } catch (err: any) {
      expect(err.message).to.include('is inactive');
    }
  });

  after('should clean up', async () => {
    // 
  })
});
