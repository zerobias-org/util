/**
 * ObjectsApi - Hierarchical object navigation
 *
 * Provides methods for navigating hierarchical object structures
 * in a DataProducer, such as file systems, organizational trees,
 * or nested data structures.
 */

import { ObjectNode, ObjectData } from '../types/objects.types';
import { validateDefined } from '../../validation';

/**
 * ObjectsApi implementation
 *
 * This API provides hierarchical navigation through objects.
 * Objects are organized in a tree structure with parent-child relationships.
 */
export class ObjectsApi {
  private client: import('../DataProducerClient').DataProducerClient;

  /**
   * Create a new ObjectsApi instance
   *
   * @param client - DataProducerClient instance
   * @internal
   */
  constructor(client: import('../DataProducerClient').DataProducerClient) {
    this.client = client;
  }

  /**
   * Get the root object
   *
   * The root object is the top-level entry point for hierarchical navigation.
   * It typically represents the top of a file system, organization tree,
   * or other hierarchical structure.
   *
   * @returns Root object node
   * @throws DataProducerError if the operation fails
   *
   * @example
   * ```typescript
   * const client = new DataProducerClient(config);
   * await client.connect();
   * const root = await client.objects.getRoot();
   * console.log('Root:', root.name);
   * ```
   */
  public async getRoot(): Promise<ObjectNode> {
    try {
      const dataProducer = this.client.getDataProducer();
      const response = await dataProducer.getObjectsApi().getRootObject();

      // Validate the response
      validateDefined(response, 'ObjectsApi.getRoot', 'response');

      // Handle response that might be wrapped
      let rootObject = response;
      // if (response && typeof response === 'object' && !response.id && !response.objectId) {
      //   // Response might be wrapped - check for common wrapper properties
      //   if (response.data) {
      //     rootObject = response.data;
      //   } else if (response.object) {
      //     rootObject = response.object;
      //   } else if (response.root) {
      //     rootObject = response.root;
      //   }
      // }

      return this._normalizeObjectNode(rootObject);
    } catch (error) {
      this.client.handleError(error, 'Failed to get root object');
    }
  }

  /**
   * Get children of a specific object
   *
   * Returns all direct children of the specified object.
   * Children are objects that have the specified object as their parent.
   *
   * @param objectId - Object ID to get children for
   * @returns Array of child object nodes
   * @throws DataProducerError if the operation fails
   *
   * @example
   * ```typescript
   * const client = new DataProducerClient(config);
   * await client.connect();
   * const root = await client.objects.getRoot();
   * const children = await client.objects.getChildren(root.id);
   * console.log(`Found ${children.length} children`);
   * ```
   */
  public async getChildren(objectId: string): Promise<ObjectNode[]> {
    try {
      const dataProducer = this.client.getDataProducer();
      const response = await dataProducer.getObjectsApi().getChildren(objectId);

      // Validate the response exists
      validateDefined(response, 'ObjectsApi.getChildren', 'response');

      // Handle different response formats
      const children = response.items;
      return children.map((child: any) => this._normalizeObjectNode(child));
    } catch (error) {
      this.client.handleError(error, `Failed to get children for object ${objectId}`);
    }
  }

  /**
   * Get a specific object by ID
   *
   * Retrieves detailed information about a specific object,
   * including its content and metadata.
   *
   * @param objectId - Object ID to retrieve
   * @returns Object data with full details
   * @throws DataProducerError if the operation fails
   *
   * @example
   * ```typescript
   * const client = new DataProducerClient(config);
   * await client.connect();
   * const object = await client.objects.getObject('object-123');
   * console.log('Object data:', object.data);
   * ```
   */
  public async getObject(objectId: string): Promise<ObjectData> {
    try {
      const dataProducer = this.client.getDataProducer();
      const objectsApi = dataProducer.getObjectsApi();

      // Check if getObject method exists, otherwise fall back to getChildren approach
      let objectData: any;
      if (typeof objectsApi.getObject === 'function') {
        objectData = await objectsApi.getObject(objectId);
      } else {
        // Fallback: Some implementations may not have getObject,
        // so we construct it from available data
        objectData = await objectsApi.getChildren(objectId);
        if (!objectData) {
          throw new Error(`Object ${objectId} not found`);
        }
      }

      // Validate the response
      validateDefined(objectData, 'ObjectsApi.getObject', 'objectData');

      return this._normalizeObjectData(objectData);
    } catch (error) {
      this.client.handleError(error, `Failed to get object ${objectId}`);
    }
  }

