import { InvalidStateError, NoSuchObjectError, UnexpectedError } from '@zerobias-org/types-core-js';
import stringify from 'safe-stable-stringify';
import { SecretType, DELIMITER } from './SecretsManager.js';
import { SecretNode } from './SecretNode.js';
import { logger } from './common.js';

const cacheTimeout = 1000 * (
  process.env.CACHE_TIMEOUT_SECONDS
    ? Number.parseInt(process.env.CACHE_TIMEOUT_SECONDS, 10) : 300);

export class TreeNode {
  readonly path: string;

  readonly type: SecretNode.TypeEnumDef;

  readonly parent?: TreeNode;

  private _writable = false;

  private _writeSuccess = false;

  private _writeError?: string;

  private _connectError?: string;

  private readonly _active: boolean = false;

  protected children: Record<string, TreeNode>;

  protected _childJSON: Record<string, Record<string, any>>;

  protected _values: Record<string, (string | number | boolean)>;

  private resolver?: (path: string) => Promise<TreeNode[]>;

  private cacheTimeoutId: NodeJS.Timeout | undefined;

  constructor(
    path: string,
    type: SecretNode.TypeEnumDef,
    parent?: TreeNode,
    active?: boolean,
    resolver?: (path: string) => Promise<TreeNode[]>
  ) {
    this.path = path;
    this.type = type;
    this.resolver = resolver;
    this.parent = parent;
    this.children = {};
    this._childJSON = {};
    this._values = {};
    if (parent) {
      this._writable = parent.writable;
      this._writeSuccess = parent.writeSuccess;
    }

    if (active) {
      this._active = true;
    }

    this.cacheTimeoutId = undefined;
  }

  get values() {
    return this._values;
  }

  get childJSON() {
    return this._childJSON;
  }

  set writable(writable: boolean) {
    this._writable = writable;
  }

  get writable(): boolean {
    return this._writable;
  }

  set writeSuccess(writeSuccess: boolean) {
    this._writeSuccess = writeSuccess;
  }

  get writeSuccess(): boolean {
    return this._writeSuccess;
  }

  set writeError(writeError: string | undefined) {
    this._writeError = writeError;
  }

  get writeError(): string | undefined {
    return this._writeError;
  }

  set connectError(connectError: string | undefined) {
    this._connectError = connectError;
  }

  get connectError(): string | undefined {
    return this._connectError;
  }

  get active(): boolean {
    return this._active;
  }

  get fullPath(): string {
    if (this.parent?.fullPath) {
      return `${this.parent.fullPath}${DELIMITER}${this.path}`;
    }

    return this.path;
  }

  setValues(key: string, value: string | number | boolean) {
    this._values[key] = value;
  }

  setChildJSON(key: string, value: Record<string, any>) {
    this._childJSON[key] = value;
  }

  asNode(): SecretNode {
    return new SecretNode(this.fullPath, this.type, this.writable, this.active, this.writeSuccess, this.writeError, this.connectError);
  }

  handleCacheTimeout() {
    if (!this.cacheTimeoutId) {
      this.cacheTimeoutId = setTimeout(() => {
        clearTimeout(this.cacheTimeoutId);
        this.cacheTimeoutId = undefined;
        this.children = {};
        this._childJSON = {};
        this._values = {};
      }, cacheTimeout);
    }
  }

  async listChildren(): Promise<SecretNode[]> {
    if (!this.active) {
      throw new InvalidStateError('This node is not active, cannot listChildren');
    }

    if (this.type === SecretNode.TypeEnum.Secret) {
      return [];
    }

    this.handleCacheTimeout();

    if (Object.keys(this.children).length === 0) {
      await this.resolveChildren();
    }

    return Object.values(this.children)
      .map((node) => node.asNode());
  }

  protected async resolveChildren(force = false): Promise<void> {
    if (!this.active) {
      throw new InvalidStateError('This node is not active, cannot resolveChildren');
    }

    if (this.resolver && (force || Object.keys(this.children).length === 0)) {
      return this.resolver(`${this.fullPath}`)
        .then((nodes: TreeNode[]) => { for (const node of nodes) {
          this.children[node.path] = node;
        } });
    }

    return;
  }

  async getChild(path: string, force = false): Promise<TreeNode> {
    if (!this.active) {
      throw new InvalidStateError('This node is not active, cannot getChild');
    }

    if (path === '') {
      return this;
    }

    const [first, ...rest] = path.split(DELIMITER);
    await this.resolveChildren(force);

    const child = this.children[first];
    if (child) {
      if (rest.length > 0) {
        return child.getChild(rest.join(DELIMITER));
      }
      return child;
    }

    if (force) {
      throw new NoSuchObjectError('Secret Node', path);
    } else {
      return this.getChild(path, true);
    }
  }

   
  async getValue(): Promise<string | number | boolean> {
    throw new UnexpectedError('Unimplemented');
  }

  async setValue(path: string, value: SecretType | Record<string, unknown>): Promise<SecretNode> {
    throw new UnexpectedError('Unimplemented');
  }
}
