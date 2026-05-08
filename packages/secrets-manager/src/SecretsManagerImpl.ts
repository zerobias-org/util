import {
  IllegalArgumentError,
  InvalidStateError
} from '@zerobias-org/types-core-js';
import { SSMClient, DescribeParametersCommand } from '@aws-sdk/client-ssm';

import { AwsSecretsClient } from './AwsSecretsClient.js';
import { VaultAuth, VaultClient } from './VaultClient.js';
import { DefaultAzureCredential } from '@azure/identity';
import { KeyVaultManagementClient } from '@azure/arm-keyvault';
import stringify from 'safe-stable-stringify';
import axios from 'axios';
import { lstatSync } from 'node:fs';

import { SecretNode } from '../generated/model/index.js';
import { DELIMITER, SecretsManager, SecretType } from './SecretsManager.js';
import { TreeNode } from './TreeNode.js';
import { VaultNode, ROOT as VAULT_ROOT } from './VaultNode.js';
import { errorMessage, logger } from './common.js';
import { EnvironmentNode } from './EnvironmentNode.js';
import { AwsNode, ROOT as AWS_ROOT } from './AwsNode.js';
import { AzureNode, ROOT as AZURE_ROOT } from './AzureNode.js';
import { FileNode } from './FileNode.js';
import { AwsSsmNode, ROOT as AWS_SSM_ROOT } from './AwsSsmNode.js';

export class SecretsManagerImpl implements SecretsManager {
  private managers: Record<string, TreeNode> = {};

  constructor() {
    // environment
    this.managers.env = new TreeNode(
      'env',
      SecretNode.TypeEnum.Node,
      undefined,
      true,
      async () => Object.keys(process.env)
        // .filter((val) => !val.startsWith('VAULT_') && !val.startsWith('AWS_'))
        .map((val) => new EnvironmentNode(val, SecretNode.TypeEnum.Secret, this.managers.env))
    );

    // file system
    if (process.env.FILE_SECRET_ROOT) {
      try {
        const dirStat = lstatSync(process.env.FILE_SECRET_ROOT);
        if (dirStat.isDirectory()) {
          logger.info(`Enabling File Secrets Manager using root path ${process.env.FILE_SECRET_ROOT}`);
          this.managers.file = new FileNode('file', SecretNode.TypeEnum.Node, undefined);
        } else {
          this.managers.file = new TreeNode('file', SecretNode.TypeEnum.Node, undefined, false);
          this.managers.file.connectError = 'FILE_SECRET_NODE path is not a valid directory.';
        }
      } catch {
        this.managers.file = new TreeNode('file', SecretNode.TypeEnum.Node, undefined, false);
        this.managers.file.connectError = 'FILE_SECRET_NODE path does not exist.';
      }
    }
  }

  async init(): Promise<void> {
    if (this.managers.file && this.managers.file.active && process.env.WRITABLE_SECRET !== undefined) {
      // If file was active, then validate write if its writable
      const root = process.env.WRITABLE_SECRET.split(DELIMITER)[0];
      if (root === 'file') {
        // Need to test write on file, set writable false if failed
        this.managers.file.writable = true;
        try {
          const date = new Date().toISOString();
          await this.managers.file.setValue(`${process.env.WRITABLE_SECRET}.zerobias-write-validation`, { date });
          logger.info(`Tested write to azure at ${process.env.WRITABLE_SECRET}.zerobias-write-validation with value: ${date}`);
          this.managers.file.writeSuccess = true;
        } catch (error: any) {
          this.managers.file.writeSuccess = false;
          this.managers.file.writeError = error.message;
        }
      }
    }

    const disableExternalProviders = process.env.HUB_DISABLE_EXTERNAL_PROVIDERS ?? 'false';
    logger.info(`External secret providers disabled: ${disableExternalProviders}`);
    return Promise.all(
      disableExternalProviders === 'true'
        ? []
        : [
          this.registerVaultProvider(),
          this.registerAwsProvider(),
          this.registerAwsSsmProvider(),
          this.registerAzureProvider(),
        ]
    ).then(() => {
      logger.info(`Initialized SecretsManager with:\n${JSON.stringify(Object.keys(this.managers).map((key) => ({
        name: key,
        active: this.managers[key].active,
        writable: this.managers[key].writable,
        writeSuccess: this.managers[key].writeSuccess,
        writeError: this.managers[key].writeError,
        connectError: this.managers[key].connectError,
      })), null, 2)}`);
      return;
    });
  }

