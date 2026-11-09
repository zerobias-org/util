import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  applyZbEnvNpm, clearZbEnvNpm, isZbEnvDefaultValue, keepsAmbientOverZbEnvDefault, normalizeLockfileHosts,
  normalizeRepoLockfiles, overlayZbEnv, parseZbEnv, renderZbEnvNpmrc, zbEnvDefaults, zbEnvNpmEnv, zbEnvWatchedKeys,
} from '../../lib/env/zbEnv.js';

const ci = parseZbEnv('ci')!;
const prod = parseZbEnv('prod')!;

describe('parseZbEnv', () => {
  it('maps each environment to its registry host and platform origin', () => {
    assert.deepEqual(
      ['prod', 'uat', 'qa', 'ci'].map(n => [parseZbEnv(n)!.registryHost, parseZbEnv(n)!.platformOrigin]),
      [
        ['pkg.zerobias.org', 'https://app.zerobias.com'],
        ['uat.pkg.zerobias.org', 'https://uat.zerobias.com'],
        ['qa.pkg.zerobias.org', 'https://qa.zerobias.com'],
        ['ci.pkg.zerobias.org', 'https://ci.zerobias.com'],
      ],
    );
  });

  it('accepts dev for ci and ignores case and whitespace', () => {
    assert.equal(parseZbEnv(' Dev ')!.name, 'ci');
    assert.equal(parseZbEnv('QA')!.name, 'qa');
  });

  it('treats unset or blank as no selection', () => {
    assert.equal(parseZbEnv(undefined), null);
    assert.equal(parseZbEnv('  '), null);
  });

  it('throws on anything else, including object-prototype names', () => {
    for (const bad of ['staging', 'production', 'toString', 'constructor']) {
      assert.throws(() => parseZbEnv(bad), /ZB_ENV must be prod, uat, qa or ci \(dev = ci\)/);
    }
  });
});

describe('ZB_ENV URL defaults', () => {
  it('derives the platform, dataloader and org-registry URLs', () => {
    assert.deepEqual(zbEnvDefaults(ci), {
      ZB_PLATFORM_URL: 'https://ci.zerobias.com/api',
      DATALOADER_SERVICE_URL: 'https://ci.zerobias.com/api/dataloader',
      PUBLISH_ORG_REGISTRY_URL: 'https://ci.pkg.zerobias.org',
    });
    assert.equal(zbEnvDefaults(prod).ZB_PLATFORM_URL, 'https://app.zerobias.com/api');
  });

  it('recognises any environment default, with or without a trailing slash, but not a hand-picked URL', () => {
    assert.ok(isZbEnvDefaultValue('ZB_PLATFORM_URL', 'https://app.zerobias.com/api/'));
    assert.ok(isZbEnvDefaultValue('DATALOADER_SERVICE_URL', 'https://qa.zerobias.com/api/dataloader'));
    assert.ok(!isZbEnvDefaultValue('DATALOADER_SERVICE_URL', 'http://localhost:15001/api/dataloader'));
    assert.ok(!isZbEnvDefaultValue('ZB_PLATFORM_URL', undefined));
  });

  it('overlay replaces a stack prod default and fills missing keys, keeps overrides and hand-picked values', () => {
    const env: Record<string, string> = {
      ZB_PLATFORM_URL: 'https://app.zerobias.com/api',
      DATALOADER_SERVICE_URL: 'http://localhost:15001/api/dataloader',
    };
    overlayZbEnv(env, ci, new Set());
    assert.equal(env.ZB_ENV, 'ci');
    assert.equal(env.ZB_PLATFORM_URL, 'https://ci.zerobias.com/api');
    assert.equal(env.DATALOADER_SERVICE_URL, 'http://localhost:15001/api/dataloader');
    assert.equal(env.PUBLISH_ORG_REGISTRY_URL, 'https://ci.pkg.zerobias.org');

    const pinned: Record<string, string> = { ZB_PLATFORM_URL: 'https://app.zerobias.com/api' };
    overlayZbEnv(pinned, ci, new Set(['ZB_PLATFORM_URL']));
    assert.equal(pinned.ZB_PLATFORM_URL, 'https://app.zerobias.com/api');
  });

  it('keeps an ambient hand-picked endpoint over a derived default only', () => {
    const effective = { ZB_ENV: 'ci', DATALOADER_SERVICE_URL: 'https://ci.zerobias.com/api/dataloader' };
    assert.ok(keepsAmbientOverZbEnvDefault('DATALOADER_SERVICE_URL', effective, { DATALOADER_SERVICE_URL: 'http://localhost:15001' }));
    assert.ok(!keepsAmbientOverZbEnvDefault('DATALOADER_SERVICE_URL', effective, { DATALOADER_SERVICE_URL: 'https://app.zerobias.com/api/dataloader' }));
    assert.ok(!keepsAmbientOverZbEnvDefault('DATALOADER_SERVICE_URL', { DATALOADER_SERVICE_URL: 'x' }, { DATALOADER_SERVICE_URL: 'http://localhost:15001' }));
    assert.ok(!keepsAmbientOverZbEnvDefault('ZB_TOKEN', effective, { ZB_TOKEN: 'shell' }));
  });
});

