/* eslint-disable */
import { expect } from 'chai';
import { createServer, Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { VaultClient } from '../../src/VaultClient.js';

/**
 * A stand-in Vault. Each approle login mints a monotonically increasing token
 * (`tok-1`, `tok-2`, …). The KV read rejects `tok-1` with 403 to emulate an
 * expired token, and serves data for any later token — so a client that logged
 * in once (and holds `tok-1`) only succeeds if it re-authenticates.
 */
function startFakeVault(): Promise<{ server: Server; url: string; stats: { logins: number } }> {
  const stats = { logins: 0 };
  const server = createServer((req, res) => {
    const token = req.headers['x-vault-token'];
    const json = (code: number, body: unknown) => {
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };

    if (req.method === 'POST' && req.url === '/v1/auth/approle/login') {
      stats.logins += 1;
      return json(200, { auth: { client_token: `tok-${stats.logins}`, lease_duration: 60 } });
    }

    if (req.method === 'GET' && req.url === '/v1/kv/data/good') {
      // tok-1 is the "expired" token minted at connect; anything newer is valid.
      if (token === 'tok-1') return json(403, { errors: ['permission denied'] });
      return json(200, { data: { data: { k: 'v' } } });
    }

    if (req.method === 'GET' && req.url === '/v1/kv/data/boom') {
      return json(500, { errors: ['internal'] });
    }

    return json(404, { errors: [] });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({ server, url: `http://127.0.0.1:${port}`, stats });
    });
  });
}

describe('VaultClient re-authentication', () => {
  let server: Server;
  let url: string;
  let stats: { logins: number };

  beforeEach(async () => {
    ({ server, url, stats } = await startFakeVault());
  });

  afterEach(() => {
    server.close();
  });

  const approle = () => VaultClient.connect({
    method: 'approle', url, roleId: 'r', secretId: 's',
  });

  it('re-authenticates and retries once when the token is rejected with 403', async () => {
    const client = await approle();            // login #1 -> tok-1 (now "expired")
    expect(stats.logins).to.equal(1);

    const secret = await client.getSecret('kv', 'good'); // 403 -> relogin -> tok-2 -> 200
    expect(secret.data).to.deep.equal({ k: 'v' });
    expect(stats.logins).to.equal(2);
  });

  it('collapses concurrent expiries into a single re-login', async () => {
    const client = await approle();            // login #1 -> tok-1
    expect(stats.logins).to.equal(1);

    const results = await Promise.all([
      client.getSecret('kv', 'good'),
      client.getSecret('kv', 'good'),
      client.getSecret('kv', 'good'),
    ]);

    results.forEach((r) => expect(r.data).to.deep.equal({ k: 'v' }));
    // one shared re-login, not three
    expect(stats.logins).to.equal(2);
  });

  it('does not re-authenticate on non-auth errors', async () => {
    const client = await approle();
    expect(stats.logins).to.equal(1);

    let threw = false;
    try {
      await client.getSecret('kv', 'boom');
    } catch {
      threw = true;
    }
    expect(threw, 'getSecret should reject on a 500').to.equal(true);
    expect(stats.logins).to.equal(1);
  });
});
