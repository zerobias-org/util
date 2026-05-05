import { IllegalArgumentError, UnexpectedError } from '@zerobias-org/types-core-js';
import { SecretNode } from './SecretNode.js';
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

  constructor(val: JsonValueType, path: string, parent?: TreeNode) {
    super(
      path,
      getNodeType(val),
      parent,
      true,
      async () => Object.keys(this.val).map((k) => new JsonNode(this.val[k], k, this))
    );

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

    throw new UnexpectedError(`Secret node of unhandled type ${typeof this.val}`);
  }
}
