/**
 * ModuleTestHarness Unit Tests
 *
 * These tests verify the test harness components work correctly
 * without requiring actual Docker containers.
 */

import { expect } from 'chai';
import { describe, it, beforeEach, afterEach } from 'mocha';
import {
  AuthManager,
  generateDeploymentId,
  generateAuthKey,
  parseAuthHeaders,
  AUTH_HEADERS
} from '../../src/index.js';
import {
  EnvSecretsProvider,
  setEnvSecret,
  clearEnvSecret
} from '../../src/providers/EnvSecretsProvider.js';
import {
  TestProfileLoader,
  createTestProfile
} from '../../src/TestProfileLoader.js';

describe('AuthManager', () => {
  let authManager: AuthManager;

  beforeEach(() => {
    authManager = new AuthManager();
  });

  describe('createSession', () => {
    it('should create a session with unique deployment ID', () => {
      const session = authManager.createSession();

      expect(session.deploymentId).to.be.a('string');
      expect(session.deploymentId).to.match(/^test-dep-/);
      expect(session.authKey).to.be.a('string');
      expect(session.createdAt).to.be.instanceOf(Date);
    });

    it('should create sessions with unique IDs', () => {
      const session1 = authManager.createSession();
      const session2 = authManager.createSession();

      expect(session1.deploymentId).to.not.equal(session2.deploymentId);
      expect(session1.authKey).to.not.equal(session2.authKey);
    });

    it('should use provided deployment ID', () => {
      const session = authManager.createSession('my-custom-id');

      expect(session.deploymentId).to.equal('my-custom-id');
    });
  });

  describe('getSession', () => {
    it('should return existing session', () => {
      const session = authManager.createSession();
      const retrieved = authManager.getSession(session.deploymentId);

      expect(retrieved).to.deep.equal(session);
    });

    it('should return undefined for unknown deployment', () => {
      const session = authManager.getSession('unknown-id');

      expect(session).to.be.undefined;
    });
  });

  describe('getAuthHeaders', () => {
    it('should return correct headers', () => {
      const session = authManager.createSession();
      const headers = authManager.getAuthHeaders(session.deploymentId);

      // V1 auth uses single 'auditmation-auth' header
      expect(headers[AUTH_HEADERS.V1_AUTH]).to.equal(session.authKey);
    });

    it('should throw for unknown deployment', () => {
      expect(() => authManager.getAuthHeaders('unknown-id')).to.throw(
        'No auth session found for deployment: unknown-id'
      );
    });
  });

  describe('removeSession', () => {
    it('should remove session', () => {
      const session = authManager.createSession();
      authManager.removeSession(session.deploymentId);

      expect(authManager.getSession(session.deploymentId)).to.be.undefined;
    });
  });

  describe('clearSessions', () => {
    it('should remove all sessions', () => {
      const session1 = authManager.createSession();
      const session2 = authManager.createSession();

      authManager.clearSessions();

      expect(authManager.getSession(session1.deploymentId)).to.be.undefined;
      expect(authManager.getSession(session2.deploymentId)).to.be.undefined;
    });
  });
});