  async getRoot(providerKey: string): Promise<TreeNode> {
    let root = this.managers[providerKey];
    if (!root || !root?.active) {
      logger.info(`Provider ${providerKey} not found or inactive, attempting to reregister`);
      await this.reregisterProvider(providerKey);
      root = this.managers[providerKey];
      if (!root || !root?.active) {
        throw new InvalidStateError(`Secret manager ${providerKey}, is inactive. Most likely unable to connect either because of missing `
          + 'or invalid env variables.');
      }
    }

    return root;
  }

  async reregisterProvider(providerKey: string) {
    switch (providerKey) {
      case AWS_ROOT: {
        return this.registerAwsProvider();
      }
      case AWS_SSM_ROOT: {
        return this.registerAwsSsmProvider();
      }
      case AZURE_ROOT: {
        return this.registerAzureProvider();
      }
      case VAULT_ROOT: {
        return this.registerVaultProvider();
      }
      default: {
        logger.debug(`Cannot attempt to reregister ${providerKey}`);
        return;
      }
    }
  }

  async registerVaultProvider(retryCount: number = 0): Promise<void> {
    if (!process.env.VAULT_ADDR) return;

    const connectionTimeoutMs = process.env.VAULT_CONNECTION_TIMEOUT_MS
      ? Number.parseInt(process.env.VAULT_CONNECTION_TIMEOUT_MS, 10) : 10_000;
    const vaultRetry = process.env.NO_VAULT_RETRY === undefined;
    const maxRetries = process.env.VAULT_MAX_RETRIES
      ? Number.parseInt(process.env.VAULT_MAX_RETRIES, 10) : undefined;
    const retryMs = process.env.VAULT_RETRY_MS
      ? Number.parseInt(process.env.VAULT_RETRY_MS, 10) : 5000;

    const candidates = await this.getVaultConnectionProfiles();
    if (candidates.length === 0) {
      logger.info('Error connecting to vault: No vault connection profile found');
      this.managers.vault = new TreeNode('vault', SecretNode.TypeEnum.Node, undefined, false);
      this.managers.vault.connectError = 'No valid vault connection profile';
      return;
    }

    // Try each candidate in priority order. If one fails (expired token,
    // wrong credentials), fall through to the next before giving up.
    let lastError: any;
    for (const auth of candidates) {
      const { method } = auth;
      try {
        logger.info(`Connecting to vault via ${method}`);
        const timeoutPromise = new Promise<never>((_, reject) => {
          setTimeout(() => reject(new Error(`Vault connection timeout after ${connectionTimeoutMs}ms`)), connectionTimeoutMs);
        });
        const client = await Promise.race([VaultClient.connect(auth), timeoutPromise]);
        this.managers.vault = new VaultNode(
          client,
          'vault',
          SecretNode.TypeEnum.Node
        );
        if (process.env.WRITABLE_SECRET !== undefined) {
          const root = process.env.WRITABLE_SECRET.split(DELIMITER)[0];
          if (root === 'vault') {
            this.managers.vault.writable = true;
            try {
              const date = new Date().toISOString();
              await this.managers.vault.setValue(`${process.env.WRITABLE_SECRET}.zerobias-write-validation`, { date });
              logger.info(`Tested write to vault at ${process.env.WRITABLE_SECRET}.zerobias-write-validation with value: ${date}`);
              this.managers.vault.writeSuccess = true;
            } catch (error: any) {
              this.managers.vault.writeSuccess = false;
              this.managers.vault.writeError = error.message;
            }
          }
        }

        logger.info('Registered vault with SecretsManager');
        return; // connected successfully — done
      } catch (error: any) {
        logger.info(`Error connecting to vault via ${method}: ${error.message}`);
        lastError = error;
        // fall through to next candidate
      }
    }

    // All candidates failed
    const canRetry = vaultRetry && (maxRetries === undefined || retryCount < maxRetries);
    if (canRetry) {
      logger.info(`Error connecting to vault (attempt ${retryCount + 1}${maxRetries === undefined ? '' : ` of ${maxRetries + 1}`}): ${lastError?.message}, retrying in ${retryMs}ms`);
      setTimeout(() => {
        this.registerVaultProvider(retryCount + 1);
      }, retryMs);
    } else {
      logger.info(`Error connecting to vault: ${lastError?.message}, max retries (${maxRetries}) exhausted`);
    }

    this.managers.vault = new TreeNode('vault', SecretNode.TypeEnum.Node, undefined, false);
    this.managers.vault.connectError = lastError?.message ?? 'Invalid credentials';
  }

