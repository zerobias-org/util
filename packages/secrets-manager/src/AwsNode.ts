import { IllegalArgumentError, NoSuchObjectError } from '@zerobias-org/types-core-js';
import stringify from 'safe-stable-stringify';

import { SecretNode } from '../generated/model/index.js';
import { AwsSecretsClient } from './AwsSecretsClient.js';
import { DELIMITER, SecretType } from './SecretsManager.js';
import { TreeNode } from './TreeNode.js';
import { JsonNode } from './JsonNode.js';
import { logger } from './common.js';

export const ROOT = 'aws';

async function resolver(node: AwsNode, path: string): Promise<TreeNode[]> {
  if (path === ROOT) {
    const names = await node.secretsManager.listSecretNames();
    return names.map((name) => new AwsNode(node.secretsManager, name, SecretNode.TypeEnum.Node, node));
  }

  const [, secretName, ...subpath] = path.split(DELIMITER);
  logger.debug(`AWSNode decoded ${path}: secretName=${secretName}, subpath=${stringify(subpath)}`);
  const secretString = await node.secretsManager.getSecretString(secretName);
  const json = JSON.parse(secretString);
  logger.debug('value: ${}', json);
  let subObj = json;
  if (subpath && subpath.length > 0) {
    // try to index into the object
    for (let i = 0, len = subpath.length; i < len; i += 1) {
      subObj = subObj[subpath[i]];
      if (!subObj) {
        // XXX: shouldn't ever hit this case...but check it to be pedantic
        throw new NoSuchObjectError('Node', path);
      }
    }
  }
  return Object.keys(subObj).map((k) => new JsonNode(subObj[k], k, node));
}

export class AwsNode extends TreeNode {
  secretsManager: AwsSecretsClient;

  readonly writableSecret: string | undefined = undefined;

  constructor(
    secretsManager: AwsSecretsClient,
    path: string,
    type: SecretNode.TypeEnumDef,
    parent?: TreeNode
  ) {

    super(
      path,
      type,
      parent,
      true,
      async (resolvePath: string) => resolver(this, resolvePath)
    );
    this.secretsManager = secretsManager;
    if (process.env.WRITABLE_SECRET && process.env.WRITABLE_SECRET.startsWith(ROOT)) {
      [, this.writableSecret] = process.env.WRITABLE_SECRET.split(`${ROOT}.`);
    }
    logger.debug('Created AWS Node ${}', this.asNode());
  }

  override async getChild(path: string, force = false): Promise<TreeNode> {
    if (this.writableSecret && path.includes(this.writableSecret)) {
      const [postfix, ...rest] = path.split(this.writableSecret)[1].split(DELIMITER);
      path = path.replace(`${DELIMITER}${postfix}`, `/${postfix}`);
    }
    return super.getChild(path, force);
  }

  override async setValue(
    path: string,
    value: SecretType | Record<string, unknown>
  ): Promise<SecretNode> {
    if (path === ROOT) {
      throw new IllegalArgumentError('Path must be provided');
    }


    let [, secretName, ...subpath] = path.split(DELIMITER);
    if (this.writableSecret && path.includes(this.writableSecret)) {
      const postfix = subpath.shift();
      secretName = `${secretName}/${postfix}`;
    }

    logger.debug(`AWSNode.setValue decoded ${path}: secretName=${secretName}, subpath=${subpath}`);
    let json = {};
    let secretNode = new AwsNode(this.secretsManager, secretName, SecretNode.TypeEnum.Node, this);
    try {
      const existing = await this.secretsManager.getSecretString(secretName);
      json = JSON.parse(existing);
      secretNode = await this.getChild(secretName) as AwsNode;
      logger.debug('Children keys: ${}', Object.keys(this.children));
    } catch {
      // doesn't exist, so let's create it
      await this.secretsManager.createSecret(secretName);
      this.children[secretName] = secretNode;
      logger.debug(`this.children ${this.children}`);
    }

    let subObj = json;
    if (subpath && subpath.length > 0) {
      // try to index into the object
      for (let i = 0, len = subpath.length; i < len; i += 1) {
        if (i === len - 1) {
          subObj[subpath[i]] = value;
        } else if (!subObj[subpath[i]]) {
          subObj[subpath[i]] = {};
        }
        subObj = subObj[subpath[i]];
      }
      secretNode.children = {};
    } else {
      json = value;
    }
    logger.debug(`Updating secret at ${secretName} to ${stringify(json)}`);
    await this.secretsManager.putSecretValue(secretName, JSON.stringify(json));

    return (subpath && subpath.length > 0
      ? new JsonNode(subObj, subpath[subpath.length - 1], secretNode)
      : secretNode
    ).asNode();
  }
}
