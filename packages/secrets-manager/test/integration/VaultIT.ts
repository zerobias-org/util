import { expect } from 'chai';

import { SecretsManagerImpl } from '../../src/SecretsManagerImpl.js';
import { ROOT } from '../../src/VaultNode.js';
import { logger } from '../../src/common.js';

let secrets: SecretsManagerImpl;
const writePath = `${ROOT}.dev-kv`;
const badWritePath = `${ROOT}./dev-kv`;

describe('Vault Token', function () {
  this.timeout(30000);

  before('Setup', async function () {
    logger.info('Running HashiCorp Vault Token Integration Tests...');
    process.env.NO_VAULT_RETRY = 'false';
    process.env.WRITABLE_SECRET = writePath;
    secrets = new SecretsManagerImpl();
    await secrets.init();
    await new Promise(r => setTimeout(r, 2000));

    // Skip gracefully if vault is unavailable (missing creds, expired token, etc.)
    try {
      const root = await secrets.getRoot('vault');
      if (!root.active) {
        logger.info('Vault provider inactive — skipping integration tests');
        return this.skip();
      }
    } catch {
      logger.info('Vault provider unavailable — skipping integration tests');
      return this.skip();
    }
  });

  it('should validate writable is true and writeSuccess is true', async () => {
    const root = await secrets.getRoot('vault');
    expect(root.writable).to.be.true;
    expect(root.writeSuccess).to.be.true;
    expect(root.writeError).to.be.undefined;
  });

  it('should list vault root nodes', async () => {
    const nodes = await secrets.listNodes('vault');
    expect(nodes).to.be.ok;
    expect(nodes.length).to.be.gte(1);
  });

  it('should navigate a deep path in Vault', async () => {
    const nodes = await secrets.listNodes('vault.dev-kv.connection');
    expect(nodes).to.be.ok;
    expect(nodes.length).to.be.gte(1);
  });

  it('should navigate a Vault path into a JSON object', async () => {
    const nodes = await secrets.listNodes('vault.dev-kv.connection.amazon');
    expect(nodes).to.be.ok;
    expect(nodes.length).to.be.gte(1);
  });

  it('should set a new secret value at test path and overwrite', async () => {
    const dateTest = new Date().toISOString();
    await secrets.setValue(`${writePath}.zerobias-write-validation`, { 'date': dateTest });
    const val1 = await secrets.getValue(`${writePath}.zerobias-write-validation.date`);
    expect(val1).to.be.eq(dateTest);
  });
});

describe('Vault App Role', function () {
  this.timeout(30000);
  const vaultToken = process.env.VAULT_TOKEN;

  before('Setup', async function () {
    logger.info('Running HashiCorp Vault App Role Integration Tests...');

    // App Role tests require explicit approle credentials. Skip early if
    // not available — the token fallback (~/.vault-token) would connect
    // via token auth which accesses different vault paths.
    if (!process.env.VAULT_ROLE_ID || !process.env.VAULT_SECRET_ID || !process.env.VAULT_ADDR) {
      logger.info('Vault App Role credentials not set — skipping integration tests');
      return this.skip();
    }

    process.env.VAULT_TOKEN = '';
    secrets = new SecretsManagerImpl();
    await secrets.init();
    await new Promise(r => setTimeout(r, 2000));

    try {
      const root = await secrets.getRoot('vault');
      if (!root.active) {
        logger.info('Vault App Role provider inactive — skipping integration tests');
        return this.skip();
      }
    } catch {
      logger.info('Vault App Role provider unavailable — skipping integration tests');
      return this.skip();
    }
  });

  it('should validate writable is true and writeSuccess is true', async () => {
    const root = await secrets.getRoot('vault');
    expect(root.writable).to.be.true;
    expect(root.writeSuccess).to.be.true;
    expect(root.writeError).to.be.undefined;
  });

  it('should list vault root nodes', async () => {
    const nodes = await secrets.listNodes('vault');
    expect(nodes).to.be.ok;
    expect(nodes.length).to.be.gte(1);
  });

  it('should navigate a path in Vault', async () => {
    const nodes = await secrets.listNodes('vault.devsupply.test');
    expect(nodes).to.be.ok;
    expect(nodes.length).to.be.gte(1);
  });

  it('should navigate a deep path in Vault', async () => {
    const nodes = await secrets.listNodes('vault.dev-kv.connection');
    expect(nodes).to.be.ok;
    expect(nodes.length).to.be.gte(1);
  });

  it('should navigate a Vault path into a JSON object', async () => {
    const nodes = await secrets.listNodes('vault.dev-kv.connection.amazon');
    expect(nodes).to.be.ok;
    expect(nodes.length).to.be.gte(1);
  });

  it('should set a new secret value at test path and overwrite', async () => {
    const dateTest = new Date().toISOString();
    await secrets.setValue(`${writePath}.zerobias-write-validation`, { 'date': dateTest });
    const val1 = await secrets.getValue(`${writePath}.zerobias-write-validation.date`);
    expect(val1).to.be.eq(dateTest);
  });

  it('token should expire and reconnect', async () => {
    // wait for the token to expire
    await new Promise(r => setTimeout(r, 20000));

    // force the cache to clear
    (secrets as any).managers.vault.children = {};

    // Should have expired and reconnect
    const nodes = await secrets.listNodes('vault');
    expect(nodes).to.be.ok;
    expect(nodes.length).to.be.gte(1);
  });

  after('clean up', () => {
    process.env.VAULT_TOKEN = vaultToken;
  });
});

describe('Vault Token with bad write path', function () {
  this.timeout(30000);

  before('Setup', async function () {
    logger.info('Running HashiCorp Vault Token Integration Tests...');
    process.env.NO_VAULT_RETRY = 'false';
    process.env.WRITABLE_SECRET = badWritePath;
    secrets = new SecretsManagerImpl();
    await secrets.init();
    await new Promise(r => setTimeout(r, 2000));

    try {
      const root = await secrets.getRoot('vault');
      if (!root.active) {
        logger.info('Vault bad-write-path provider inactive — skipping');
        return this.skip();
      }
    } catch {
      logger.info('Vault bad-write-path provider unavailable — skipping');
      return this.skip();
    }
  });

  it('should validate writable is true and writeSuccess is false', async () => {
    const root = await secrets.getRoot('vault');
    expect(root.writable).to.be.true;
    expect(root.writeSuccess).to.be.false;
    expect(root.writeError).to.be.ok;
  });
});