  private async getVaultConnectionProfiles(): Promise<VaultAuth[]> {
    if (!process.env.VAULT_ADDR) return [];

    const vaultAddr = await this.getConnectionProfileValue(process.env.VAULT_ADDR);
    const vaultNamespace = await this.getConnectionProfileValue(process.env.VAULT_NAMESPACE);
    const candidates: VaultAuth[] = [];

    // 1. Explicit token via VAULT_TOKEN env var (highest priority)
    if (process.env.VAULT_TOKEN) {
      const vaultToken = await this.getConnectionProfileValue(process.env.VAULT_TOKEN);
      if (vaultToken) {
        candidates.push({
          method: 'token',
          url: vaultAddr ?? '',
          accessToken: vaultToken,
          namespace: vaultNamespace,
        });
      }
    }

    // 2. Approle via env vars
    if (process.env.VAULT_ROLE_ID && process.env.VAULT_SECRET_ID) {
      const vaultRoleId = await this.getConnectionProfileValue(process.env.VAULT_ROLE_ID);
      const vaultSecretId = await this.getConnectionProfileValue(process.env.VAULT_SECRET_ID);
      const path = process.env.VAULT_AUTH_PATH ?? 'approle';
      if (vaultRoleId && vaultSecretId) {
        candidates.push({
          method: 'approle',
          url: vaultAddr ?? '',
          namespace: vaultNamespace,
          roleId: vaultRoleId,
          secretId: vaultSecretId,
          path,
        });
      }
    }

    // 3. Fallback: ~/.vault-token file (written by `vault login`).
    //    Only added if the file token differs from VAULT_TOKEN env var
    //    (avoids retrying the same stale token twice).
    try {
      const { readFileSync } = await import('node:fs');
      const { homedir } = await import('node:os');
      const tokenFile = `${homedir()}/.vault-token`;
      const fileToken = readFileSync(tokenFile, 'utf-8').trim();
      if (fileToken && fileToken !== process.env.VAULT_TOKEN) {
        candidates.push({
          method: 'token',
          url: vaultAddr ?? '',
          accessToken: fileToken,
          namespace: vaultNamespace,
        });
      }
    } catch {
      // ~/.vault-token doesn't exist or isn't readable
    }

    return candidates;
  }

  private async getConnectionProfileValue(path: string | undefined): Promise<string | undefined> {
    if (!path) return undefined;
    if (path.startsWith('aws')) {
      try {
        const value = await this.getValue(path);
        return value.toString();
      } catch {
        logger.debug(`Path ${path} not found, assuming it is a value`);
      }
    }
    return path;
  }

