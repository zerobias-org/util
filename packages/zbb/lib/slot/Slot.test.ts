import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Slot, _deps as slotDeps } from './Slot.js';
import { parseYaml } from '../yaml.js';

interface DnsCache {
  prefix: string;
  queried_at: string;
  expires_at: string;
  ttl: number;
  values: Record<string, string>;
}

describe('slot.resolve()', () => {
  let tmpDir: string;
  let slotsDir: string;
  let slotDir: string;
  let slot: Slot;
  let originalLookupDnsTxt: typeof slotDeps.lookupDnsTxt;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'zbb-resolve-test-'));
    slotsDir = join(tmpDir, 'slots');
    await mkdir(slotsDir, { recursive: true });
    slot = new Slot('test-slot', slotsDir);
    slotDir = slot.path;
    await mkdir(slotDir, { recursive: true });
    originalLookupDnsTxt = slotDeps.lookupDnsTxt;
    // Default: DNS returns nothing
    slotDeps.lookupDnsTxt = async (_prefix: string) => undefined;
  });

  afterEach(async () => {
    slotDeps.lookupDnsTxt = originalLookupDnsTxt;
    await rm(tmpDir, { recursive: true, force: true });
  });

  // Test 1 (PROV-01): resolve() queries DNS TXT and merges defaults
  it('PROV-01: queries _hub DNS TXT records and sets values in env with source "dns"', async () => {
    slotDeps.lookupDnsTxt = async (_prefix: string) => ({
      INSTALL_TYPE: 'appliance',
      HUB_SERVER: 'api.uat.zerobias.com/hub',
    });

    await slot.load();
    await slot.resolve();

    assert.equal(slot.env.get('INSTALL_TYPE'), 'appliance');
    assert.equal(slot.env.get('HUB_SERVER'), 'api.uat.zerobias.com/hub');

    const manifestInstall = slot.env.getManifestEntry('INSTALL_TYPE');
    assert.ok(manifestInstall, 'manifest entry for INSTALL_TYPE should exist');
    assert.equal(manifestInstall!.source, 'dns');

    const manifestHub = slot.env.getManifestEntry('HUB_SERVER');
    assert.ok(manifestHub, 'manifest entry for HUB_SERVER should exist');
    assert.equal(manifestHub!.source, 'dns');
  });

  // Test 2 (PROV-03): user-set values are never overwritten by DNS
  it('PROV-03: skips keys where manifest source is "user" or "override"', async () => {
    slotDeps.lookupDnsTxt = async (_prefix: string) => ({
      INSTALL_TYPE: 'appliance',
      USER_VALUE: 'dns-value',
      OVERRIDE_VALUE: 'dns-override-value',
    });

    // Set a user value and an override value before loading
    await writeFile(join(slotDir, '.env'), 'INSTALL_TYPE=custom\n', 'utf-8');
    await writeFile(
      join(slotDir, 'manifest.yaml'),
      'INSTALL_TYPE:\n  source: user\n  type: string\n',
      'utf-8',
    );
    await writeFile(join(slotDir, 'overrides.env'), 'USER_VALUE=user-override\n', 'utf-8');

    await slot.load();

    // Set manifest for USER_VALUE as override source
    const manifestOverride = {
      INSTALL_TYPE: { source: 'user', type: 'string' },
      OVERRIDE_VALUE: { source: 'override', type: 'string' },
    };
    const { saveYaml } = await import('../yaml.js');
    await saveYaml(join(slotDir, 'manifest.yaml'), manifestOverride);

    // Reload to pick up manifest
    await slot.env.load();
    await slot.resolve();

    // user-sourced key should be untouched
    assert.equal(slot.env.get('INSTALL_TYPE'), 'custom', 'user value should not be overwritten');

    // override-sourced key should be untouched
    const overrideEntry = slot.env.getManifestEntry('OVERRIDE_VALUE');
    if (overrideEntry) {
      assert.equal(overrideEntry.source, 'override', 'override source should not be changed to dns');
    }
  });

  // Test 3 (PROV-02): TTL cache on disk prevents re-query
  it('PROV-02: writes dns-cache.yml and skips DNS on second call within TTL', async () => {
    let callCount = 0;
    slotDeps.lookupDnsTxt = async (_prefix: string) => {
      callCount += 1;
      return { INSTALL_TYPE: 'appliance' };
    };

    await slot.load();
    await slot.resolve();

    assert.equal(callCount, 1, 'DNS should be queried on first call');

    // Verify cache file was written
    const cacheContent = await readFile(join(slotDir, 'dns-cache.yml'), 'utf-8');
    const cache = parseYaml<DnsCache>(cacheContent);
    assert.equal(cache.prefix, '_hub');
    assert.ok(cache.queried_at, 'queried_at should be set');
    assert.ok(cache.expires_at, 'expires_at should be set');
    assert.ok(cache.ttl > 0, 'ttl should be positive');
    assert.deepEqual(cache.values, { INSTALL_TYPE: 'appliance' });

    // Second call within TTL should NOT re-query DNS
    await slot.resolve();
    assert.equal(callCount, 1, 'DNS should not be queried again within TTL');
  });

  // Test 4 (PROV-04): idempotency — same DNS produces identical state
  it('PROV-04: calling resolve() twice produces identical env state (idempotent)', async () => {
    slotDeps.lookupDnsTxt = async (_prefix: string) => ({
      INSTALL_TYPE: 'appliance',
      HUB_SERVER: 'api.uat.zerobias.com/hub',
    });

    await slot.load();
    await slot.resolve();

    const stateAfterFirst = { ...slot.env.getAll() };
    const manifestAfterFirst = { ...slot.env.getManifest() };

    // Force cache to expire for second call
    const cacheContent = await readFile(join(slotDir, 'dns-cache.yml'), 'utf-8');
    const cache = parseYaml<DnsCache>(cacheContent);
    cache.expires_at = new Date(Date.now() - 1000).toISOString();
    const { saveYaml } = await import('../yaml.js');
    await saveYaml(join(slotDir, 'dns-cache.yml'), cache);

    await slot.resolve();

    const stateAfterSecond = { ...slot.env.getAll() };
    const manifestAfterSecond = { ...slot.env.getManifest() };

    assert.deepEqual(stateAfterFirst, stateAfterSecond, 'env state should be identical after two resolves');
    assert.deepEqual(manifestAfterFirst, manifestAfterSecond, 'manifest state should be identical after two resolves');
  });

  // Test 5 (PROV-05): DNS failure is silent no-op
  it('PROV-05: DNS timeout or NXDOMAIN does NOT throw — returns silently', async () => {
    slotDeps.lookupDnsTxt = async (_prefix: string) => {
      throw new Error('ENOTFOUND _hub.example.com');
    };

    await slot.load();

    // Must not throw
    await assert.doesNotReject(
      async () => slot.resolve(),
      'resolve() should not throw on DNS failure',
    );
  });

  // Test 6: expired TTL triggers re-query
  it('re-queries DNS when dns-cache.yml TTL has expired', async () => {
    let callCount = 0;
    slotDeps.lookupDnsTxt = async (_prefix: string) => {
      callCount += 1;
      return { INSTALL_TYPE: 'appliance' };
    };

    await slot.load();
    await slot.resolve();

    assert.equal(callCount, 1, 'DNS should be queried on first call');

    // Expire the cache
    const { saveYaml } = await import('../yaml.js');
    await saveYaml(join(slotDir, 'dns-cache.yml'), {
      prefix: '_hub',
      queried_at: new Date(Date.now() - 60000).toISOString(),
      expires_at: new Date(Date.now() - 1000).toISOString(), // expired 1 second ago
      ttl: 30,
      values: { INSTALL_TYPE: 'appliance' },
    });

    await slot.resolve();
    assert.equal(callCount, 2, 'DNS should be re-queried when cache TTL expired');
  });

  // Test 7: fresh slot with no existing env gets all DNS values
  it('fresh slot with no existing env gets all DNS values as defaults', async () => {
    slotDeps.lookupDnsTxt = async (_prefix: string) => ({
      INSTALL_TYPE: 'appliance',
      HUB_SERVER: 'api.uat.zerobias.com/hub',
      REGISTRATION_CODE: 'ABC123',
    });

    await slot.load();
    await slot.resolve();

    assert.equal(slot.env.get('INSTALL_TYPE'), 'appliance');
    assert.equal(slot.env.get('HUB_SERVER'), 'api.uat.zerobias.com/hub');
    assert.equal(slot.env.get('REGISTRATION_CODE'), 'ABC123');

    const manifest = slot.env.getManifest();
    assert.equal(manifest['INSTALL_TYPE']?.source, 'dns');
    assert.equal(manifest['HUB_SERVER']?.source, 'dns');
    assert.equal(manifest['REGISTRATION_CODE']?.source, 'dns');
  });
});
