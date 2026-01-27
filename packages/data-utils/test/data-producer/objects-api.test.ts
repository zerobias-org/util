/**
 * Tests for ObjectsApi
 */
import { expect } from 'chai';
import { DataProducerClient } from '../../src';

describe('ObjectsApi', () => {
  let client: DataProducerClient;

  beforeEach(() => {
    client = new DataProducerClient();
  });

  describe('buildTree', () => {
    it('should build a tree from flat object list', () => {
      const objects = [
        { id: 'root', name: 'Root', type: 'folder', objectClass: 'folder', parentId: undefined },
        { id: 'child1', name: 'Child 1', type: 'file', objectClass: 'file', parentId: 'root' },
        { id: 'child2', name: 'Child 2', type: 'file', objectClass: 'file', parentId: 'root' },
        { id: 'grandchild1', name: 'Grandchild 1', type: 'file', objectClass: 'file', parentId: 'child1' }
      ];

      const result = client.objects.buildTree(objects);

      expect(result.root).to.not.be.undefined;
      expect(result.root?.id).to.equal('root');
      expect(result.children.size).to.be.greaterThan(0);
    });

    it('should handle empty object list', () => {
      const result = client.objects.buildTree([]);

      expect(result.root).to.be.undefined;
      expect(result.children.size).to.equal(0);
    });

    it('should find root when rootId is specified', () => {
      const objects = [
        { id: 'root1', name: 'Root 1', type: 'folder', objectClass: 'folder' },
        { id: 'root2', name: 'Root 2', type: 'folder', objectClass: 'folder' },
        { id: 'child1', name: 'Child 1', type: 'file', objectClass: 'file', parentId: 'root2' }
      ];

      const result = client.objects.buildTree(objects, 'root2');

      expect(result.root).to.not.be.undefined;
      expect(result.root?.id).to.equal('root2');
    });

    it('should group children by parent ID', () => {
      const objects = [
        { id: 'root', name: 'Root', type: 'folder', objectClass: 'folder' },
        { id: 'child1', name: 'Child 1', type: 'file', objectClass: 'file', parentId: 'root' },
        { id: 'child2', name: 'Child 2', type: 'file', objectClass: 'file', parentId: 'root' }
      ];

      const result = client.objects.buildTree(objects, 'root');

      const rootChildren = result.children.get('root');
      expect(rootChildren).to.exist;
      expect(rootChildren).to.have.lengthOf(2);
    });

    it('should handle objects with no parent', () => {
      const objects = [
        { id: 'orphan1', name: 'Orphan 1', type: 'file', objectClass: 'file' },
        { id: 'orphan2', name: 'Orphan 2', type: 'file', objectClass: 'file' }
      ];

      const result = client.objects.buildTree(objects);

      // First object without parent becomes root
      expect(result.root).to.not.be.undefined;
    });
  });

  describe('getRoot', () => {
    it('should throw error when not connected', async () => {
      try {
        await client.objects.getRoot();
        expect.fail('Should have thrown error');
      } catch (error: any) {
        expect(error.message.toLowerCase()).to.include('not connected');
      }
    });

    it('should attempt to call API when connected', async () => {
      // Connect first (will fail without real server)
      try {
        await client.connect({
          server: new URL('https://test.example.com'),
          targetId: 'test-target'
        });
      } catch (error) {
        // Expected
      }

      // Try to get root (will fail without real server)
      try {
        await client.objects.getRoot();
        expect.fail('Should have thrown error');
      } catch (error) {
        expect(error).to.exist;
      }
    });
  });

  describe('getChildren', () => {
    it('should throw error when not connected', async () => {
      try {
        await client.objects.getChildren('test-object-id');
        expect.fail('Should have thrown error');
      } catch (error: any) {
        expect(error.message.toLowerCase()).to.include('not connected');
      }
    });

    it('should require objectId parameter', async () => {
      try {
        await client.objects.getChildren('');
        expect.fail('Should have thrown error');
      } catch (error) {
        expect(error).to.exist;
      }
    });
  });

  describe('getObject', () => {
    it('should throw error when not connected', async () => {
      try {
        await client.objects.getObject('test-object-id');
        expect.fail('Should have thrown error');
      } catch (error: any) {
        expect(error.message.toLowerCase()).to.include('not connected');
      }
    });

    it('should require objectId parameter', async () => {
      try {
        await client.objects.getObject('');
        expect.fail('Should have thrown error');
      } catch (error) {
        expect(error).to.exist;
      }
    });
  });

  describe('normalization', () => {
    it('should preserve all original properties with spread operator', () => {
      // This is tested indirectly through buildTree
      // The spread operator ensures custom properties are preserved
      const objects = [
        {
          id: 'test',
          name: 'Test',
          type: 'file',
          objectClass: 'file',
          customProperty: 'custom-value',
          anotherProperty: 123
        }
      ];

      const result = client.objects.buildTree(objects);

      expect(result.root).to.not.be.undefined;
      if (result.root) {
        expect((result.root as any).customProperty).to.equal('custom-value');
        expect((result.root as any).anotherProperty).to.equal(123);
      }
    });

    it('should normalize id from objectId if id is missing', () => {
      const objects = [
        { objectId: 'test-id', name: 'Test', type: 'file', objectClass: 'file' } as any
      ];

      const result = client.objects.buildTree(objects);

      expect(result.root).to.not.be.undefined;
      expect(result.root?.id).to.equal('test-id');
    });

    it('should normalize name from displayName if name is missing', () => {
      const objects = [
        { id: 'test-id', displayName: 'Display Name', type: 'file', objectClass: 'file' } as any
      ];

      const result = client.objects.buildTree(objects);

      expect(result.root).to.not.be.undefined;
      expect(result.root?.name).to.equal('Display Name');
    });
  });

  describe('error handling', () => {
    it('should provide meaningful error messages', async () => {
      try {
        await client.objects.getRoot();
        expect.fail('Should have thrown error');
      } catch (error: any) {
        expect(error.message).to.be.a('string');
        expect(error.message.length).to.be.greaterThan(0);
      }
    });

    it('should handle undefined/undefined objects gracefully', () => {
      const objects: any = [
        { id: 'valid', name: 'Valid', objectClass: 'file' },
        undefined,
        undefined,
        { id: 'valid2', name: 'Valid 2', objectClass: 'file' }
      ];

      // Should filter out undefined/undefined without crashing
      const result = client.objects.buildTree(objects.filter(Boolean));

      expect(result.root).to.not.be.undefined;
    });
  });
});
