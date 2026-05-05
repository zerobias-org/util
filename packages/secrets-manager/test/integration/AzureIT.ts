import { DefaultAzureCredential } from '@azure/identity';
import { SecretClient } from '@azure/keyvault-secrets';
import { expect } from 'chai';

import { SecretsManagerImpl } from '../../src/SecretsManagerImpl.js';
import { logger } from '../../src/common.js';
import { UUID } from '@zerobias-org/types-core-js';

let secrets: SecretsManagerImpl;

describe.skip('Azure Key Vault', function () {
  this.timeout(30000);
  const azureKeyVaultName = 'hub-node-kv';
  const azureKeyVaultPath = `azure.${azureKeyVaultName}`;
  const azureSecretName = Date.now().toString();
  const azureWritePath = `${azureKeyVaultPath}.${azureSecretName}`;

  before('Setup', async () => {
    logger.info('Running Azure Key Vault Integration Tests...');
    process.env.NO_VAULT_RETRY = 'false';
    process.env.AZURE_CLIENT_SECRET = UUID.generateV4().toString();
    secrets = new SecretsManagerImpl();
    await secrets.init();
    logger.info(`we initialized secrets manager: ${JSON.stringify(secrets.getRoot('azure'))}`);
    await new Promise(r => setTimeout(r, 10000));
  });

  it('should validate writable is true and writeSuccess is true', async () => {
    const root = await secrets.getRoot('azure');
    expect(root.writable).to.be.true;
    expect(root.writeSuccess).to.be.true;
    expect(root.writeError).to.be.undefined;
  });

  it('should list the keyvaults', async () => {
    const nodes = await secrets.listNodes('azure');
    expect(nodes).to.be.ok;
    expect(nodes.length).to.be.gte(1);
  });

  it('should navigate a deep path in azure', async () => {
    const nodes = await secrets.listNodes(azureKeyVaultPath);
    expect(nodes).to.be.ok;
    expect(nodes.length).to.be.gte(1);
  });

  it('should navigate an azure path into a value', async () => {
    const value = await secrets.getValue(`${azureKeyVaultPath}.foo`);
    expect(value).to.be.ok;
    expect(value).to.be.eq('bar');
  });

  it('should write a secret value', async () => {
    const newValue = 'testing';
    const node = await secrets.setValue(azureWritePath, newValue);
    expect(node).to.be.ok;
    expect(node.path.split('.')[2]).to.be.eq(azureSecretName);

    const value = await secrets.getValue(`${azureWritePath}`);
    expect(value).to.be.ok;
    expect(value).to.be.eq(newValue);
  });

  after('clean up', async () => {
    const credential = new DefaultAzureCredential();
    const client = new SecretClient(`https://${azureKeyVaultName}.vault.azure.net`, credential);
    await client.beginDeleteSecret(azureSecretName);
  });
});

describe.skip('Azure Key Vault Bad Write Path Test', function () {
  this.timeout(30000);

  before('Setup', async () => {
    logger.info('Running Azure Key Vault Bad Write Path Test...');
    process.env.NO_VAULT_RETRY = 'false';
    // process.env.WRITABLE_SECRET = badWritePath;
    secrets = new SecretsManagerImpl();
    await secrets.init();
  });

  it('should validate writable is true and writeSuccess is false', async () => {
    const root = await secrets.getRoot('azure');
    expect(root.writable).to.be.true;
    expect(root.writeSuccess).to.be.false;
    expect(root.writeError).to.be.ok;
  });
});
