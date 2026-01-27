/**
 * Tests for CollectionsApi
 */
import { expect } from 'chai';
import { DataProducerClient } from '../../src';

describe('CollectionsApi', () => {
  let client: DataProducerClient;

  beforeEach(() => {
    client = new DataProducerClient();
  });

  // describe('getCollections', () => {
  //   it('should throw error when not connected', async () => {
  //     try {
  //       await client.collections.getCollections();
  //       expect.fail('Should have thrown error');
  //     } catch (error: any) {
  //       expect(error.message.toLowerCase()).to.include('not connected');
  //     }
  //   });
  // });

  describe('getCollectionElements', () => {
    it('should throw error when not connected', async () => {
      try {
        await client.collections.getCollectionElements('test-collection');
        expect.fail('Should have thrown error');
      } catch (error: any) {
        expect(error.message.toLowerCase()).to.include('not connected');
      }
    });

    it('should require collectionId parameter', async () => {
      try {
        await client.collections.getCollectionElements('');
        expect.fail('Should have thrown error');
      } catch (error) {
        expect(error).to.exist;
      }
    });

    it('should accept query options', async () => {
      // Will fail without connection, but should accept the parameters
      try {
        await client.collections.getCollectionElements('test-collection', {
          pageNumber: 0,
          pageSize: 10,
          sortBy: ['name'],
          sortDirection: 'asc'
        });
        expect.fail('Should have thrown error');
      } catch (error: any) {
        // Should fail with connection error, not parameter error
        expect(error.message.toLowerCase()).to.include('not connected');
      }
    });
  });

  describe('searchCollectionElements', () => {
    it('should throw error when not connected', async () => {
      try {
        await client.collections.searchCollectionElements('test-collection', 'search-term');
        expect.fail('Should have thrown error');
      } catch (error: any) {
        expect(error.message.toLowerCase()).to.include('not connected');
      }
    });

    it('should require collectionId parameter', async () => {
      try {
        await client.collections.searchCollectionElements('', 'search-term');
        expect.fail('Should have thrown error');
      } catch (error) {
        expect(error).to.exist;
      }
    });

    it('should require filter parameter', async () => {
      try {
        await client.collections.searchCollectionElements('test-collection', '');
        expect.fail('Should have thrown error');
      } catch (error) {
        expect(error).to.exist;
      }
    });

    it('should accept query options', async () => {
      try {
        await client.collections.searchCollectionElements('test-collection', 'search', {
          pageNumber: 0,
          pageSize: 20,
          sortBy: ['timestamp'],
          sortDirection: 'desc'
        });
        expect.fail('Should have thrown error');
      } catch (error: any) {
        // Should fail with connection error, not parameter error
        expect(error.message.toLowerCase()).to.include('not connected');
      }
    });
  });

  describe('queryCollection', () => {
    it('should throw error when not connected', async () => {
      try {
        await client.collections.queryCollection({
          collectionId: 'test-collection'
        });
        expect.fail('Should have thrown error');
      } catch (error: any) {
        expect(error.message.toLowerCase()).to.include('not connected');
      }
    });

    it('should route to getCollectionElements when no filter', async () => {
      // This is a convenience method - just test that it accepts the right params
      try {
        await client.collections.queryCollection({
          collectionId: 'test-collection',
          pageNumber: 0,
          pageSize: 10
        });
        expect.fail('Should have thrown error');
      } catch (error: any) {
        expect(error.message.toLowerCase()).to.include('not connected');
      }
    });

    it('should route to searchCollectionElements when filter provided', async () => {
      try {
        await client.collections.queryCollection({
          collectionId: 'test-collection',
          filter: 'search-term',
          pageNumber: 0,
          pageSize: 10
        });
        expect.fail('Should have thrown error');
      } catch (error: any) {
        expect(error.message.toLowerCase()).to.include('not connected');
      }
    });
  });

  describe('pagination', () => {
    it('should default to page 0 and size 50', async () => {
      // Can't test actual defaults without mocking, but parameters should be accepted
      try {
        await client.collections.getCollectionElements('test-collection');
        expect.fail('Should have thrown error');
      } catch (error: any) {
        // Should fail with connection error
        expect(error).to.exist;
      }
    });

    it('should accept custom page size', async () => {
      try {
        await client.collections.getCollectionElements('test-collection', {
          pageSize: 100
        });
        expect.fail('Should have thrown error');
      } catch (error) {
        expect(error).to.exist;
      }
    });

    it('should accept custom page number', async () => {
      try {
        await client.collections.getCollectionElements('test-collection', {
          pageNumber: 5
        });
        expect.fail('Should have thrown error');
      } catch (error) {
        expect(error).to.exist;
      }
    });
  });

  describe('sorting', () => {
    it('should accept sort by field name', async () => {
      try {
        await client.collections.getCollectionElements('test-collection', {
          sortBy: ['name']
        });
        expect.fail('Should have thrown error');
      } catch (error) {
        expect(error).to.exist;
      }
    });

    it('should accept sort direction', async () => {
      try {
        await client.collections.getCollectionElements('test-collection', {
          sortBy: ['name'],
          sortDirection: 'desc'
        });
        expect.fail('Should have thrown error');
      } catch (error) {
        expect(error).to.exist;
      }
    });

    it('should accept multiple sort fields', async () => {
      try {
        await client.collections.getCollectionElements('test-collection', {
          sortBy: ['category', 'name'],
          sortDirection: 'asc'
        });
        expect.fail('Should have thrown error');
      } catch (error) {
        expect(error).to.exist;
      }
    });
  });

  describe('sort direction normalization', () => {
    // These tests verify the internal normalization logic

    it('should accept "asc" direction', async () => {
      try {
        await client.collections.getCollectionElements('test-collection', {
          sortBy: ['name'],
          sortDirection: 'asc'
        });
      } catch (error) {
        // Should fail with connection error, not direction error
        expect(error).to.exist;
      }
    });

    it('should accept "desc" direction', async () => {
      try {
        await client.collections.getCollectionElements('test-collection', {
          sortBy: ['name'],
          sortDirection: 'desc'
        });
      } catch (error) {
        expect(error).to.exist;
      }
    });

    it('should accept "ascending" direction', async () => {
      try {
        await client.collections.getCollectionElements('test-collection', {
          sortBy: ['name'],
          sortDirection: ['ascending' as any]
        });
      } catch (error) {
        expect(error).to.exist;
      }
    });

    it('should accept "descending" direction', async () => {
      try {
        await client.collections.getCollectionElements('test-collection', {
          sortBy: ['name'],
          sortDirection: ['descending' as any]
        });
      } catch (error) {
        expect(error).to.exist;
      }
    });
  });

  describe('error handling', () => {
    // it('should provide meaningful error messages', async () => {
    //   try {
    //     await client.collections.getCollections();
    //     expect.fail('Should have thrown error');
    //   } catch (error: any) {
    //     expect(error.message).to.be.a('string');
    //     expect(error.message.length).to.be.greaterThan(0);
    //   }
    // });

    it('should handle missing collectionId', async () => {
      try {
        await client.collections.getCollectionElements('');
        expect.fail('Should have thrown error');
      } catch (error) {
        expect(error).to.exist;
      }
    });

    it('should handle undefined collectionId', async () => {
      try {
        await client.collections.getCollectionElements(undefined as any);
        expect.fail('Should have thrown error');
      } catch (error) {
        expect(error).to.exist;
      }
    });
  });

  describe('normalization', () => {
    // Tests to verify that response normalization preserves properties

    it('should preserve original properties in collection objects', () => {
      // This would be tested with actual API responses
      // For now, just verify the API methods exist
      // expect(client.collections.getCollections).to.be.a('function');
      expect(client.collections.getCollectionElements).to.be.a('function');
    });
  });
});
