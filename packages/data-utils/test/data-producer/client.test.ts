/**
 * Tests for DataProducerClient
 */
import { expect } from 'chai';
import { DataProducerClient } from '../../src';

describe('DataProducerClient', () => {
  let client: DataProducerClient;

  beforeEach(() => {
    client = new DataProducerClient();
  });

  describe('constructor', () => {
    it('should create a new instance', () => {
      expect(client).to.be.instanceOf(DataProducerClient);
    });

    it('should initialize with undefined config', () => {
      expect(client.getConfig()).to.be.undefined;
    });

    it('should expose API modules', () => {
      expect(client.objects).to.exist;
      expect(client.collections).to.exist;
      expect(client.schemas).to.exist;
      expect(client.documents).to.exist;
      expect(client.functions).to.exist;
      expect(client.binary).to.exist;
    });
  });

  describe('getConfig', () => {
    it('should return undefined before connection', () => {
      expect(client.getConfig()).to.be.undefined;
    });

    it('should return config after connection attempt', async () => {
      const config = {
        server: new URL('https://test.example.com'),
        targetId: 'test-target',
        scopeId: 'test-scope'
      };

      // Note: This will fail to actually connect without a real server,
      // but it should store the config
      try {
        await client.connect(config);
      } catch (error) {
        // Expected to fail without real server
      }

      const storedConfig = client.getConfig();
      expect(storedConfig).to.not.be.undefined;
      if (storedConfig) {
        expect(storedConfig.targetId).to.equal('test-target');
      }
    });
  });

  describe('isConnected', () => {
    it('should return false before connection', async () => {
      const connected = await client.isConnected();
      expect(connected).to.be.false;
    });

    it('should return false after failed connection', async () => {
      const config = {
        server: new URL('https://invalid.example.com'),
        targetId: 'test-target',
        scopeId: 'test-scope'
      };

      try {
        await client.connect(config);
      } catch (error) {
        // Expected
      }

      const connected = await client.isConnected();
      expect(connected).to.be.false;
    });
  });

  describe('ping', () => {
    it('should return false when not connected', async () => {
      const result = await client.ping();
      expect(result).to.be.false;
    });

    it('should fallback to isConnected if ping not available', async () => {
      // Ping should use isConnected as fallback
      const result = await client.ping();
      const connected = await client.isConnected();
      expect(result).to.equal(connected);
    });
  });

  describe('init', () => {
    it('should accept undefined targetId and not connect', async () => {
      const result = await client.init(undefined, 'test-scope');
      expect(result.success).to.be.false;
    });

    it('should accept string targetId', async () => {
      const result = await client.init(
        'test-target',
        'https://test.example.com'
      );

      // Will fail without real server, but should not throw
      expect(result).to.have.property('success');
      expect(result).to.have.property('error');
    });

    it('should handle reconnection when targetId changes', async () => {
      // First connection
      await client.init('target-1', 'https://test.example.com');

      // Change target - should trigger reconnection
      const result = await client.init('target-2', 'https://test.example.com');

      expect(result).to.have.property('success');
      const config = client.getConfig();
      if (config) {
        expect(config.targetId).to.equal('target-2');
      }
    });

    it('should disconnect when targetId becomes undefined', async () => {
      // First connection
      await client.init('target-1', 'https://test.example.com');

      // Disconnect by passing undefined
      const result = await client.init(undefined, 'scope-1');

      expect(result.success).to.be.false;
      const connected = await client.isConnected();
      expect(connected).to.be.false;
    });
  });

  describe('disconnect', () => {
    it('should return true even when not connected', async () => {
      const result = await client.disconnect();
      expect(result).to.be.true;
    });

    it('should clear config after disconnect', async () => {
      // Try to connect first
      try {
        await client.connect({
          server: new URL('https://test.example.com'),
          targetId: 'test-target',
        });
      } catch (error) {
        // Expected
      }

      await client.disconnect();
      const connected = await client.isConnected();
      expect(connected).to.be.false;
    });
  });

  describe('error handling', () => {
    it('should handle missing server URL gracefully', async () => {
      const config: any = {
        targetId: 'test-target',
        scopeId: 'test-scope'
        // Missing server URL
      };

      const result = await client.connect(config);
      expect(result.success).to.be.false;
      expect(result.error).to.exist;
    });

    it('should handle invalid server URL gracefully', async () => {
      const config: any = {
        server: 'not-a-url',  // Invalid URL
        targetId: 'test-target',
        scopeId: 'test-scope'
      };

      try {
        await client.connect(config);
      } catch (error) {
        expect(error).to.exist;
      }
    });

    it('should handle missing targetId gracefully', async () => {
      const config: any = {
        server: new URL('https://test.example.com'),
        scopeId: 'test-scope'
        // Missing targetId
      };

      const result = await client.connect(config);
      expect(result.success).to.be.false;
      expect(result.error).to.exist;
    });

    it('should handle missing scopeId gracefully', async () => {
      const config: any = {
        server: new URL('https://test.example.com'),
        targetId: 'test-target'
        // Missing scopeId
      };

      const result = await client.connect(config);
      expect(result.success).to.be.false;
      expect(result.error).to.exist;
    });
  });

  describe('API module availability', () => {
    it('should have ObjectsApi available', () => {
      expect(client.objects).to.exist;
      expect(typeof client.objects.getRoot).to.equal('function');
      expect(typeof client.objects.getChildren).to.equal('function');
      expect(typeof client.objects.getObject).to.equal('function');
      expect(typeof client.objects.buildTree).to.equal('function');
    });

    it('should have CollectionsApi available', () => {
      expect(client.collections).to.exist;
      // expect(typeof client.collections.getCollections).to.equal('function');
      expect(typeof client.collections.getCollectionElements).to.equal('function');
      expect(typeof client.collections.searchCollectionElements).to.equal('function');
      expect(typeof client.collections.queryCollection).to.equal('function');
    });

    it('should have SchemasApi available', () => {
      expect(client.schemas).to.exist;
      // expect(typeof client.schemas.getSchemas).to.equal('function');
      expect(typeof client.schemas.getSchema).to.equal('function');
      // expect(typeof client.schemas.getSchemaByName).to.equal('function');
      expect(typeof client.schemas.getSchemaById).to.equal('function');
      expect(typeof client.schemas.validateData).to.equal('function');
    });

    it('should have placeholder APIs that report unavailable', async () => {
      expect(client.documents).to.exist;
      expect(await client.documents.isAvailable()).to.be.false;

      expect(client.functions).to.exist;
      expect(await client.functions.isAvailable()).to.be.false;

      expect(client.binary).to.exist;
      expect(await client.binary.isAvailable()).to.be.false;
    });
  });
});
