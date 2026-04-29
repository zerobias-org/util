import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { _deps, getSearchDomain, lookupDnsTxt, resolveDnsEnv } from '../../lib/env/DnsTxtResolver.js';

describe('DnsTxtResolver', () => {

  afterEach(() => {
    mock.restoreAll();
  });

  describe('getSearchDomain', () => {
    it('parses search domain from resolv.conf', () => {
      mock.method(_deps, 'readResolvConf', () =>
        'nameserver 8.8.8.8\nsearch corp.example.com\n'
      );

      const domain = getSearchDomain();
      assert.equal(domain, 'corp.example.com');
    });

    it('returns first domain when multiple search domains listed', () => {
      mock.method(_deps, 'readResolvConf', () =>
        'search first.local second.local third.local\n'
      );

      const domain = getSearchDomain();
      assert.equal(domain, 'first.local');
    });

    it('returns undefined when resolv.conf is missing', () => {
      mock.method(_deps, 'readResolvConf', () => {
        throw new Error('ENOENT');
      });

      const domain = getSearchDomain();
      assert.equal(domain, undefined);
    });

    it('returns undefined when no search line exists', () => {
      mock.method(_deps, 'readResolvConf', () =>
        'nameserver 8.8.8.8\nnameserver 8.8.4.4\n'
      );

      const domain = getSearchDomain();
      assert.equal(domain, undefined);
    });
  });

  describe('lookupDnsTxt', () => {
    it('parses valid KEY=value TXT records', async () => {
      mock.method(_deps, 'readResolvConf', () =>
        'search corp.example.com\n'
      );
      mock.method(_deps, 'resolveTxt', async () => [
        ['SERVER_URL=https://hub.corp.example.com'],
        ['API_KEY=sk_prod_xxxxx'],
      ]);

      const result = await lookupDnsTxt('_hub');
      assert.deepEqual(result, {
        SERVER_URL: 'https://hub.corp.example.com',
        API_KEY: 'sk_prod_xxxxx',
      });
    });

    it('joins multi-string TXT records before parsing', async () => {
      mock.method(_deps, 'readResolvConf', () =>
        'search corp.example.com\n'
      );
      mock.method(_deps, 'resolveTxt', async () => [
        ['SERVER_URL=https://hub.', 'corp.example.com'],
      ]);

      const result = await lookupDnsTxt('_hub');
      assert.deepEqual(result, {
        SERVER_URL: 'https://hub.corp.example.com',
      });
    });

    it('returns undefined when resolv.conf is missing', async () => {
      mock.method(_deps, 'readResolvConf', () => {
        throw new Error('ENOENT');
      });

      const result = await lookupDnsTxt('_hub');
      assert.equal(result, undefined);
    });

    it('returns undefined on DNS lookup failure', async () => {
      mock.method(_deps, 'readResolvConf', () =>
        'search corp.example.com\n'
      );
      mock.method(_deps, 'resolveTxt', async () => {
        throw new Error('ENOTFOUND');
      });

      const result = await lookupDnsTxt('_hub');
      assert.equal(result, undefined);
    });

    it('returns undefined when DNS returns empty results', async () => {
      mock.method(_deps, 'readResolvConf', () =>
        'search corp.example.com\n'
      );
      mock.method(_deps, 'resolveTxt', async () => []);

      const result = await lookupDnsTxt('_hub');
      assert.equal(result, undefined);
    });

    it('skips TXT records without = delimiter', async () => {
      mock.method(_deps, 'readResolvConf', () =>
        'search corp.example.com\n'
      );
      mock.method(_deps, 'resolveTxt', async () => [
        ['no-equals-here'],
        ['VALID=value'],
      ]);

      const result = await lookupDnsTxt('_hub');
      assert.deepEqual(result, { VALID: 'value' });
    });
  });

  describe('resolveDnsEnv', () => {
    it('returns Map of KEY->value pairs from DNS', async () => {
      mock.method(_deps, 'readResolvConf', () =>
        'search corp.example.com\n'
      );
      mock.method(_deps, 'resolveTxt', async () => [
        ['SERVER_URL=https://hub.corp.example.com'],
      ]);

      const result = await resolveDnsEnv('_hub');
      assert.ok(result instanceof Map);
      assert.equal(result.get('SERVER_URL'), 'https://hub.corp.example.com');
    });

    it('returns empty Map when DNS is unavailable', async () => {
      mock.method(_deps, 'readResolvConf', () => {
        throw new Error('ENOENT');
      });

      const result = await resolveDnsEnv('_hub');
      assert.ok(result instanceof Map);
      assert.equal(result.size, 0);
    });
  });
});
