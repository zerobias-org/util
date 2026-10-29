import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { parseLifecycleArgs, standardModeOnlyFlags } from '../lib/lifecycle.js';

/**
 * Tests for the lifecycle flag parser shared by the standard and monorepo
 * dispatchers. The flag → gradle property mapping itself is exercised end to
 * end in dispatch.integration.test.ts, against a stub gradlew.
 */

describe('parseLifecycleArgs — --version-committed / --force-direct', () => {
  it('defaults both to false', () => {
    const parsed = parseLifecycleArgs([]);
    assert.equal(parsed.versionCommitted, false);
    assert.equal(parsed.forceDirect, false);
  });

  it('recognizes both and keeps them out of the gradle passthrough', () => {
    const parsed = parseLifecycleArgs(['--version-committed', '--force-direct']);
    assert.equal(parsed.versionCommitted, true);
    assert.equal(parsed.forceDirect, true);
    assert.deepEqual(parsed.remaining, []);
  });

  it('keeps --force and --force-direct apart', () => {
    const force = parseLifecycleArgs(['--force']);
    const forceDirect = parseLifecycleArgs(['--force-direct']);
    assert.deepEqual([force.force, force.forceDirect], [true, false]);
    assert.deepEqual([forceDirect.force, forceDirect.forceDirect], [false, true]);
  });

  it('still forwards every flag it does not recognize, verbatim and in order', () => {
    const parsed = parseLifecycleArgs([
      '-PfooBar=true',
      '--force-direct',
      '--info',
      '--scan',
      '-Pdataloader.force=true',
      '--dry-run',
    ]);
    assert.deepEqual(parsed.remaining, [
      '-PfooBar=true',
      '--info',
      '--scan',
      '-Pdataloader.force=true',
    ]);
    assert.equal(parsed.forceDirect, true);
    assert.equal(parsed.dryRun, true);
    assert.equal(parsed.versionCommitted, false);
  });
});

describe('standardModeOnlyFlags', () => {
  it('lists the standard-mode-only flags present, as typed', () => {
    assert.deepEqual(
      standardModeOnlyFlags(parseLifecycleArgs(['--force-direct', '--version-committed'])),
      ['--version-committed', '--force-direct'],
    );
    assert.deepEqual(standardModeOnlyFlags(parseLifecycleArgs(['--force-direct'])), ['--force-direct']);
  });

  it('is empty for flags both modes support, and for raw -P properties', () => {
    const parsed = parseLifecycleArgs([
      '--dry-run', '--force', '--clean', '--all', '-PversionAlreadyCommitted=true',
    ]);
    assert.deepEqual(standardModeOnlyFlags(parsed), []);
  });
});
