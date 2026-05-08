import { IllegalArgumentError } from '@zerobias-org/types-core-js';
import stringify from 'safe-stable-stringify';

import { SecretNode } from '../generated/model/index.js';
import { TreeNode } from './TreeNode.js';
import { SecretType, DELIMITER } from './SecretsManager.js';
import { JsonNode } from './JsonNode.js';
import { VaultClient } from './VaultClient.js';
import { logger } from './common.js';

export const ROOT = 'vault';

function mapToNode(
  s: string,
  client: VaultClient,
  parent?: TreeNode
): VaultNode {

  return new VaultNode(
    client,
    s.endsWith('/') ? s.slice(0, Math.max(0, s.length - 1)) : s,
    SecretNode.TypeEnum.Node,
    !s.endsWith('/'),
    parent
  );
}

async function vaultResolver(node: VaultNode, path: string): Promise<TreeNode[]> {
  if (path === ROOT) {
    return node.client.listMounts()
      .then((mounts) => mounts.map((m) => mapToNode(m.name, node.client, node)));
  }
  const [, mount, ...subpath] = node.fullPath.split(DELIMITER);

  if (node.vaultSecret) {
    return node.client.getSecret(mount, subpath.join('/'))
      .then((obj) => Object.keys(obj.data || {}).map(
        (k) => new JsonNode((obj.data[k] || '') as unknown as object, k, node)
      ));
  }
  return node.client.listSecrets(mount, subpath.join('/'))
    .then((items) => items.map((i) => mapToNode(i, node.client, node)));
}

export class VaultNode extends TreeNode {
  client: VaultClient;

  vaultSecret = false;

  constructor(
    client: VaultClient,
    path: string,
    type: SecretNode.TypeEnumDef,
    vaultSecret = false,
    parent?: TreeNode
  ) {
    super(
      path,
      type,
      parent,
      true,
      async (resolvePath: string) => vaultResolver(this, resolvePath)
    );
    this.client = client;
    this.vaultSecret = vaultSecret;
  }

  async setValue(path: string, value: SecretType | Record<string, unknown>): Promise<SecretNode> {
    if (path === ROOT) {
      throw new IllegalArgumentError('Path must be provided');
    }
    const [, mount, ...subpath] = path.split(DELIMITER);
    let json: Record<string, unknown> = {};
    let vaultPath = subpath.join('/');

    logger.debug(`VaultNode.setValue decoded ${path}: mount=${mount} - subpath=${subpath} - vaultPath=${vaultPath}`);
    if (typeof value === 'object') {
      json = value;
    } else {
      const key = vaultPath.slice(Math.max(0, vaultPath.lastIndexOf('/')));
      vaultPath = vaultPath.slice(0, Math.max(0, vaultPath.lastIndexOf('/')));

      logger.debug(`Value was not an object, here is the mount=${mount} and vaultPath=${vaultPath} and key=${key}`);
      const val = await this.client.getSecret(mount, key);
      logger.debug(`Value back from key: ${val}`);
      if (val.data) {
        logger.debug(`Value had data: ${val.data}`);
        json = val.data;
      }

      json[key] = value;
    }

    logger.debug(`Upserting to mount=${mount}: vaultPath=${vaultPath} with value=${stringify(json)}`);
    await this.client.upsertSecret(
      mount,
      vaultPath,
      json,
    );
    const secretNode = new VaultNode(
      this.client,
      vaultPath,
      SecretNode.TypeEnum.Node,
      true,
      this
    );

    return (subpath && subpath.length > 0
      ? new JsonNode(value, vaultPath, secretNode) : secretNode).asNode();
  }
}
