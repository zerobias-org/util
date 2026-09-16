import { IllegalArgumentError } from '@zerobias-org/types-core-js';
import { SecretNode } from '../generated/model/index.js';
import { TreeNode } from './TreeNode.js';

type JsonValueType = object | string | number | boolean;

function getNodeType(val: JsonValueType): SecretNode.TypeEnumDef {
  if (typeof val === 'string'
      || typeof val === 'number'
      || typeof val === 'boolean'
      || Object.prototype.hasOwnProperty.call(val, 'length')) {
    return SecretNode.TypeEnum.Secret;
  }

  return SecretNode.TypeEnum.Node;
}

export class JsonNode extends TreeNode {
  val: JsonValueType;

  private readonly rawVal: JsonValueType;

  constructor(val: JsonValueType, path: string, parent?: TreeNode) {
    super(
      path,
      getNodeType(val),
      parent,
      true,
      async () => Object.keys(this.val).map((k) => new JsonNode(this.val[k], k, this))
    );

    this.rawVal = val;
    try {
      this.val = typeof val === 'string' ? JSON.parse(val) : val;
    } catch {
      this.val = val;
    }
  }

  async getValue(): Promise<string | number | boolean> {
    if (this.type !== SecretNode.TypeEnum.Secret) {
      throw new IllegalArgumentError('Cannot retrieve value from a non-leaf node');
    }

    if (typeof this.val === 'string') {
      return this.val as string;
    }

    if (typeof this.val === 'number') {
      return this.val as number;
    }

    if (typeof this.val === 'boolean') {
      return this.val as boolean;
    }

    if (typeof this.rawVal === 'string') {
      return this.rawVal;
    }
    return JSON.stringify(this.val);
  }
}
