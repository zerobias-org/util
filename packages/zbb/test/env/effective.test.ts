import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { isSystemBaseVar, applyEffectiveEnv } from '../../lib/env/effective.js';

describe('effective env', () => {
  const saved = { ...process.env };
  afterEach(() => {
    for (const k of Object.keys(process.env)) delete process.env[k];
    Object.assign(process.env, saved);
  });

  const reset = (vars: Record<string, string>) => {
    for (const k of Object.keys(process.env)) delete process.env[k];
    Object.assign(process.env, vars);
  };

  describe('isSystemBaseVar', () => {
    it('passes OS essentials and the LC_ locale family', () => {
      assert.ok(isSystemBaseVar('PATH'));
      assert.ok(isSystemBaseVar('HOME'));
      assert.ok(isSystemBaseVar('SSH_AUTH_SOCK'));
      assert.ok(isSystemBaseVar('LC_ALL'));
      assert.ok(isSystemBaseVar('LC_CTYPE'));
    });

    it('rejects credentials and endpoints — they must be declared', () => {
      assert.ok(!isSystemBaseVar('ZB_TOKEN'));
      assert.ok(!isSystemBaseVar('DATALOADER_SERVICE_URL'));
      assert.ok(!isSystemBaseVar('AWS_ACCESS_KEY_ID'));
      assert.ok(!isSystemBaseVar('NPM_TOKEN'));
    });
  });

  describe('applyEffectiveEnv (hermetic)', () => {
    it('strips undeclared shell vars, keeps base + zbb namespace + passthrough, applies effective', () => {
      reset({
        PATH: '/usr/bin',                                          // system base — keep
        ZBB_NO_DISPLAY: '1',                                       // zbb namespace — keep
        DATALOADER_SERVICE_URL: 'http://localhost:15003/api/dataloader', // the bug: stale leak — strip
        AWS_SECRET: 'leak',                                        // undeclared — strip
        MY_PASSTHROUGH: 'ok',                                      // allowlisted below — keep
      });

      const effective = { ZB_SLOT: 'local', ZB_STACK: 'vendor' };
      const stripped = applyEffectiveEnv(effective, new Set(['MY_PASSTHROUGH']));

      // preserved
      assert.equal(process.env.PATH, '/usr/bin');
      assert.equal(process.env.ZBB_NO_DISPLAY, '1');
      assert.equal(process.env.MY_PASSTHROUGH, 'ok');
      // effective applied
      assert.equal(process.env.ZB_SLOT, 'local');
      assert.equal(process.env.ZB_STACK, 'vendor');
      // the regression we are guarding: a stale managed var must NOT reach a command
      assert.equal(process.env.DATALOADER_SERVICE_URL, undefined);
      assert.equal(process.env.AWS_SECRET, undefined);
      assert.ok(stripped.includes('DATALOADER_SERVICE_URL'));
      assert.ok(stripped.includes('AWS_SECRET'));
    });

    it('effective value wins over a same-named ambient value', () => {
      reset({ PATH: '/usr/bin', ZB_TOKEN: 'stale-shell-token' });
      applyEffectiveEnv({ ZB_TOKEN: 'declared-token' }, new Set());
      assert.equal(process.env.ZB_TOKEN, 'declared-token');
    });

    it('ZBB_HERMETIC=0 falls back to additive-only (no stripping)', () => {
      reset({ ZBB_HERMETIC: '0', LEFTOVER: 'kept' });
      const stripped = applyEffectiveEnv({ ZB_SLOT: 'local' }, new Set());
      assert.equal(process.env.LEFTOVER, 'kept');
      assert.equal(process.env.ZB_SLOT, 'local');
      assert.deepEqual(stripped, []);
    });
  });
});
