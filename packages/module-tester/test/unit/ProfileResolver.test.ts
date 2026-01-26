/**
 * ProfileResolver Unit Tests
 *
 * Tests the secret path resolution using Mustache {{...}} syntax.
 */

import { expect } from 'chai';
import { describe, it, beforeEach, afterEach } from 'mocha';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { ProfileResolver, createProfileResolver } from '../../src/providers/ProfileResolver.js';

describe('ProfileResolver', () => {
  let resolver: ProfileResolver;
  let tempDir: string;

  beforeEach(() => {
    // Create temp directory for test secrets
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'profile-resolver-test-'));
    resolver = new ProfileResolver({
      fileSecretRoot: tempDir
    });
  });

  afterEach(() => {
    // Clean up temp directory
    fs.rmSync(tempDir, { recursive: true, force: true });
    // Clean up env vars
    delete process.env.TEST_SECRET;
    delete process.env.TEST_JSON_SECRET;
  });

  describe('resolve', () => {
    it('should pass through literal values unchanged', async () => {
      const profile = {
        tokenType: 'Bearer',
        url: 'https://api.example.com',
        timeout: 30000
      };

      const resolved = await resolver.resolve(profile);

      expect(resolved).to.deep.equal(profile);
    });

    it('should resolve file-based secrets with {{}} syntax', async () => {
      // Create secret file
      fs.writeFileSync(
        path.join(tempDir, 'github.json'),
        JSON.stringify({ apiToken: 'ghp_test123', orgId: 'org-456' })
      );

      const profile = {
        tokenType: 'Bearer',
        apiToken: '{{file.github.apiToken}}'
      };

      const resolved = await resolver.resolve(profile);

      expect(resolved).to.deep.equal({
        tokenType: 'Bearer',
        apiToken: 'ghp_test123'
      });
    });

    it('should resolve env-based secrets with {{}} syntax', async () => {
      process.env.TEST_SECRET = 'env-secret-value';

      const profile = {
        tokenType: 'Bearer',
        apiKey: '{{env.TEST_SECRET}}'
      };

      const resolved = await resolver.resolve(profile);

      expect(resolved).to.deep.equal({
        tokenType: 'Bearer',
        apiKey: 'env-secret-value'
      });
    });

    it('should resolve env-based JSON secrets with nested paths', async () => {
      process.env.TEST_JSON_SECRET = JSON.stringify({
        credentials: {
          apiToken: 'json-token-123'
        }
      });

      const profile = {
        apiToken: '{{env.TEST_JSON_SECRET.credentials.apiToken}}'
      };

      const resolved = await resolver.resolve(profile);

      expect(resolved).to.deep.equal({
        apiToken: 'json-token-123'
      });
    });

    it('should not treat values without {{}} as secret paths', async () => {
      // Even if value looks like a path, without {{}} it's a literal
      const profile = {
        description: 'file.github.apiToken',
        path: 'env.SOME_VAR'
      };

      const resolved = await resolver.resolve(profile);

      expect(resolved).to.deep.equal(profile);
    });

    it('should handle mixed literal and secret values', async () => {
      fs.writeFileSync(
        path.join(tempDir, 'aws.json'),
        JSON.stringify({ accessKey: 'AKIA...', secretKey: 'xxx' })
      );
      process.env.TEST_SECRET = 'region-value';

      const profile = {
        provider: 'aws',
        accessKey: '{{file.aws.accessKey}}',
        secretKey: '{{file.aws.secretKey}}',
        region: '{{env.TEST_SECRET}}',
        endpoint: 'https://aws.amazon.com'
      };

      const resolved = await resolver.resolve(profile);

      expect(resolved).to.deep.equal({
        provider: 'aws',
        accessKey: 'AKIA...',
        secretKey: 'xxx',
        region: 'region-value',
        endpoint: 'https://aws.amazon.com'
      });
    });

    it('should handle whitespace around {{}} syntax', async () => {
      process.env.TEST_SECRET = 'trimmed-value';

      const profile = {
        apiKey: '  {{env.TEST_SECRET}}  '
      };

      const resolved = await resolver.resolve(profile);

      expect(resolved).to.deep.equal({
        apiKey: 'trimmed-value'
      });
    });
  });

  describe('file secrets', () => {
    it('should load JSON files', async () => {
      fs.writeFileSync(
        path.join(tempDir, 'test.json'),
        JSON.stringify({ key: 'json-value' })
      );

      const profile = { value: '{{file.test.key}}' };
      const resolved = await resolver.resolve(profile);

      expect(resolved.value).to.equal('json-value');
    });

    it('should load YAML files', async () => {
      fs.writeFileSync(
        path.join(tempDir, 'test.yml'),
        'key: yaml-value\nnested:\n  sub: nested-yaml'
      );

      const profile = {
        value: '{{file.test.key}}',
        nested: '{{file.test.nested.sub}}'
      };
      const resolved = await resolver.resolve(profile);

      expect(resolved.value).to.equal('yaml-value');
      expect(resolved.nested).to.equal('nested-yaml');
    });

    it('should throw for missing file', async () => {
      const profile = { value: '{{file.nonexistent.key}}' };

      try {
        await resolver.resolve(profile);
        expect.fail('Should have thrown');
      } catch (error: unknown) {
        expect((error as Error).message).to.include('Secret file not found');
      }
    });

    it('should throw for missing key in file', async () => {
      fs.writeFileSync(
        path.join(tempDir, 'test.json'),
        JSON.stringify({ existing: 'value' })
      );

      const profile = { value: '{{file.test.missing}}' };

      try {
        await resolver.resolve(profile);
        expect.fail('Should have thrown');
      } catch (error: unknown) {
        expect((error as Error).message).to.include('Key not found');
      }
    });
  });

  describe('env secrets', () => {
    it('should get plain env var value', async () => {
      process.env.TEST_SECRET = 'plain-value';

      const profile = { value: '{{env.TEST_SECRET}}' };
      const resolved = await resolver.resolve(profile);

      expect(resolved.value).to.equal('plain-value');
    });

    it('should parse JSON env var and navigate', async () => {
      process.env.TEST_JSON_SECRET = JSON.stringify({
        level1: { level2: 'deep-value' }
      });

      const profile = { value: '{{env.TEST_JSON_SECRET.level1.level2}}' };
      const resolved = await resolver.resolve(profile);

      expect(resolved.value).to.equal('deep-value');
    });

    it('should throw for missing env var', async () => {
      const profile = { value: '{{env.NONEXISTENT_VAR}}' };

      try {
        await resolver.resolve(profile);
        expect.fail('Should have thrown');
      } catch (error: unknown) {
        expect((error as Error).message).to.include('Environment variable not found');
      }
    });

    it('should throw for invalid JSON when path is specified', async () => {
      process.env.TEST_SECRET = 'not-json';

      const profile = { value: '{{env.TEST_SECRET.someKey}}' };

      try {
        await resolver.resolve(profile);
        expect.fail('Should have thrown');
      } catch (error: unknown) {
        expect((error as Error).message).to.include('not valid JSON');
      }
    });
  });

  describe('createProfileResolver', () => {
    it('should create resolver with default config', () => {
      const resolver = createProfileResolver();

      expect(resolver).to.be.instanceOf(ProfileResolver);
    });

    it('should create resolver with custom config', () => {
      const resolver = createProfileResolver({
        fileSecretRoot: '/custom/path',
        logger: {
          debug: () => {},
          info: () => {},
          warn: () => {},
          error: () => {}
        }
      });

      expect(resolver).to.be.instanceOf(ProfileResolver);
    });
  });
});
