import { IllegalArgumentError } from '@zerobias-org/types-core-js';
import { DefaultAzureCredential } from '@azure/identity';
import {
  KeyVaultManagementClient,
  Resource
} from '@azure/arm-keyvault';
import { KeyVaultSecret, SecretClient } from '@azure/keyvault-secrets';

import { logger } from './common.js';
import { JsonNode } from './JsonNode.js';
import { DELIMITER, SecretType } from './SecretsManager.js';
import { TreeNode } from './TreeNode.js';
import { SecretNode } from '../generated/model/index.js';

export const ROOT = 'azure';

async function getSecrets(path: string, credential: DefaultAzureCredential) {
  const value: KeyVaultSecret[] = [];
  const client = new SecretClient(`https://${path}.vault.azure.net`, credential);

   
  for await (const page of client.listPropertiesOfSecrets().byPage({ maxPageSize: 10 })) {
    const secrets = await Promise.all(page.map(async (properties) => {
      if (properties.enabled) {
        return client.getSecret(properties.name);
      }
      return null;
    }));
    for (const secret of secrets) {
      if (secret && secret?.value) {
        value.push(secret);
      }
    }
  }
  return value;
}

async function listVaults(managementClient: KeyVaultManagementClient) {
  const vaults: Array<Resource> = [];
   
  for await (const page of managementClient.vaults.list().byPage({ maxPageSize: 10 })) {
     
    for (const vault of page) {
      vaults.push(vault);
    }
  }
  return vaults;
}

async function resolver(node: AzureNode, path: string): Promise<TreeNode[]> {
  if (path === ROOT) {
    const vaults = await listVaults(node.managementClient);
    return vaults.map(
       
      (val) => new AzureNode(
        node.managementClient,
        val.name as string,
        SecretNode.TypeEnum.Node,
        node
      )
    );
  }

  const [, vaultName, subpath] = path.split(DELIMITER);
  logger.debug(`Azure KeyVault decoded: ${path}: vaultName=${vaultName}, subpath=${subpath}`);
  const secrets = await getSecrets(node.path, node.credential);
  return secrets.filter((secret) => secret.value).map((
    (secret) => {
      try {
        secret.value = JSON.parse(secret.value!);
      } catch {
        // no-op
      }
      return new JsonNode(secret.value!, secret.name, node);
    }));
}

export class AzureNode extends TreeNode {
  managementClient: KeyVaultManagementClient;

  credential: DefaultAzureCredential;

  constructor(
    managementClient: KeyVaultManagementClient,
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
    this.managementClient = managementClient;
    this.credential = new DefaultAzureCredential();
  }

  override async setValue(
    path: string,
    value: SecretType | Record<string, unknown>
  ): Promise<SecretNode> {
    if (path === ROOT) {
      throw new IllegalArgumentError('Path must be provided');
    }

    const [, vaultName, subpath] = path.split(DELIMITER);
    logger.debug(`AzureNode.setValue decoded ${path}: vaultName=${vaultName}, subpath=${subpath}`);
    const secretNode = new AzureNode(
      this.managementClient,
      vaultName,
      SecretNode.TypeEnum.Node,
      this
    );
    const client = new SecretClient(`https://${vaultName}.vault.azure.net`, this.credential);
    await client.setSecret(
      subpath,
      typeof value === 'object' ? JSON.stringify(value) : value.toString()
    );
    return (subpath && subpath.length > 0
      ? new JsonNode(value, subpath, secretNode) : secretNode).asNode();
  }
}