describe('ZB_ENV npm config', () => {
  it('a non-prod npmrc routes every scope and the default registry to the env host and rewrites prod lockfile hosts', () => {
    const npmrc = renderZbEnvNpmrc(ci);
    assert.match(npmrc, /^registry=https:\/\/ci\.pkg\.zerobias\.org\/$/m);
    assert.match(npmrc, /^replace-registry-host=pkg\.zerobias\.org$/m);
    for (const scope of ['@zerobias-org', '@zerobias-com', '@auditlogic', '@auditmation', '@devsupply']) {
      assert.ok(npmrc.includes(`${scope}:registry=https://ci.pkg.zerobias.org/\n`), scope);
    }
    assert.match(npmrc, /^\/\/ci\.pkg\.zerobias\.org\/:_authToken=\$\{ZB_TOKEN\}$/m);
    assert.doesNotMatch(npmrc, /\/\/pkg\.zerobias\.org\/:_authToken/);
  });

  it('the prod npmrc leaves the default registry and lockfile hosts alone', () => {
    const npmrc = renderZbEnvNpmrc(prod);
    assert.doesNotMatch(npmrc, /^registry=/m);
    assert.doesNotMatch(npmrc, /replace-registry-host/);
    assert.match(npmrc, /^@zerobias-org:registry=https:\/\/pkg\.zerobias\.org\/$/m);
  });

  it('the npm env replaces the user and global config files and carries the scope registries', () => {
    const env = zbEnvNpmEnv(ci, '/z/ci.npmrc', '/z/global.npmrc');
    assert.equal(env.NPM_CONFIG_USERCONFIG, '/z/ci.npmrc');
    assert.equal(env.NPM_CONFIG_GLOBALCONFIG, '/z/global.npmrc');
    assert.equal(env['npm_config_@zerobias-com:registry'], 'https://ci.pkg.zerobias.org/');
    assert.equal(env.npm_config_registry, 'https://ci.pkg.zerobias.org/');
    assert.equal(env.npm_config_replace_registry_host, 'pkg.zerobias.org');
    assert.equal(zbEnvNpmEnv(prod, 'u', 'g').npm_config_registry, undefined);
  });

  it('the daemon drift check watches ZB_ENV, its URL defaults and the npm keys', () => {
    const keys = zbEnvWatchedKeys();
    for (const k of ['ZB_ENV', 'ZB_PLATFORM_URL', 'NPM_CONFIG_USERCONFIG', 'npm_config_@zerobias-org:registry']) {
      assert.ok(keys.includes(k), k);
    }
  });

  describe('applyZbEnvNpm', () => {
    let zbbDir: string;
    beforeEach(() => { zbbDir = mkdtempSync(join(tmpdir(), 'zbb-npm-')); });
    afterEach(() => rmSync(zbbDir, { recursive: true, force: true }));

    it('writes the npmrc and sets the env, replacing any other spelling of the same npm key', () => {
      const env: NodeJS.ProcessEnv = { NPM_CONFIG_REGISTRY: 'https://elsewhere/', npm_config_userconfig: '/home/me/.npmrc' };
      applyZbEnvNpm(ci, { env, zbbDir });

      const npmrc = join(zbbDir, 'npm', 'ci.npmrc');
      assert.equal(readFileSync(npmrc, 'utf-8'), renderZbEnvNpmrc(ci));
      assert.equal(env.NPM_CONFIG_USERCONFIG, npmrc);
      assert.equal(env.npm_config_registry, 'https://ci.pkg.zerobias.org/');
      assert.equal(env.NPM_CONFIG_REGISTRY, undefined);
      assert.equal(env.npm_config_userconfig, undefined);
    });

    it('a release command or no ZB_ENV clears what zbb set, and leaves a user npm env without the marker alone', () => {
      const env: NodeJS.ProcessEnv = {};
      applyZbEnvNpm(ci, { env, zbbDir });
      applyZbEnvNpm(ci, { env, zbbDir, command: 'publish' });
      assert.deepEqual(Object.keys(env).filter(k => /npm_config|ZBB_NPMRC/i.test(k)), []);

      const own: NodeJS.ProcessEnv = { NPM_CONFIG_USERCONFIG: '/runner/.npmrc' };
      clearZbEnvNpm(own);
      applyZbEnvNpm(null, { env: own, zbbDir });
      assert.equal(own.NPM_CONFIG_USERCONFIG, '/runner/.npmrc');
    });
  });
});