  /**
   * Normalize an object node to ensure consistent structure
   *
   * @param node - Raw object node from DataProducer API
   * @returns Normalized ObjectNode
   * @private
   */
  private _normalizeObjectNode(node: any): ObjectNode {
    // Preserve all original properties and overlay normalized ones
    return {
      ...node, // Keep all original properties
      id: node.id || node.objectId || '',
      name: node.name || node.displayName || '',
      type: node.type || node.objectType || '',
      parentId: node.parentId || node.parent || undefined,
      schemaId: node.schemaId || node.schema || undefined,
      hasChildren: node.hasChildren === undefined ? (node.childCount > 0) : node.hasChildren,
      childCount: node.childCount || 0,
      metadata: node.metadata || {},
      icon: node.icon || undefined,
      expandable: node.expandable === undefined ? node.hasChildren : node.expandable,
      path: node.path || undefined,
      objectClass: node.objectClass || undefined
    };
  }

  /**
   * Normalize object data to ensure consistent structure
   *
   * @param data - Raw object data from DataProducer API
   * @returns Normalized ObjectData
   * @private
   */
  private _normalizeObjectData(data: any): ObjectData {
    const baseNode = this._normalizeObjectNode(data);

    // Overlay specific ObjectData properties without losing base node data
    return {
      ...baseNode, // This already includes all original properties
      data: data.data || data.content || undefined,
      references: data.references || data.links || undefined,
      createdAt: data.createdAt || data.created || undefined,
      updatedAt: data.updatedAt || data.modified || undefined,
      owner: data.owner || data.ownerId || undefined,
      permissions: data.permissions ? {
        read: data.permissions.read !== false,
        write: data.permissions.write === true,
        delete: data.permissions.delete === true,
        share: data.permissions.share === true
      } : undefined
    };
  }

  /**
   * Build a tree structure from a flat list of objects
   *
   * This utility method helps construct a hierarchical tree
   * from a flat list of objects with parent-child relationships.
   *
   * @param objects - Array of object nodes
   * @param rootId - Optional root object ID (uses first object if not specified)
   * @returns Object tree structure
   *
   * @example
   * ```typescript
   * const client = new DataProducerClient(config);
   * await client.connect();
   * const root = await client.objects.getRoot();
   * const children = await client.objects.getChildren(root.id);
   * const tree = client.objects.buildTree([root, ...children], root.id);
   * ```
   */
  public buildTree(objects: ObjectNode[], rootId?: string): { root?: ObjectNode; children: Map<string, ObjectNode[]> } {
    const children = new Map<string, ObjectNode[]>();
    let root: ObjectNode | undefined;

    // Handle empty array gracefully
    if (objects.length === 0) {
      return { root: undefined, children };
    }

    // Normalize all objects first to handle different property names
    const normalizedObjects = objects.map(obj => this._normalizeObjectNode(obj));

    // Find root and organize children
    for (const obj of normalizedObjects) {
      if (rootId && obj.id === rootId) {
        root = obj;
      } else if (!rootId && (!obj.parentId)) {
        root = obj;
      }

      // Add to children map only if object has a parent
      if (obj.parentId) {
        const parentId = obj.parentId;
        if (!children.has(parentId)) {
          children.set(parentId, []);
        }
        children.get(parentId)!.push(obj);
      }
    }

    if (!root && normalizedObjects.length > 0) {
      root = normalizedObjects[0];
    }

    if (!root) {
      throw new Error('No root object found in provided objects');
    }

    return { root, children };
  }
}
