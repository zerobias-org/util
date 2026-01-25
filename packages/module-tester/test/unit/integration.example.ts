/**
 * Integration Test Example
 *
 * This file demonstrates how to use the ModuleTestHarness for
 * integration testing with real Docker containers.
 *
 * To run these tests, you need:
 * 1. Docker running and accessible
 * 2. Credentials configured (via env vars or .secrets/ directory)
 *
 * Example usage in a module's test suite:
 *
 * ```typescript
 * import { ModuleTestHarness, createTestHarness } from '@zerobias-org/module-tester';
 * import { describe, it, before, after } from 'mocha';
 * import { expect } from 'chai';
 *
 * describe('My Module Integration Tests', () => {
 *   let harness: ModuleTestHarness;
 *
 *   before(async function() {
 *     this.timeout(120000); // Allow 2 minutes for container startup
 *
 *     harness = createTestHarness({ debug: true });
 *
 *     // Check if Docker is available
 *     if (!(await harness.isDockerAvailable())) {
 *       console.warn('Docker not available, skipping integration tests');
 *       this.skip();
 *       return;
 *     }
 *
 *     // Start with profile
 *     await harness.startWithProfile('my-service');
 *
 *     // Connect to the service
 *     const result = await harness.connect();
 *     if (!result.success) {
 *       throw new Error(`Connection failed: ${result.error}`);
 *     }
 *   });
 *
 *   after(async () => {
 *     if (harness) {
 *       await harness.disconnect();
 *       await harness.stopAll();
 *     }
 *   });
 *
 *   it('should list resources', async () => {
 *     const result = await harness.invoke({ operationId: 'listResources' });
 *
 *     expect(result.success).to.be.true;
 *     expect(result.data).to.be.an('array');
 *   });
 *
 *   it('should get a specific resource', async () => {
 *     const result = await harness.invoke({
 *       operationId: 'getResource',
 *       parameters: { id: 'resource-123' }
 *     });
 *
 *     expect(result.success).to.be.true;
 *     expect(result.data).to.have.property('id', 'resource-123');
 *   });
 *
 *   it('should create a resource', async () => {
 *     const result = await harness.invoke({
 *       operationId: 'createResource',
 *       body: {
 *         name: 'Test Resource',
 *         type: 'test'
 *       }
 *     });
 *
 *     expect(result.success).to.be.true;
 *     expect(result.data).to.have.property('id');
 *   });
 * });
 * ```
 *
 * Example test profile (test-profiles/my-service.yml):
 *
 * ```yaml
 * name: my-service-integration
 * module: "@auditlogic/module-my-service"
 * version: "1.0.0"
 *
 * connection:
 *   profileType: MyServiceConnectionProfile
 *   secretsPath: "myservice/credentials"
 *
 * operations:
 *   - listResources
 *   - getResource
 *   - createResource
 * ```
 *
 * Example secrets file (.secrets/myservice/credentials.json):
 *
 * ```json
 * {
 *   "apiKey": "your-api-key",
 *   "endpoint": "https://api.myservice.com"
 * }
 * ```
 */

import { ModuleTestHarness, createTestHarness, createTestProfile } from '../../src/index.js';

/**
 * Demonstrates the basic usage pattern
 */
