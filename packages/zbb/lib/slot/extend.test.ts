import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { extendSlot } from './extend.js';
import { Slot } from './Slot.js';
import { saveYaml } from '../yaml.js';

// Helper: create a fake slot directory with Dana-like env vars already present
async function createFakeSlot(slotsDir: string, name: string, env: Record<string, string>, manifest: Record<string, any>): Promise<Slot> {
  const slotDir = join(slotsDir, name);
  await mkdir(slotDir, { recursive: true });
  await mkdir(join(slotDir, 'config'), { recursive: true });
  await mkdir(join(slotDir, 'logs'), { recursive: true });
  await mkdir(join(slotDir, 'state'), { recursive: true });
  await mkdir(join(slotDir, 'state', 'tmp'), { recursive: true });

  // Write .env
  const envLines = Object.entries(env).map(([k, v]) => `${k}=${v}`).join('\n') + '\n';
  await writeFile(join(slotDir, '.env'), envLines, 'utf-8');

  // Write manifest.yaml
  await saveYaml(join(slotDir, 'manifest.yaml'), manifest);

  // Write slot.yaml
  await saveYaml(join(slotDir, 'slot.yaml'), {
    name,
    created: new Date().toISOString(),
    portRange: [15000, 16000],
  });

  const slot = new Slot(name, slotsDir);
  await slot.load();
  return slot;
}

// Helper: create a mock repoRoot with a .zbb.yaml and a zbb.yaml declaring Hub vars
async function createMockRepoRoot(tmpBase: string): Promise<string> {
  const repoRoot = join(tmpBase, 'mock-repo');
  await mkdir(repoRoot, { recursive: true });

  // .zbb.yaml — repo config (minimal, just ports range)
  await saveYaml(join(repoRoot, '.zbb.yaml'), {
    ports: { range: [15000, 16000] },
  });

  // hub/zbb.yaml — project config with Hub vars
  const hubDir = join(repoRoot, 'hub');
  await mkdir(hubDir, { recursive: true });
  await saveYaml(join(hubDir, 'zbb.yaml'), {
    env: {
      HUB_SERVER_PORT: { type: 'port', description: 'Hub Server host port' },
      HUB_EVENTS_PORT: { type: 'port', description: 'Hub Events host port' },
      HUB_PKG_PROXY_PORT: { type: 'port', description: 'Hub Pkg-Proxy host port' },
      HUB_SERVER_URL: { type: 'string', default: 'http://localhost:${HUB_SERVER_PORT}' },
      SERVER_URL: { type: 'string', default: 'http://localhost:${HUB_SERVER_PORT}' },
      HUB_EVENTS_URL: { type: 'string', default: 'http://localhost:${HUB_EVENTS_PORT}' },
      HUB_PKG_PROXY_URL: { type: 'string', default: 'http://localhost:${HUB_PKG_PROXY_PORT}' },
      INTERNAL_DANA_URL: { type: 'string', default: 'http://dana:3000' },
      HUB_SERVER_IMAGE: { type: 'string', default: 'hub-server:dev' },
      HUB_EVENTS_IMAGE: { type: 'string', default: 'hub-events:dev' },
      HUB_PKG_PROXY_IMAGE: { type: 'string', default: 'hub-pkg-proxy:dev' },
      DANA_COMPOSE_FILE: { type: 'string', default: '' },
    },
  });

  return repoRoot;
}

