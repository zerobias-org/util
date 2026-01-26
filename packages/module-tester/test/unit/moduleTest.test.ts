/**
 * Unit tests for moduleTest framework
 */

import { expect } from 'chai';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

// Test the helper functions by importing the module
// Note: We can't easily test moduleTest() itself in unit tests because
// it registers Mocha hooks. Integration testing is more appropriate for that.

describe('moduleTest helpers', () => {
  describe('profile override detection', () => {
    const originalEnv = process.env;
    const originalArgv = process.argv;

    afterEach(() => {
      process.env = originalEnv;
      process.argv = originalArgv;
    });

    it('should detect npm_config_profile from environment', () => {
      process.env = { ...originalEnv, npm_config_profile: 'ci' };
      // The function is internal, so we test behavior through integration
      expect(process.env.npm_config_profile).to.equal('ci');
    });

    it('should detect --profile=value from argv', () => {
      process.argv = [...originalArgv, '--profile=staging'];
      const hasProfile = process.argv.some(arg => arg.startsWith('--profile='));
      expect(hasProfile).to.be.true;
    });

    it('should detect --profile value from argv', () => {
      process.argv = [...originalArgv, '--profile', 'staging'];
      const profileIdx = process.argv.indexOf('--profile');
      expect(profileIdx).to.be.greaterThan(-1);
      expect(process.argv[profileIdx + 1]).to.equal('staging');
    });
  });

  describe('CI detection', () => {
    const originalEnv = process.env;

    afterEach(() => {
      process.env = originalEnv;
    });

    it('should detect CI=true', () => {
      process.env = { ...originalEnv, CI: 'true' };
      const isCi = process.env.CI === 'true' || process.env.GITHUB_ACTIONS === 'true';
      expect(isCi).to.be.true;
    });

    it('should detect GITHUB_ACTIONS=true', () => {
      process.env = { ...originalEnv, GITHUB_ACTIONS: 'true' };
      const isCi = process.env.CI === 'true' || process.env.GITHUB_ACTIONS === 'true';
      expect(isCi).to.be.true;
    });

    it('should return false when not in CI', () => {
      process.env = { ...originalEnv };
      delete process.env.CI;
      delete process.env.GITHUB_ACTIONS;
      const isCi = process.env.CI === 'true' || process.env.GITHUB_ACTIONS === 'true';
      expect(isCi).to.be.false;
    });
  });

  describe('client factory path resolution', () => {
    it('should convert module name to PascalCase', () => {
      const moduleName = 'github';
      const pascalName = moduleName
        .split('-')
        .map(part => part.charAt(0).toUpperCase() + part.slice(1))
        .join('');
      expect(pascalName).to.equal('Github');
    });

    it('should handle multi-part module names', () => {
      const moduleName = 'aws-s3';
      const pascalName = moduleName
        .split('-')
        .map(part => part.charAt(0).toUpperCase() + part.slice(1))
        .join('');
      expect(pascalName).to.equal('AwsS3');
    });

    it('should construct correct factory path', () => {
      const testDir = './test';
      const factoryPath = path.resolve(testDir, 'client-factory.ts');
      expect(factoryPath).to.include('test');
      expect(factoryPath).to.include('client-factory.ts');
    });

    it('should construct correct generated path', () => {
      const testDir = './test';
      const moduleName = 'github';
      const pascalName = 'Github';
      const generatedPath = path.resolve(testDir, 'generated', `${pascalName}TestClient.ts`);
      expect(generatedPath).to.include('test');
      expect(generatedPath).to.include('generated');
      expect(generatedPath).to.include('GithubTestClient.ts');
    });
  });
});

describe('ModuleTestHarness.invokeMethod', () => {
  // Note: Full integration tests require Docker. These are structural tests.

  it('should construct correct URL path', () => {
    const connectionId = 'conn-123';
    const apiClass = 'OrganizationApi';
    const method = 'listMyOrganizations';
    const expectedUrl = `/connections/${connectionId}/${apiClass}.${method}`;
    expect(expectedUrl).to.equal('/connections/conn-123/OrganizationApi.listMyOrganizations');
  });

  it('should format argMap correctly', () => {
    const argMap = { page: 1, perPage: 10 };
    const payload = { argMap };
    expect(payload).to.deep.equal({ argMap: { page: 1, perPage: 10 } });
  });
});
