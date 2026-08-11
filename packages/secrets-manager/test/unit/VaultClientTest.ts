/* eslint-disable */
import { expect } from 'chai';
import * as process from 'process';
import { isSslStrict } from '../../src/VaultClient.js';

describe('VaultClientTest', () => {
  let original: string | undefined;

  before(() => {
    original = process.env.SSL_STRICT;
  });

  afterEach(() => {
    if (original === undefined) {
      delete process.env.SSL_STRICT;
    } else {
      process.env.SSL_STRICT = original;
    }
  });

  it('should require a trusted CA when SSL_STRICT is unset', async () => {
    delete process.env.SSL_STRICT;
    expect(isSslStrict()).to.equal(true);
  });

  it('should accept self-signed certificates when SSL_STRICT is false', async () => {
    process.env.SSL_STRICT = 'false';
    expect(isSslStrict()).to.equal(false);
  });

  it('should be case and whitespace insensitive', async () => {
    process.env.SSL_STRICT = ' FALSE ';
    expect(isSslStrict()).to.equal(false);
  });

  it('should stay strict for any other value', async () => {
    for (const value of ['true', '0', 'no', '', 'False!']) {
      process.env.SSL_STRICT = value;
      expect(isSslStrict(), `SSL_STRICT=${value}`).to.equal(true);
    }
  });
});