  async registerAwsProvider(): Promise<void> {
    const endpoint: string | undefined = process.env.AWS_ENDPOINT;
    const region: string | undefined = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION;

    const connectionTimeoutMs = process.env.AWS_CONNECTION_TIMEOUT_MS
      ? Number.parseInt(process.env.AWS_CONNECTION_TIMEOUT_MS, 10) : 10_000;

    const withTimeout = <T>(promise: Promise<T>, label: string): Promise<T> => {
      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error(`${label} connection timeout after ${connectionTimeoutMs}ms`)), connectionTimeoutMs);
      });
      return Promise.race([promise, timeoutPromise]);
    };

    let client: AwsSecretsClient | undefined;
    if (process.env.AWS_SECRET_ACCESS_KEY && process.env.AWS_ACCESS_KEY_ID
        && (region || endpoint)) {
      try {
        const candidate = new AwsSecretsClient({
          region,
          endpoint,
          credentials: {
            accessKeyId: process.env.AWS_ACCESS_KEY_ID,
            secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
          },
        });
        await withTimeout(candidate.ping(), 'AWS Secrets Manager');
        client = candidate;
      } catch (error: any) {
        logger.info(`Could not connect to AWS secrets - trying infrastructure mode: ${error.message}`);
      }
    }

    if (!client) {
      try {
        const candidate = new AwsSecretsClient({ region, endpoint });
        await withTimeout(candidate.ping(), 'AWS Secrets Manager (infrastructure)');
        client = candidate;
      } catch (error: any) {
        logger.info(`Could not connect to AWS secrets via infrastructure mode: ${error.message}`);
        this.managers.aws = new TreeNode('aws', SecretNode.TypeEnum.Node, undefined, false);
        this.managers.aws.connectError = error.message;
        return;
      }
    }

    this.managers.aws = new AwsNode(
      client,
      'aws',
      SecretNode.TypeEnum.Node,
      undefined
    );
    if (process.env.WRITABLE_SECRET !== undefined) {
      const root = process.env.WRITABLE_SECRET.split(DELIMITER)[0];
      if (root === 'aws') {
        // Need to test write on aws, set writable false if failed
        this.managers.aws.writable = true;
        try {
          const date = new Date().toISOString();
          await this.managers.aws.setValue(`${process.env.WRITABLE_SECRET}.zerobias-write-validation`, { date });
          logger.info(`Tested write to aws at ${process.env.WRITABLE_SECRET}.zerobias-write-validation with value: ${date}`);
          this.managers.aws.writeSuccess = true;
        } catch (error: any) {
          this.managers.aws.writeSuccess = false;
          this.managers.aws.writeError = error.message;
        }
      }
    }
  }

  async registerAwsSsmProvider(): Promise<void> {
    let endpoint: string | undefined;
    let region: string | undefined;
    if (process.env.AWS_ENDPOINT) {
      endpoint = process.env.AWS_ENDPOINT;
    }
    if (process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION) {
      region = (process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION) as string;
    }

    const connectionTimeoutMs = process.env.AWS_CONNECTION_TIMEOUT_MS
      ? Number.parseInt(process.env.AWS_CONNECTION_TIMEOUT_MS, 10) : 10_000;

    const withTimeout = <T>(promise: Promise<T>, label: string): Promise<T> => {
      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error(`${label} connection timeout after ${connectionTimeoutMs}ms`)), connectionTimeoutMs);
      });
      return Promise.race([promise, timeoutPromise]);
    };

    let client: SSMClient | undefined;
    if (process.env.AWS_SECRET_ACCESS_KEY && process.env.AWS_ACCESS_KEY_ID
        && (process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || process.env.AWS_ENDPOINT)) {
      try {
        client = new SSMClient({
          credentials: {
            accessKeyId: process.env.AWS_ACCESS_KEY_ID,
            secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
          },
          endpoint,
          region,
        });
        await withTimeout(client.send(new DescribeParametersCommand({})), 'AWS SSM');
      } catch (error) {
        logger.info(`Could not connect to AWS SSM - trying infrastructure mode: ${errorMessage(error)}`);
        client = undefined;
      }
    }

    if (!client) {
      try {
        client = new SSMClient({
          endpoint,
          region,
        });
        await withTimeout(client.send(new DescribeParametersCommand({})), 'AWS SSM (infrastructure)');
      } catch (error) {
        const msg = errorMessage(error);
        logger.info(`Could not connect to AWS SSM via infrastructure mode: ${msg}`);
        this.managers.awsssm = new TreeNode('awsssm', SecretNode.TypeEnum.Node, undefined, false);
        this.managers.awsssm.connectError = msg;
        return;
      }
    }

    this.managers.awsssm = new AwsSsmNode(
      client,
      'awsssm',
      SecretNode.TypeEnum.Node,
      undefined
    );
    if (process.env.WRITABLE_SECRET !== undefined) {
      const root = process.env.WRITABLE_SECRET.split(DELIMITER)[0];
      if (root === 'awsssm') {
        // Need to test write on awsssm, set writable false if failed
        this.managers.awsssm.writable = true;
        try {
          const date = new Date().toISOString();
          await this.managers.awsssm.setValue(`${process.env.WRITABLE_SECRET}.zerobias-write-validation`, { date });
          logger.info(`Tested write to awsssm at ${process.env.WRITABLE_SECRET}.zerobias-write-validation with value: ${date}`);
          this.managers.awsssm.writeSuccess = true;
        } catch (error: any) {
          this.managers.awsssm.writeSuccess = false;
          this.managers.awsssm.writeError = error.message;
        }
      }
    }
  }

  async registerAzureProvider(): Promise<void> {
    let subscriptionId: string;
    // Try the env var for local testing
    if (process.env.AZURE_SUBSCRIPTION_ID) {
      subscriptionId = process.env.AZURE_SUBSCRIPTION_ID;
      logger.info('Connecting to Azure KeyVault Management via given subscriptionId');
    } else {
      try {
        const metadataUrl = 'http://169.254.169.254/metadata/instance?api-version=2021-02-01';
        const metadataResponse = await axios.get(
          metadataUrl,
          {
            headers: { Metadata: 'true' },
            timeout: 2000,
          }
        );
        subscriptionId = metadataResponse.data.compute.subscriptionId;
        logger.info('Connecting to Azure KeyVault Management via infrastructure');
      } catch (error) {
        const msg = errorMessage(error);
        logger.debug(msg);
        logger.info(`Could not connect to Azure KeyVault Management via infrastructure mode: ${msg}`);
        return;
      }
    }

    if (!subscriptionId) {
      logger.info('No subscription ID found for Azure Key Vault');
      return;
    }

    try {
      // Test the credential first (faster, no network call)
      // logger.info(`About to grab default azure cred`);
      const credential = new DefaultAzureCredential();
      // logger.info(`We got default azure cred: ${JSON.stringify(credential)}`);

      // Create a timeout promise that rejects after 5 seconds
      const timeoutPromise = new Promise<KeyVaultManagementClient>((_, reject) => {
        setTimeout(() => reject(new Error('KeyVault connection timeout after 5 seconds')), 5000);
      });

      // Test credential authentication and service connectivity
      const azureTestPromise = (async () => {
        // logger.info(`Running get Token test on cred`);
        // First, test credential authentication
        await credential.getToken(['https://management.azure.com/.default']);
        // logger.info(`Successfully got Token`);

        // Then test service connectivity with a minimal API call
        const client = new KeyVaultManagementClient(credential, subscriptionId);
        // logger.info(`Successfully got client`);
        // Check if we can access the subscription - need to actually iterate to trigger the API call
         
        for await (const page of client.vaults.list({ top: 1 }).byPage({ maxPageSize: 1 })) {
          break;
        }

        // logger.info(`Successfully ran vaults list client`);
        return client;
      })();

      // Race the Azure test against the timeout
      const client = await Promise.race([azureTestPromise, timeoutPromise]);

      logger.info('Connected to Azure KeyVault Management via infrastructure mode');
      this.managers.azure = new AzureNode(
        client,
        'azure',
        SecretNode.TypeEnum.Node,
        undefined
      );
      if (process.env.WRITABLE_SECRET !== undefined) {
        const root = process.env.WRITABLE_SECRET.split(DELIMITER)[0];
        if (root === 'azure') {
          // Need to test write on azure, set writable false if failed
          this.managers.azure.writable = true;
          try {
            const date = new Date().toISOString();
            await this.managers.azure.setValue(`${process.env.WRITABLE_SECRET}.zerobias-write-validation`, { date });
            logger.info(`Tested write to azure at ${process.env.WRITABLE_SECRET}.zerobias-write-validation with value: ${date}`);
            this.managers.azure.writeSuccess = true;
          } catch (error: any) {
            this.managers.azure.writeSuccess = false;
            this.managers.azure.writeError = error.message;
          }
        }
      }
    } catch (error) {
      const msg = errorMessage(error);
      logger.info(`Could not connect to Azure KeyVault Management via infrastructure mode: ${msg}`);
      this.managers.azure = new TreeNode('azure', SecretNode.TypeEnum.Node, undefined, false);
      this.managers.azure.connectError = msg;
    }
  }

  async listNodes(path?: string): Promise<SecretNode[]> {
    logger.debug(`Listing nodes at ${path}`);
    if (!path || path === '') {
      return Object.keys(this.managers)
        .map((k) => this.managers[k].asNode());
    }

    const [providerKey, ...subpath] = path.split(DELIMITER);
    const root = await this.getRoot(providerKey);
    return root.getChild(subpath.join(DELIMITER))
      .then(async (node: TreeNode) => {
        if (node.type === SecretNode.TypeEnum.Node) {
          return node.listChildren()
            .then((nodes) => nodes.map(
              (n) => new SecretNode(n.path.split(DELIMITER).slice(-1)[0], n.type, n.writable, n.active, n.writeSuccess, n.writeError, n.connectError)
            ));
        }
        throw new IllegalArgumentError('Cannot list nodes of a Secret');
      });
  }

  async getValue(path: string): Promise<string | number | boolean> {
    logger.debug(`Resolving ${path}`);
    const [providerKey, ...subpathArr] = path.split(DELIMITER);
    const root = await this.getRoot(providerKey);
    const subPath = subpathArr.join(DELIMITER);
    if (root.values[subPath] !== undefined && root.values[subPath] !== null) {
      root.handleCacheTimeout();
      return root.values[subPath];
    }

    return root.getChild(subPath)
      .then(async (node: TreeNode) => {
        const value = await node.getValue();
        root.setValues(subPath, value);
        return value;
      });
  }

  async setValue(path: string, value: SecretType | Record<string, unknown>): Promise<SecretNode> {
    if (path === '') {
      throw new IllegalArgumentError('Cannot write secrets at the root');
    }

    const [providerKey] = path.split(DELIMITER);
    const root = await this.getRoot(providerKey);
    return root.setValue(path, value);
  }
}
