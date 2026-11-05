import { InvalidStateError, NoSuchObjectError, UnexpectedError } from '@zerobias-org/types-core-js';
import stringify from 'safe-stable-stringify';
import { SecretType, DELIMITER } from './SecretsManager.js';
import { SecretNode } from '../generated/model/index.js';
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

  private _cacheVersion = 0;

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

  /** The provider root this node hangs under; a root returns itself. */
  private get providerRoot(): TreeNode {
    return this.parent ? this.parent.providerRoot : this;
  }

  /**
   * Bumped on the provider root by every invalidate(). A fetch records it before it starts and caches
   * its result only if it is unchanged when the fetch returns, so a read that was in flight when a
   * write landed cannot put the pre-write content back.
   */
  get cacheVersion(): number {
    return this.providerRoot._cacheVersion;
  }

  setValues(key: string, value: string | number | boolean) {
    this._values[key] = value;
  }

  setChildJSON(key: string, value: Record<string, any>) {
    this._childJSON[key] = value;
  }

  /**
   * Drops what a write to `subPath` made stale, so the next read resolves from the backend
   * instead of waiting for the cache timeout. To be called on a provider root.
   *
   * - Cached values: the one at `subPath`, every one below it and every one above it. Values
   *   cached for other paths stay.
   * - Cached nodes: everything resolved below this root's children, which is where the content
   *   read from a secret lives. These are not matched against `subPath` because providers key
   *   them differently (a writable AWS secret is keyed `name/postfix` but addressed
   *   `name.postfix`). The root's own listing is kept.
   * - Fetches in flight: the cache version is bumped, so whatever they return is handed to their
   *   callers but not cached.
   *
   * @param subPath the written path below this provider root, i.e. a key of `values`
   */
  invalidate(subPath: string) {
    this.providerRoot._cacheVersion += 1;

    for (const key of Object.keys(this._values)) {
      if (key === subPath
        || key.startsWith(`${subPath}${DELIMITER}`)
        || subPath.startsWith(`${key}${DELIMITER}`)) {
        delete this._values[key];
      }
    }

    for (const child of Object.values(this.children)) {
      child.children = {};
    }
  }

  asNode(): SecretNode {
    return new SecretNode(this.fullPath, this.type, this.writable, this.active, this.writeSuccess, this.writeError, this.connectError);
  }

  /**
   * Arms the timer that empties this node's caches after `CACHE_TIMEOUT_SECONDS`, unless it is
   * already armed. The timer is unref'd: a cached secret must not keep a short-lived process, such
   * as a CLI, alive until the timeout.
   */
  handleCacheTimeout() {
    if (!this.cacheTimeoutId) {
      this.cacheTimeoutId = setTimeout(() => {
        clearTimeout(this.cacheTimeoutId);
        this.cacheTimeoutId = undefined;
        this.children = {};
        this._childJSON = {};
        this._values = {};
      }, cacheTimeout);
      this.cacheTimeoutId.unref();
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

    const children = await this.resolveChildren();
    return Object.values(children)
      .map((node) => node.asNode());
  }

  /**
   * Fetches this node's children when none are cached (or when `force`) and returns them. If a write
   * invalidated the provider while they were being fetched, they may predate it: they are returned to
   * this caller but not cached.
   */
  protected async resolveChildren(force = false): Promise<Record<string, TreeNode>> {
    if (!this.active) {
      throw new InvalidStateError('This node is not active, cannot resolveChildren');
    }

    if (!this.resolver || (!force && Object.keys(this.children).length > 0)) {
      return this.children;
    }

    const version = this.cacheVersion;
    const resolved: Record<string, TreeNode> = {};
    for (const node of await this.resolver(`${this.fullPath}`)) {
      resolved[node.path] = node;
    }
    if (this.cacheVersion !== version) {
      return resolved;
    }

    Object.assign(this.children, resolved);
    return this.children;
  }

  async getChild(path: string, force = false): Promise<TreeNode> {
    if (!this.active) {
      throw new InvalidStateError('This node is not active, cannot getChild');
    }

    if (path === '') {
      return this;
    }

    const [first, ...rest] = path.split(DELIMITER);
    const children = await this.resolveChildren(force);

    const child = children[first];
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
