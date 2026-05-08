import { IllegalArgumentError, UnexpectedError } from '@zerobias-org/types-core-js';
import { SecretNode } from '../generated/model/index.js';
import { TreeNode } from './TreeNode.js';

export class EnvironmentNode extends TreeNode {
  async getValue(): Promise<string | number | boolean> {
    if (this.type !== SecretNode.TypeEnum.Secret) {
      throw new IllegalArgumentError('Cannot retrieve value from a non-leaf node');
    }
    const val = process.env[this.path];
    if (typeof val === 'string') {
      return val as string;
    }
    if (typeof val === 'number') {
      return val as number;
    }
    if (typeof val === 'boolean') {
      return val as boolean;
    }
    throw new UnexpectedError(`Secret node of unhandled type ${typeof val}`);
  }
}
