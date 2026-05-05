/**
 * Representation of a node in a secrets manager's tree.
 *
 * A {@link SecretNode} is either a `Node` (intermediate path that contains
 * other nodes) or a `Secret` (leaf with a retrievable value).
 */
export class SecretNode {
  /** Hierarchical path to this node, joined with `.` (see {@link DELIMITER}). */
  path: string;

  /** Whether this node is an intermediate `Node` or a leaf `Secret`. */
  type: SecretNode.TypeEnumDef;

  /**
   * Best-effort indicator of whether the underlying provider is writable.
   * Per-node permissions are only discovered on actual write attempts.
   */
  writable: boolean;

  /**
   * Whether the provider this node belongs to is currently active. False
   * indicates a missing/invalid env var or a connect failure.
   */
  active: boolean;

  /** True iff a write probe to this node succeeded. */
  writeSuccess?: boolean;

  /** Error message captured on a failed write probe, if any. */
  writeError?: string;

  /** Error message captured on a failed connect, if any. */
  connectError?: string;

  constructor(
    path: string,
    type: SecretNode.TypeEnumDef,
    writable: boolean,
    active: boolean,
    writeSuccess?: boolean,
    writeError?: string,
    connectError?: string,
  ) {
    this.path = path;
    this.type = type;
    this.writable = writable;
    this.active = active;
    this.writeSuccess = writeSuccess;
    this.writeError = writeError;
    this.connectError = connectError;
  }

  /**
   * Construct a {@link SecretNode} from a plain object. Permissive — missing
   * fields default to falsy values to match the historical OpenAPI-generated
   * deserializer behavior. Prefer the constructor when you have all fields.
   */
  static newInstance(obj: Partial<SecretNode>): SecretNode {
    return new SecretNode(
      obj.path ?? '',
      obj.type ?? SecretNode.TypeEnum.Node,
      obj.writable ?? false,
      obj.active ?? false,
      obj.writeSuccess,
      obj.writeError,
      obj.connectError,
    );
  }
}

export namespace SecretNode {
  export const TypeEnum = {
    Node: 'Node',
    Secret: 'Secret',
  } as const;

  export type TypeEnumDef = typeof TypeEnum[keyof typeof TypeEnum];
}
