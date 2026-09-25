/* eslint-disable */
import { expect } from 'chai';
import * as process from 'process';
import { SecretsManagerImpl } from '../../src/SecretsManagerImpl.js';
import { logger } from '../../src/common.js';

let secrets: SecretsManagerImpl;

describe('SecretReferenceTest', function () {
  logger.info('Running SecretReferenceTest Unit Tests...');
  this.timeout(20000);

  before('Setup', async function() {
    // Only env + file register, so `vault`/`aws` are deliberately absent: an unregistered first
    // segment is exactly the case this predicate exists to classify.
    process.env.HUB_DISABLE_EXTERNAL_PROVIDERS = 'true';
    process.env.FILE_SECRET_ROOT = process.cwd();
    secrets = new SecretsManagerImpl();
    await secrets.init();
  });

  it('should treat a repository URL as literal data', () => {
    expect(secrets.isSecretReference('https://github.com/owner/repo')).to.be.false;
  });

  it('should treat a value with no delimiter as literal data', () => {
    expect(secrets.isSecretReference('octocat/Hello-World')).to.be.false;
    expect(secrets.isSecretReference('task/ZB-1234-add-thing')).to.be.false;
  });

  it('should treat a bare manager name as literal data', () => {
    // A delimiter is still required — `file` alone addresses no secret.
    expect(secrets.isSecretReference('file')).to.be.false;
  });

  it('should treat an empty value as literal data', () => {
    expect(secrets.isSecretReference('')).to.be.false;
  });

  it('should recognise a path into a registered manager', () => {
    expect(secrets.isSecretReference('env.PATH')).to.be.true;
    expect(secrets.isSecretReference('file.some-secret.field')).to.be.true;
  });

  it('should not recognise a path into an unregistered manager', () => {
    expect(secrets.isSecretReference('valut.typo.field')).to.be.false;
  });

  it('should leave getValue strict — a URL still fails loudly', async () => {
    try {
      await secrets.getValue('https://github.com/owner/repo');
      expect.fail('getValue should not resolve a literal');
    } catch (err: any) {
      expect(err.message).to.include('is inactive');
    }
  });
});
