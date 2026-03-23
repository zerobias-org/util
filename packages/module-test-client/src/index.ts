/**
 * Wire Protocol Client — implements the generated module interface
 * by translating typed method calls to Docker or Hub wire protocol.
 *
 * Docker: POST /connections/{connId}/{ApiClass}.{method} with { argMap }
 * Hub:    PUT  /targets/{targetId}/{operationId} with flat args
 *
 * Reads manifest.json for operationId → ApiClass.method + param names.
 * Module-agnostic: works for any module (Github, Sql, etc.) as long as
 * generated/api/manifest.json exists with operations + operationParams.
 *
 * @package @zerobias-org/module-test-client
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import axios, { type AxiosInstance } from 'axios';
import https from 'node:https';
export type WireProtocolMode = 'docker' | 'hub';

export interface WireProtocolConfig {
  mode: WireProtocolMode;
  /** Base URL of the container (docker) or Hub Server (hub) */
  baseUrl: string;
  /** Connection ID for Docker mode */
  connectionId?: string;
  /** Target ID for Hub mode */
  targetId?: string;
  /** API key for Hub mode auth */
  apiKey?: string;
  /** Org ID for Hub mode auth */
  orgId?: string;
  /** Path to module directory (for manifest.json) */
  moduleDir: string;
  /** Error deserializer — pass CoreError.deserialize to get typed errors */
  errorDeserializer?: (data: unknown) => Error;
}

interface OperationMeta {
  operationId: string;
  apiClassMethod: string; // e.g., "OrganizationApi.listMyOrganizations"
  apiClass: string;       // e.g., "OrganizationApi"
  methodName: string;     // e.g., "listMyOrganizations"
  paramNames: string[];   // e.g., ["pageNumber", "pageSize"]
}

/**
 * Build operation metadata from manifest.json
 * manifest.operations: { opId: "ApiClass.method" }
 * manifest.operationParams: { opId: ["param1", "param2"] }
 */
function loadOperationMeta(moduleDir: string): Map<string, OperationMeta> {
  const manifestPath = join(moduleDir, 'generated', 'api', 'manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
  const operations: Record<string, string> = manifest.operations;
  const operationParams: Record<string, string[]> = manifest.operationParams || {};

  const meta = new Map<string, OperationMeta>();
  for (const [opId, apiClassMethod] of Object.entries(operations)) {
    const [apiClass, methodName] = apiClassMethod.split('.');
    meta.set(opId, {
      operationId: opId,
      apiClassMethod,
      apiClass,
      methodName,
      paramNames: operationParams[opId] || [],
    });
  }

  return meta;
}

/**
 * Group operations by API class name
 */
function groupByApiClass(meta: Map<string, OperationMeta>): Map<string, OperationMeta[]> {
  const groups = new Map<string, OperationMeta[]>();
  for (const op of meta.values()) {
    const list = groups.get(op.apiClass) || [];
    list.push(op);
    groups.set(op.apiClass, list);
  }
  return groups;
}

/**
 * Create a wire protocol client that implements the module's generated interface.
 *
 * Returns an object with getXxxApi() methods that return proxy objects.
 * Each proxy method call is translated to the wire protocol.
 */
export function createWireProtocolClient<T>(config: WireProtocolConfig): T {
  const meta = loadOperationMeta(config.moduleDir);
  const byApiClass = groupByApiClass(meta);

  // Create axios instance for HTTP calls
  const httpsAgent = new https.Agent({ rejectUnauthorized: false });
  const client: AxiosInstance = axios.create({
    baseURL: config.baseUrl,
    httpsAgent,
    timeout: 90000,
    validateStatus: () => true, // Don't throw on 4xx/5xx — we handle errors
    headers: {
      'Content-Type': 'application/json',
      ...(config.apiKey ? { 'Authorization': `APIKey ${config.apiKey}` } : {}),
      ...(config.orgId ? { 'dana-org-id': config.orgId } : {}),
    },
  });

  // Build a method handler for a single operation
  function makeMethod(op: OperationMeta) {
    return async (...args: unknown[]) => {
      // Map positional args to named params
      const argMap: Record<string, unknown> = {};
      for (let i = 0; i < op.paramNames.length && i < args.length; i++) {
        if (args[i] !== undefined) {
          argMap[op.paramNames[i]] = args[i];
        }
      }

      let response: any;

      if (config.mode === 'docker') {
        response = await client.post(
          `/connections/${config.connectionId}/${op.apiClassMethod}`,
          { argMap }
        );
      } else {
        response = await client.put(
          `/targets/${config.targetId}/${op.operationId}`,
          argMap
        );
      }

      // Check for error responses and deserialize to typed errors
      if (response.status >= 400) {
        if (config.errorDeserializer) {
          throw config.errorDeserializer(response.data);
        }
        const msg = response.data?.message || response.data?.error || `HTTP ${response.status}`;
        const err = new Error(msg);
        (err as any).statusCode = response.status;
        throw err;
      }

      return response.data;
    };
  }

  // Build the interface proxy
  // For each API class (OrganizationApi, RepoApi, etc.), create a getXxxApi() method
  // that returns an object with all the operations for that class
  const apiProxies: Record<string, any> = {};

  for (const [apiClass, ops] of byApiClass) {
    const apiObj: Record<string, Function> = {};
    for (const op of ops) {
      apiObj[op.methodName] = makeMethod(op);
    }
    apiProxies[apiClass] = apiObj;
  }

  // Create the top-level proxy with getXxxApi() methods
  const proxy: any = {};
  for (const [apiClass] of byApiClass) {
    // Convert "OrganizationApi" → "getOrganizationApi"
    const getterName = `get${apiClass}`;
    proxy[getterName] = () => apiProxies[apiClass];
  }

  // Add connect/disconnect stubs
  proxy.connect = async () => {};
  proxy.disconnect = async () => {};
  proxy.isConnected = async () => true;
  proxy.metadata = async () => ({});

  return proxy as T;
}