describe('extendSlot', () => {
  let tmpBase: string;
  let slotsDir: string;
  let repoRoot: string;

  // Dana-like existing env (simulates what slot create would have written)
  const danaEnv: Record<string, string> = {
    ZB_SLOT: 'test-slot',
    ZB_SLOT_DIR: '/tmp/fake',
    PGPORT: '15000',
    POSTGRES_PORT: '15000',
    DANA_PORT: '15001',
    NGINX_HTTP_PORT: '15002',
    NGINX_HTTPS_PORT: '15003',
    PGHOST: 'localhost',
    PGUSER: 'postgres',
    PGPASSWORD: 'fakepw',
    PGDATABASE: 'zerobias',
  };

  const danaManifest: Record<string, any> = {
    ZB_SLOT: { source: 'zbb', type: 'slot' },
    ZB_SLOT_DIR: { source: 'zbb', type: 'slot' },
    PGPORT: { source: 'dana/zbb.yaml', type: 'port', allocated: 15000 },
    POSTGRES_PORT: { source: 'dana/zbb.yaml', type: 'string', derived: true },
    DANA_PORT: { source: 'dana/zbb.yaml', type: 'port', allocated: 15001 },
    NGINX_HTTP_PORT: { source: 'dana/zbb.yaml', type: 'port', allocated: 15002 },
    NGINX_HTTPS_PORT: { source: 'dana/zbb.yaml', type: 'port', allocated: 15003 },
    PGHOST: { source: 'dana/zbb.yaml', type: 'string' },
    PGUSER: { source: 'dana/zbb.yaml', type: 'string' },
    PGPASSWORD: { source: 'dana/zbb.yaml', type: 'secret', mask: true },
    PGDATABASE: { source: 'dana/zbb.yaml', type: 'string' },
  };

  beforeEach(async () => {
    tmpBase = await mkdtemp(join(tmpdir(), 'zbb-extend-test-'));
    slotsDir = join(tmpBase, 'slots');
    await mkdir(slotsDir, { recursive: true });
    repoRoot = await createMockRepoRoot(tmpBase);
  });

  afterEach(async () => {
    await rm(tmpBase, { recursive: true, force: true });
  });

  it('adds Hub port vars to a Dana-only slot', async () => {
    const slot = await createFakeSlot(slotsDir, 'test-slot', danaEnv, danaManifest);
    const result = await extendSlot(slot, repoRoot);

    assert.equal(result.extended, true);
    assert.ok(result.addedVars.includes('HUB_SERVER_PORT'), 'should add HUB_SERVER_PORT');
    assert.ok(result.addedVars.includes('HUB_EVENTS_PORT'), 'should add HUB_EVENTS_PORT');
    assert.ok(result.addedVars.includes('HUB_PKG_PROXY_PORT'), 'should add HUB_PKG_PROXY_PORT');

    // Verify ports are numbers in range
    const env = slot.env.getAll();
    const hubServerPort = parseInt(env.HUB_SERVER_PORT, 10);
    const hubEventsPort = parseInt(env.HUB_EVENTS_PORT, 10);
    const hubPkgProxyPort = parseInt(env.HUB_PKG_PROXY_PORT, 10);
    assert.ok(hubServerPort >= 15000 && hubServerPort <= 16000, `HUB_SERVER_PORT ${hubServerPort} in range`);
    assert.ok(hubEventsPort >= 15000 && hubEventsPort <= 16000, `HUB_EVENTS_PORT ${hubEventsPort} in range`);
    assert.ok(hubPkgProxyPort >= 15000 && hubPkgProxyPort <= 16000, `HUB_PKG_PROXY_PORT ${hubPkgProxyPort} in range`);

    // Ports should not collide with existing Dana ports
    const existingPorts = [15000, 15001, 15002, 15003];
    assert.ok(!existingPorts.includes(hubServerPort), 'HUB_SERVER_PORT should not collide');
    assert.ok(!existingPorts.includes(hubEventsPort), 'HUB_EVENTS_PORT should not collide');
    assert.ok(!existingPorts.includes(hubPkgProxyPort), 'HUB_PKG_PROXY_PORT should not collide');
  });

  it('is a no-op when Hub vars already present', async () => {
    // First extend
    const slot = await createFakeSlot(slotsDir, 'test-slot', danaEnv, danaManifest);
    await extendSlot(slot, repoRoot);

    // Second extend should be no-op
    const result = await extendSlot(slot, repoRoot);
    assert.equal(result.extended, false);
    assert.deepEqual(result.addedVars, []);
  });

  it('resolves derived vars correctly', async () => {
    const slot = await createFakeSlot(slotsDir, 'test-slot', danaEnv, danaManifest);
    await extendSlot(slot, repoRoot);

    const env = slot.env.getAll();
    const hubServerPort = env.HUB_SERVER_PORT;
    const hubEventsPort = env.HUB_EVENTS_PORT;
    const hubPkgProxyPort = env.HUB_PKG_PROXY_PORT;

    assert.equal(env.HUB_SERVER_URL, `http://localhost:${hubServerPort}`);
    assert.equal(env.SERVER_URL, `http://localhost:${hubServerPort}`);
    assert.equal(env.HUB_EVENTS_URL, `http://localhost:${hubEventsPort}`);
    assert.equal(env.HUB_PKG_PROXY_URL, `http://localhost:${hubPkgProxyPort}`);
  });

  it('never overwrites existing vars', async () => {
    const slot = await createFakeSlot(slotsDir, 'test-slot', danaEnv, danaManifest);
    await extendSlot(slot, repoRoot);

    const env = slot.env.getAll();
    // Dana vars should be unchanged
    assert.equal(env.PGPORT, '15000');
    assert.equal(env.DANA_PORT, '15001');
    assert.equal(env.PGHOST, 'localhost');
    assert.equal(env.PGUSER, 'postgres');
    assert.equal(env.PGPASSWORD, 'fakepw');
  });

  it('appendDeclaredEnv merges into existing .env without destroying content', async () => {
    const slot = await createFakeSlot(slotsDir, 'test-slot', danaEnv, danaManifest);
    await extendSlot(slot, repoRoot);

    // Read the raw .env file and verify Dana vars are still there
    const envContent = await readFile(join(slotsDir, 'test-slot', '.env'), 'utf-8');
    assert.ok(envContent.includes('PGPORT=15000'), '.env should still have PGPORT');
    assert.ok(envContent.includes('DANA_PORT=15001'), '.env should still have DANA_PORT');
    assert.ok(envContent.includes('HUB_SERVER_PORT='), '.env should have new HUB_SERVER_PORT');
    assert.ok(envContent.includes('HUB_SERVER_URL='), '.env should have new HUB_SERVER_URL');
  });
});