describe('lockfile host normalization', () => {
  it('rewrites env-host URLs to pkg.zerobias.org for ZeroBias scopes and to npmjs for the rest', () => {
    const lock = JSON.stringify({
      packages: {
        'node_modules/@zerobias-org/x': { resolved: 'https://ci.pkg.zerobias.org/@zerobias-org/x/-/x-1.0.0.tgz' },
        'node_modules/@zerobias-com/y': { resolved: 'https://qa.pkg.zerobias.org/%40zerobias-com%2fy/-/y-2.0.0.tgz' },
        'node_modules/lodash': { resolved: 'https://uat.pkg.zerobias.org/lodash/-/lodash-4.17.21.tgz' },
        'node_modules/@types/node': { resolved: 'https://ci.pkg.zerobias.org/@types/node/-/node-22.0.0.tgz' },
        'node_modules/@zerobias-org/z': { resolved: 'https://pkg.zerobias.org/@zerobias-org/z/-/z-1.0.0.tgz' },
      },
    }, null, 2);
    const out = JSON.parse(normalizeLockfileHosts(lock)).packages;
    assert.equal(out['node_modules/@zerobias-org/x'].resolved, 'https://pkg.zerobias.org/@zerobias-org/x/-/x-1.0.0.tgz');
    assert.equal(out['node_modules/@zerobias-com/y'].resolved, 'https://pkg.zerobias.org/%40zerobias-com%2fy/-/y-2.0.0.tgz');
    assert.equal(out['node_modules/lodash'].resolved, 'https://registry.npmjs.org/lodash/-/lodash-4.17.21.tgz');
    assert.equal(out['node_modules/@types/node'].resolved, 'https://registry.npmjs.org/@types/node/-/node-22.0.0.tgz');
    assert.equal(out['node_modules/@zerobias-org/z'].resolved, 'https://pkg.zerobias.org/@zerobias-org/z/-/z-1.0.0.tgz');
  });

  it('normalizes modified and untracked lockfiles in a git repo, and leaves committed ones alone', () => {
    const repo = mkdtempSync(join(tmpdir(), 'zbb-lock-'));
    try {
      const git = (...a: string[]) => execFileSync('git', ['-C', repo, ...a], { stdio: 'ignore' });
      git('init', '-q');
      const polluted = '{"resolved": "https://ci.pkg.zerobias.org/@zerobias-org/x/-/x-1.0.0.tgz"}\n';
      mkdirSync(join(repo, 'committed'));
      writeFileSync(join(repo, 'committed', 'package-lock.json'), polluted);
      git('add', '.');
      git('-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-qm', 'init');
      writeFileSync(join(repo, 'package-lock.json'), polluted);
      mkdirSync(join(repo, 'pkg'));
      writeFileSync(join(repo, 'pkg', 'package-lock.json'), polluted);

      assert.deepEqual(normalizeRepoLockfiles(repo).sort(), ['package-lock.json', 'pkg/package-lock.json']);
      assert.match(readFileSync(join(repo, 'pkg', 'package-lock.json'), 'utf-8'), /"https:\/\/pkg\.zerobias\.org\/@zerobias-org/);
      assert.equal(readFileSync(join(repo, 'committed', 'package-lock.json'), 'utf-8'), polluted);
      assert.deepEqual(normalizeRepoLockfiles(join(repo, 'not-a-repo-dir')), []);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
