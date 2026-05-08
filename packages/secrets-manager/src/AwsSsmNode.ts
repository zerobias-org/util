import {
  SSMClient,
  GetParameterCommand,
  GetParametersCommand,
  GetParametersByPathCommand,
  PutParameterCommand,
  paginateDescribeParameters,
  paginateGetParametersByPath
} from '@aws-sdk/client-ssm';
import { IllegalArgumentError, NoSuchObjectError, UnexpectedError } from '@zerobias-org/types-core-js';
import { stringify } from 'safe-stable-stringify';

import { errorMessage, logger, Semaphore, sleep } from './common.js';
import { JsonNode } from './JsonNode.js';
import { DELIMITER, SecretType } from './SecretsManager.js';
import { TreeNode } from './TreeNode.js';
import { SecretNode } from './SecretNode.js';

export const ROOT = 'awsssm';

const keyId = process.env.HUB_AWS_SSM_KEY_ID;

export class AwsSsmNode extends TreeNode {
  client: SSMClient;

  readonly writableSecret: string | undefined = undefined;

  private semaphore = new Semaphore(5);

  private consecutiveFailures = 0;

  private readonly MAX_CONSECUTIVE_FAILURES = 5;

  constructor(
    client: SSMClient,
    path: string,
    type: SecretNode.TypeEnumDef,
    parent?: TreeNode
  ) {
    super(
      path,
      type,
      parent,
      true,
      async (resolvePath: string) => this.listChildrenResolver(this, resolvePath)
    );

    this.client = client;
    if (process.env.WRITABLE_SECRET) {
      [, this.writableSecret] = process.env.WRITABLE_SECRET.split(`${ROOT}.`);
    }
  }

  override async getChild(path: string, force = false): Promise<TreeNode> {
    logger.debug(`Inside ssm get child with path: ${path}`);
    if (this.writableSecret && path.includes(this.writableSecret)) {
      logger.debug(`getChild: path: ${path}, writableSecret: ${this.writableSecret}`);
      const splitWriatable = path.split(`${this.writableSecret}${DELIMITER}`)[1];
      if (splitWriatable) {
        const [postfix] = splitWriatable.split(DELIMITER);
        path = path.replace(`${DELIMITER}${postfix}`, `/${postfix}`);
      }
    }

    logger.debug(`${this.fullPath} getting child at ${path}`);
    if (path === '') {
      return this;
    }

    return this.resolveChild(path);
  }