describe('Auth Utilities', () => {
  describe('generateDeploymentId', () => {
    it('should generate unique IDs', () => {
      const id1 = generateDeploymentId();
      const id2 = generateDeploymentId();

      expect(id1).to.not.equal(id2);
      expect(id1).to.match(/^test-dep-/);
    });
  });

  describe('generateAuthKey', () => {
    it('should generate unique keys', () => {
      const key1 = generateAuthKey();
      const key2 = generateAuthKey();

      expect(key1).to.not.equal(key2);
      expect(key1).to.match(/^[0-9a-f-]+$/);
    });
  });

  describe('parseAuthHeaders', () => {
    it('should parse valid V1 headers', () => {
      const headers = {
        [AUTH_HEADERS.V1_AUTH]: 'key-456'
      };

      const result = parseAuthHeaders(headers);

      expect(result).to.deep.equal({
        deploymentId: null, // V1 doesn't have deployment ID
        authKey: 'key-456'
      });
    });

    it('should parse valid V2 headers', () => {
      const headers = {
        [AUTH_HEADERS.V2_DEPLOYMENT_ID]: 'dep-123',
        [AUTH_HEADERS.V2_MODULE_AUTH]: 'key-456'
      };

      const result = parseAuthHeaders(headers);

      expect(result).to.deep.equal({
        deploymentId: 'dep-123',
        authKey: 'key-456'
      });
    });

    it('should return null for missing headers', () => {
      expect(parseAuthHeaders({})).to.be.null;
      // V2 requires both headers
      expect(parseAuthHeaders({ [AUTH_HEADERS.V2_DEPLOYMENT_ID]: 'dep' })).to.be.null;
      expect(parseAuthHeaders({ [AUTH_HEADERS.V2_MODULE_AUTH]: 'key' })).to.be.null;
    });

    it('should handle array headers', () => {
      const headers = {
        [AUTH_HEADERS.V1_AUTH]: ['key-456']
      };

      const result = parseAuthHeaders(headers);

      expect(result).to.deep.equal({
        deploymentId: null,
        authKey: 'key-456'
      });
    });
  });
});

describe('EnvSecretsProvider', () => {
  let provider: EnvSecretsProvider;

  beforeEach(() => {
    provider = new EnvSecretsProvider();
  });

  afterEach(() => {
    // Clean up any test env vars
    clearEnvSecret('test/credentials');
    clearEnvSecret('aws/test-credentials');
  });

  describe('getSecret', () => {
    it('should get JSON secret from environment', async () => {
      setEnvSecret('test/credentials', { username: 'testuser', password: 'secret123' });

      const secret = await provider.getSecret('test/credentials');

      expect(secret).to.deep.equal({ username: 'testuser', password: 'secret123' });
    });

    it('should handle path with slashes and hyphens', async () => {
      setEnvSecret('aws/test-credentials', { accessKey: 'AKIA...', secretKey: 'xxx' });

      const secret = await provider.getSecret('aws/test-credentials');

      expect(secret).to.deep.equal({ accessKey: 'AKIA...', secretKey: 'xxx' });
    });

    it('should throw for missing secret', async () => {
      try {
        await provider.getSecret('nonexistent/secret');
        expect.fail('Should have thrown');
      } catch (error: unknown) {
        expect((error as Error).message).to.include('No environment variables found');
      }
    });
  });

  describe('supports', () => {
    it('should return true for existing secret', () => {
      setEnvSecret('test/credentials', { value: 'test' });

      expect(provider.supports('test/credentials')).to.be.true;
    });

    it('should return false for missing secret', () => {
      expect(provider.supports('nonexistent/secret')).to.be.false;
    });
  });
});

describe('TestProfileLoader', () => {
  describe('createTestProfile', () => {
    it('should create a valid profile', () => {
      const profile = createTestProfile({
        name: 'test-profile',
        module: '@auditlogic/module-test',
        version: '1.0.0',
        profileType: 'TestConnectionProfile',
        secretsPath: 'test/credentials'
      });

      expect(profile.name).to.equal('test-profile');
      expect(profile.module).to.equal('@auditlogic/module-test');
      expect(profile.version).to.equal('1.0.0');
      expect(profile.connection.profileType).to.equal('TestConnectionProfile');
      expect(profile.connection.secretsPath).to.equal('test/credentials');
    });

    it('should create profile with inline connection', () => {
      const profile = createTestProfile({
        name: 'inline-profile',
        module: '@auditlogic/module-test',
        profileType: 'TestConnectionProfile',
        profile: { endpoint: 'https://api.example.com' }
      });

      expect(profile.connection.profile).to.deep.equal({
        endpoint: 'https://api.example.com'
      });
    });

    it('should support skip flags', () => {
      const profile = createTestProfile({
        name: 'ci-only-profile',
        module: '@auditlogic/module-test',
        profileType: 'TestConnectionProfile',
        secretsPath: 'test/creds',
        skipLocal: true,
        skipCi: false
      });

      expect(profile.skipLocal).to.be.true;
      expect(profile.skipCi).to.be.false;
    });
  });
});
