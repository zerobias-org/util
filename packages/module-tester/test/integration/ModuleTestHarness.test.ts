/**
 * ModuleTestHarness Integration Tests
 *
 * Tests the full harness flow with a real Hub module container.
 * Requires Docker and a module image to be available.
 */

import { expect } from 'chai';
import { describe, it, before, after } from 'mocha';
import { ModuleTestHarness, createTestHarness } from '../../src/index.js';

// Use an available module image for testing
const TEST_MODULE = '@auditlogic/module-github-github';
const TEST_VERSION = '6.8.0-rc.3';
const TEST_IMAGE = 'pkg.ci.zerobias.com/auditlogic-module-github-github:6.8.0-rc.3';

describe('ModuleTestHarness Integration', function () {
  // Increase timeout for Docker operations
  this.timeout(180000);

  let harness: ModuleTestHarness;
  let dockerAvailable = false;
  let imageAvailable = false;
  let deploymentId: string | undefined;

  before(async function () {
    harness = createTestHarness({ debug: true, cleanup: true });

    dockerAvailable = await harness.isDockerAvailable();
    if (!dockerAvailable) {
      console.warn('Docker not available, skipping integration tests');
      this.skip();
      return;
    }

    // Check if our test image exists
    const { DockerManager } = await import('../../src/DockerManager.js');
    const docker = new DockerManager();
    imageAvailable = await docker.imageExists(TEST_IMAGE);

    if (!imageAvailable) {
      console.warn(`Test image ${TEST_IMAGE} not available, skipping integration tests`);
      console.warn('Available module images can be listed with: docker images | grep module');
      this.skip();
      return;
    }
  });

  after(async function () {
    if (harness && deploymentId) {
      try {
        await harness.stop(deploymentId);
      } catch (err) {
        console.warn('Cleanup error:', err);
      }
    }
  });

  describe('start and health check', () => {
    it('should start a module container', async function () {
      if (!imageAvailable) this.skip();

      deploymentId = await harness.start(TEST_MODULE, TEST_VERSION, TEST_IMAGE);

      expect(deploymentId).to.be.a('string');
      expect(deploymentId).to.match(/^test-dep-/);

      console.log(`Started deployment: ${deploymentId}`);
    });

    it('should get deployment info', async function () {
      if (!deploymentId) this.skip();

      const deployment = harness.getDeployment(deploymentId);

      expect(deployment.id).to.equal(deploymentId);
      expect(deployment.module).to.equal(TEST_MODULE);
      expect(deployment.version).to.equal(TEST_VERSION);
      expect(deployment.status).to.equal('up');
      expect(deployment.port).to.be.a('number');

      console.log(`Deployment running on port: ${deployment.port}`);
    });

    it('should perform health check', async function () {
      if (!deploymentId) this.skip();

      const health = await harness.healthCheck(deploymentId);

      expect(health.healthy).to.be.true;
      expect(health.moduleInfo).to.be.an('object');
      expect(health.moduleInfo?.nonsensitiveProfileFields).to.be.an('array');
      expect(health.responseTimeMs).to.be.a('number');

      console.log('Health check passed:', health.moduleInfo);
    });

    it('should get container logs', async function () {
      if (!deploymentId) this.skip();

      const logs = await harness.getLogs(deploymentId, 10);

      expect(logs).to.be.a('string');
      console.log('Container logs (last 10 lines):\n', logs);
    });

    it('should get HTTP client', async function () {
      if (!deploymentId) this.skip();

      const client = harness.getClient(deploymentId);

      // AxiosInstance is a function with methods, not a plain object
      expect(client.get).to.be.a('function');
      expect(client.post).to.be.a('function');
    });

    it('should call root endpoint directly', async function () {
      if (!deploymentId) this.skip();

      const client = harness.getClient(deploymentId);
      const response = await client.get('/');

      expect(response.status).to.equal(200);
      expect(response.data).to.be.an('object');
      expect(response.data.nonsensitiveProfileFields).to.be.an('array');

      console.log('Module info:', response.data);
    });

    it('should stop the container', async function () {
      if (!deploymentId) this.skip();

      await harness.stop(deploymentId);

      const activeDeployments = harness.getActiveDeployments();
      expect(activeDeployments).to.not.include(deploymentId);

      deploymentId = undefined; // Prevent double cleanup
      console.log('Container stopped successfully');
    });
  });
});