  override async setValue(
    path: string,
    value: SecretType | Record<string, unknown>
  ): Promise<SecretNode> {
    if (path === ROOT) {
      throw new IllegalArgumentError('Path must be provided');
    }

     
    let [, paramName, ...subpath] = path.split(DELIMITER);
    if (this.writableSecret && path.includes(this.writableSecret)) {
      const postfix = subpath.shift();
      paramName = `${paramName}/${postfix}`;
    }

    logger.debug(`AwsSsmNode.setValue decoded ${path}: paramName=${paramName}, subpath=${subpath}`);

    let json = {};
    let secretNode = new AwsSsmNode(
      this.client,
      paramName,
      SecretNode.TypeEnum.Node,
      this
    );

    try {
      logger.debug(`Check if param already exists ${paramName}`);
      const val = await this.getParameterValue(this.client, paramName);
      logger.debug(`It did exist lets grab the node ${paramName}`);
      json = val;
      secretNode = await this.getChild(paramName) as AwsSsmNode;
    } catch {
      // doesn't exist, so let's create it
      logger.debug(`Param didnt exist lets create it ${paramName}`);
      this.children[paramName] = secretNode;
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
    logger.debug(`Updating secret at ${paramName} to ${stringify(json)}`);

    await this.client.send(new PutParameterCommand({
      Name: paramName,
      Value: JSON.stringify(json),
      Type: 'SecureString',
      KeyId: keyId,
      Overwrite: true,
      Tier: 'Intelligent-Tiering',
    }));
    this.childJSON[paramName] = json;
    return (subpath && subpath.length > 0
      ? new JsonNode(subObj, subpath[subpath.length - 1], secretNode)
      : secretNode
    ).asNode();
  }

  async resolveChild(path: string): Promise<TreeNode> {
    const [node, ...more] = path.split(DELIMITER);
    logger.debug(`node ${node}, more: ${more}`);

    this.handleCacheTimeout();
    let nodeValue: Record<string, any>;
    if (this.values[node]) {
      logger.debug(`We did hit values cache lets just return the value as a json node: ${node}`);
      if (more.length > 0) {
        throw new UnexpectedError(`Value at ${node} was not an object and more path was given ${JSON.stringify(more)}.`);
      }

      return new JsonNode(this.values[node], path, this);
    }

    if (this.childJSON[node]) {
      logger.debug(`We did hit childJSON cache lets just return the node: ${node}`);
      nodeValue = this.childJSON[node];
    } else {
      logger.debug(`We didnt hit childJSON cache lets fetch ssm param: ${node}`);
      const value = await this.getParameterValue(this.client, node);
      if (typeof value === 'string') {
        if (more.length > 0) {
          throw new UnexpectedError(`Value at ${node} was not an object and more path was given ${JSON.stringify(more)}.`);
        }

        this.values[node] = value;
        return new JsonNode(value, node, this);
      }

      this.childJSON[node] = value;
      nodeValue = value;
    }

    logger.debug(`Heres the nodes value whether it was cached or not: ${JSON.stringify(nodeValue)}`);
    if (more.length === 0) {
      return new JsonNode(nodeValue, node, this);
    }

    logger.debug(`Looking for value at path: ${more.join(DELIMITER)}`);
    let paramVal: string | number | boolean = '';
    let restCheck = more;
    do {
      const [first, ...rest] = restCheck;
      restCheck = rest;
      logger.debug(`first ${first}, rest: ${rest}`);
      if (nodeValue[first]) {
        logger.debug(`Value: ${nodeValue[first]}`);
        if ((nodeValue[first] instanceof Object)) {
          if (rest.length === 0) {
            return new JsonNode(nodeValue[first], node, this);
          }

          nodeValue = nodeValue[first];
        } else {
          if (rest.length > 0) {
            throw new UnexpectedError(`Value at ${first} was not an object and more path was given ${JSON.stringify(rest)}.`);
          }

          paramVal = nodeValue[first];
        }
      } else {
        logger.debug(`Unable to find node/value at ${first} inside nodeValue ${JSON.stringify(nodeValue)}`);
        throw new NoSuchObjectError('Node', first);
      }
    } while (restCheck.length > 0);

    logger.debug(`Ended do while with paramVal: ${paramVal}`);
    this.values[`${node}${DELIMITER}${more.join(DELIMITER)}`] = paramVal;
    return new JsonNode(paramVal, path, this);
  }

  async getParameterValue(
    client: SSMClient,
    name: string
  ): Promise<string | Record<string, any>> {
    logger.debug(`Getting parameter node ${name} from parent ${this.path}`);
    const secret = await client.send(new GetParameterCommand({
      Name: name,
      WithDecryption: true,
    }));
    logger.debug(`Got parameter value back: ${JSON.stringify(secret)}.`);
    if (secret.Parameter && secret.Parameter.Value) {
      try {
        return JSON.parse(secret.Parameter.Value);
      } catch {
        // Not json, treat as a string
        return secret.Parameter.Value;
      }
    }

    throw new NoSuchObjectError('Node', name);
  }

  async getParameterNode(
    client: SSMClient,
    name: string,
    parent: AwsSsmNode
  ): Promise<TreeNode> {
    const val = await this.getParameterValue(client, name);
    if (val instanceof Object) {
       
      return new AwsSsmNode(client, name, SecretNode.TypeEnum.Node, parent);
    }

    return new JsonNode(val, name, parent);
  }

  private async exponentialBackoff(retryCount: number): Promise<void> {
    const baseDelay = 1000;
    const maxDelay = 30_000;
    const backoffDelay = Math.min(baseDelay * 2 ** retryCount, maxDelay);
    const jitter = Math.random() * 0.1 * backoffDelay;
    await sleep(backoffDelay + jitter, backoffDelay + jitter + 100);
  }

  private async processParameterBatch(parameterNames: string[], node: AwsSsmNode): Promise<TreeNode[]> {
    const BATCH_SIZE = 10; // AWS GetParametersCommand max
    const results: TreeNode[] = [];

    // logger.info(`Starting batch processing of paramaters with size: ${BATCH_SIZE}`);
    for (let i = 0; i < parameterNames.length; i += BATCH_SIZE) {
      const batch = parameterNames.slice(i, i + BATCH_SIZE);
      let retryCount = 0;
      const maxRetries = 3;

      while (retryCount < maxRetries) {
        try {
          // Circuit breaker check
          if (this.consecutiveFailures >= this.MAX_CONSECUTIVE_FAILURES) {
            logger.warning('Circuit breaker activated, waiting 30 seconds before retrying');
            await sleep(30_000, 30_000);
            this.consecutiveFailures = 0;
          }

          // logger.info(`Processing new batch...`);
          const batchResponse = await node.client.send(new GetParametersCommand({
            Names: batch,
            WithDecryption: true,
          }));

          if (batchResponse.Parameters) {
            // logger.info(`Got valid batch back`);
            const batchPromises = batchResponse.Parameters.map(async (param) => {
              await this.semaphore.acquire();
              try {
                if (param.Name && param.Value) {
                  try {
                    JSON.parse(param.Value);
                    // logger.info(`Paramater ${param.Name} was an object, creating AwsSSM node`);
                    return new AwsSsmNode(node.client, param.Name, SecretNode.TypeEnum.Node, node);
                  } catch {
                    // logger.info(`Paramater ${param.Name} was not an object, creating Json node`);
                    return new JsonNode(param.Value, param.Name, node);
                  }
                } else {
                  throw new NoSuchObjectError('Parameter', param.Name || 'unknown');
                }
              } finally {
                this.semaphore.release();
              }
            });

            const batchResults = await Promise.all(batchPromises);
            results.push(...batchResults);
            this.consecutiveFailures = 0;
            // logger.info(`Processed ${results.length} parameters so far`);
          }

          // Handle invalid parameters if any
          if (batchResponse.InvalidParameters && batchResponse.InvalidParameters.length > 0) {
            logger.warning(`Invalid parameters: ${batchResponse.InvalidParameters.join(', ')}`);
          }

          break; // Success, exit retry loop
        } catch (error) {
          retryCount += 1;
          this.consecutiveFailures += 1;
          logger.warning(`Batch request failed (attempt ${retryCount}/${maxRetries}): ${errorMessage(error)}`);

          if (retryCount < maxRetries) {
            await this.exponentialBackoff(retryCount);
          } else {
            logger.error(`Failed to process batch after ${maxRetries} attempts`);
            // Continue to next batch rather than failing entirely
          }
        }
      }
    }

    return results;
  }

  async listChildrenResolver(node: AwsSsmNode, path: string): Promise<TreeNode[]> {
    if (path === ROOT) {
      const nodes: Array<TreeNode> = [];
      const parameterNames: string[] = [];

      // First, collect all parameter names using pagination
      try {
         
        for await (const params of paginateDescribeParameters({ client: node.client, pageSize: 50 }, {})) {
          if (!params.Parameters) {
            break;
          }

          logger.debug(`Got back ${params.Parameters.length} paginated parameters...`);
          for (const param of params.Parameters) {
            if (param.Name) {
              parameterNames.push(param.Name);
            }
          }
        }

        logger.debug(`Finished getting all ${parameterNames.length} parameters.`);
        // Process parameters in batches
        const batchResults = await this.processParameterBatch(parameterNames, node);
        nodes.push(...batchResults);
      } catch (error) {
        logger.error(`Error in listChildrenResolver: ${errorMessage(error)}`);
        throw error;
      }

      return nodes;
    }

    const [, secretName, ...subpath] = path.split(DELIMITER);
    logger.debug(`AwsSsmNode decoded ${path}: secretName=${secretName}, subpath=${subpath}`);
    const secret = await node.client.send(new GetParameterCommand({
      Name: secretName,
      WithDecryption: true,
    }));

    if (secret.Parameter && secret.Parameter.Value) {
      try {
        const json = JSON.parse(secret.Parameter.Value);
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
      } catch {
        // Not json, treat as a string
        return [new JsonNode(secret.Parameter.Value, secretName, node)];
      }
    }

    logger.debug('No such object');
    throw new NoSuchObjectError('Node', path);
  }
}
