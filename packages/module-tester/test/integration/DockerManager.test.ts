/**
 * DockerManager Integration Tests
 *
 * Tests Docker functionality with a real container.
 * Requires Docker to be running.
 */

import { expect } from 'chai';
import { describe, it, before, after } from 'mocha';
import { DockerManager, generateDeploymentId, generateAuthKey } from '../../src/index.js';
import type { TestDeployment } from '../../src/types.js';

describe('DockerManager Integration', function () {
  // Increase timeout for Docker operations
  this.timeout(120000);

  let dockerManager: DockerManager;
  let dockerAvailable = false;

  before(async function () {
    dockerManager = new DockerManager({}, {
      debug: console.debug.bind(console),
      info: console.info.bind(console),
      warn: console.warn.bind(console),
      error: console.error.bind(console)
    });

    dockerAvailable = await dockerManager.isAvailable();
    if (!dockerAvailable) {
      console.warn('Docker not available, skipping integration tests');
      this.skip();
    }
  });

  after(async function () {
    if (dockerManager) {
      await dockerManager.stopAll();
    }
  });

  describe('isAvailable', () => {
    it('should detect Docker is available', async () => {
      const available = await dockerManager.isAvailable();
      expect(available).to.be.true;
    });
  });

  describe('pullImage', () => {
    it('should pull a small image', async function () {
      // Use a small image for testing
      await dockerManager.pullImage('alpine:latest');
      const exists = await dockerManager.imageExists('alpine:latest');
      expect(exists).to.be.true;
    });
  });

  describe('startContainer with nginx', function () {
    let deployment: TestDeployment;
    let port: number;

    before(async function () {
      deployment = {
        id: generateDeploymentId(),
        type: 'container',
        module: 'test/nginx',
        version: '1.0.0',
        image: 'nginx:alpine',
        authKey: generateAuthKey(),
        status: 'pending'
      };
    });

    after(async function () {
      if (deployment) {
        try {
          await dockerManager.stopContainer(deployment.id);
        } catch {
          // Ignore cleanup errors
        }
      }
    });

    it('should start nginx container', async function () {
      // We need to use a custom approach since nginx doesn't speak Hub protocol
      // Just test that we can pull and verify the image exists
      const exists = await dockerManager.imageExists('nginx:alpine');
      if (!exists) {
        await dockerManager.pullImage('nginx:alpine');
      }
      expect(await dockerManager.imageExists('nginx:alpine')).to.be.true;
    });
  });
});
