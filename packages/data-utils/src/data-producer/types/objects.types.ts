/**
 * Types for ObjectsApi - hierarchical object navigation
 */

/**
 * Object node in a hierarchical structure
 */
export interface ObjectNode {
  /**
   * Unique identifier for the object
   */
  id: string;

  /**
   * Display name of the object
   */
  name: string;

  /**
   * Object type identifier
   */
  type: string;

  /**
   * Parent object ID (null for root)
   */
  parentId?: string | null;

  /**
   * Schema ID for this object type
   */
  schemaId?: string;

  /**
   * Whether this object has children
   */
  hasChildren?: boolean;

  /**
   * Number of children (if known)
   */
  childCount?: number;

  /**
   * Additional metadata
   */
  metadata?: Record<string, any>;

  /**
   * Icon or visual representation hint
   */
  icon?: string;

  /**
   * Whether this object can be expanded
   */
  expandable?: boolean;

  /**
   * Path from root to this object
   */
  path?: string;

  /**
   * Object class (classification tags)
   */
  objectClass?: string | string[];

  /**
   * Allow any additional properties from the DataProducer API
   * This preserves all original properties from the API response
   */
  [key: string]: any;
}

/**
 * Full object data including content
 */
export interface ObjectData extends ObjectNode {
  /**
   * Object content/data
   */
  data?: any;

  /**
   * Related objects or references
   */
  references?: ObjectReference[];

  /**
   * Timestamps
   */
  createdAt?: string;
  updatedAt?: string;

  /**
   * Owner information
   */
  owner?: string;

  /**
   * Permissions
   */
  permissions?: ObjectPermissions;

  // Note: Inherits [key: string]: any from ObjectNode
}

/**
 * Reference to another object
 */
export interface ObjectReference {
  /**
   * Referenced object ID
   */
  id: string;

  /**
   * Reference type
   */
  type: string;

  /**
   * Reference name/label
   */
  name?: string;
}

/**
 * Object permissions
 */
export interface ObjectPermissions {
  /**
   * Can read the object
   */
  read: boolean;

  /**
   * Can write/update the object
   */
  write: boolean;

  /**
   * Can delete the object
   */
  delete: boolean;

  /**
   * Can share the object
   */
  share?: boolean;
}

/**
 * Object tree structure for hierarchical display
 */
export interface ObjectTree {
  /**
   * Root node
   */
  root: ObjectNode;

  /**
   * Child nodes by parent ID
   */
  children: Map<string, ObjectNode[]>;

  /**
   * All nodes by ID for quick lookup
   */
  nodesById: Map<string, ObjectNode>;
}