async function exampleUsage(): Promise<void> {
  // Create harness with debug logging
  const harness = createTestHarness({ debug: true });

  try {
    // Check Docker availability
    const dockerAvailable = await harness.isDockerAvailable();
    console.log(`Docker available: ${dockerAvailable}`);

    if (!dockerAvailable) {
      console.log('Docker is not available. Please start Docker and try again.');
      return;
    }

    // Option 1: Start with explicit parameters
    console.log('\n--- Starting module with explicit parameters ---');
    const deploymentId = await harness.start(
      '@auditlogic/module-echo',  // A simple echo module for testing
      'latest',
      'pkg.ci.zerobias.com/auditlogic-module-echo:latest'
    );
    console.log(`Deployment started: ${deploymentId}`);

    // Get the port
    const port = harness.getPort();
    console.log(`Module running on port: ${port}`);

    // Perform health check
    const health = await harness.healthCheck();
    console.log(`Health check: ${health.healthy ? 'PASSED' : 'FAILED'}`);

    if (health.moduleInfo) {
      console.log(`Module info: ${JSON.stringify(health.moduleInfo)}`);
    }

    // Set connection profile (for modules that require connect)
    harness.setConnectionProfile({
      type: 'EchoConnectionProfile',
      message: 'Hello from test harness!'
    });

    // Connect
    const connectResult = await harness.connect();
    console.log(`Connect result: ${connectResult.success ? 'SUCCESS' : 'FAILED'}`);

    // Invoke an operation
    const invokeResult = await harness.invoke({
      operationId: 'echo',
      body: { message: 'Test message' }
    });
    console.log(`Invoke result: ${JSON.stringify(invokeResult)}`);

    // Get logs
    const logs = await harness.getLogs(undefined, 20);
    console.log('\n--- Container logs ---');
    console.log(logs);

  } finally {
    // Always clean up
    await harness.stopAll();
    console.log('\nCleanup complete');
  }
}

/**
 * Demonstrates profile-based testing
 */
async function exampleProfileBasedUsage(): Promise<void> {
  const harness = createTestHarness({
    debug: true,
    profilesDir: './test-profiles'
  });

  try {
    // Check Docker
    if (!(await harness.isDockerAvailable())) {
      console.log('Docker not available');
      return;
    }

    // Create a test profile programmatically
    const profile = createTestProfile({
      name: 'echo-test',
      module: '@auditlogic/module-echo',
      version: 'latest',
      profileType: 'EchoConnectionProfile',
      profile: {
        message: 'Hello!'
      },
      operations: ['echo', 'ping'],
      environment: {
        LOG_LEVEL: 'debug'
      }
    });

    // Start with profile
    console.log('\n--- Starting with test profile ---');
    await harness.startWithProfile(profile);

    // Connect
    await harness.connect();

    // Test each operation
    for (const op of profile.operations || []) {
      console.log(`\nTesting operation: ${op}`);
      const result = await harness.invoke({ operationId: op });
      console.log(`  Result: ${result.success ? 'SUCCESS' : 'FAILED'}`);
      if (result.data) {
        console.log(`  Data: ${JSON.stringify(result.data)}`);
      }
    }

  } finally {
    await harness.stopAll();
  }
}

/**
 * Demonstrates multiple concurrent modules
 */
async function exampleMultipleModules(): Promise<void> {
  const harness = createTestHarness({ debug: true });

  try {
    if (!(await harness.isDockerAvailable())) {
      console.log('Docker not available');
      return;
    }

    // Start multiple modules
    console.log('\n--- Starting multiple modules ---');

    const dep1 = await harness.start('@auditlogic/module-echo', 'latest');
    console.log(`Module 1 started: ${dep1}`);

    const dep2 = await harness.start('@auditlogic/module-echo', 'latest');
    console.log(`Module 2 started: ${dep2}`);

    // List active deployments
    const active = harness.getActiveDeployments();
    console.log(`Active deployments: ${active.join(', ')}`);

    // Invoke on specific deployment
    const result1 = await harness.invoke({ operationId: 'ping' }, dep1);
    console.log(`Module 1 ping: ${result1.success}`);

    const result2 = await harness.invoke({ operationId: 'ping' }, dep2);
    console.log(`Module 2 ping: ${result2.success}`);

    // Stop specific deployment
    await harness.stop(dep1);
    console.log('Module 1 stopped');

    // Stop remaining
    await harness.stopAll();
    console.log('All modules stopped');

  } finally {
    await harness.stopAll();
  }
}

// Export for reference
export { exampleUsage, exampleProfileBasedUsage, exampleMultipleModules };
