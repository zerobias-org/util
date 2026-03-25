/**
 * @zerobias-org/module-test-client
 *
 * Test runner and wire protocol client for Hub modules.
 *
 * Module developers write tests against the generated interface.
 * This package handles everything else:
 *   - Mode selection (direct/docker/hub) from TEST_MODE env
 *   - Wire protocol translation (manifest-driven)
 *   - Connection management
 *   - Secret resolution (via zbb secret get)
 *
 * Usage in test file:
 *   import { getClient } from '@zerobias-org/module-test-client';
 *
 *   describe('My Module', () => {
 *     let client;
 *     before(async () => { client = await getClient(); });
 *     it('works', async () => {
 *       const result = await client.getObjectsApi().getObject('/');
 *       expect(result).to.be.ok;
 *     });
 *   });
 *
 * Gradle sets: TEST_MODE, CONTAINER_URL, TARGET_ID, SECRET_NAME, MODULE_DIR
 *
 * Also exports:
 *   - OpenAPISchemaLoader — convention-based OpenAPI spec loader (derives spec name from package.json)
 */

export { OpenAPISchemaLoader, type OpenAPISchema } from './OpenAPISchemaLoader.js';

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import axios, { type AxiosInstance } from 'axios';
import https from 'node:https';

// ═══════════════════════════════════════════════════════════════════
// Wire Protocol Client (internal)
// ═══════════════════════════════════════════════════════════════════

export type WireProtocolMode = 'docker' | 'hub';

export interface WireProtocolConfig {
  mode: WireProtocolMode;
  baseUrl: string;
  connectionId?: string;
  targetId?: string;
  apiKey?: string;
  orgId?: string;
  moduleDir: string;
  errorDeserializer?: (data: unknown) => Error;
}

interface OperationMeta {
  operationId: string;
  apiClassMethod: string;
  apiClass: string;
  methodName: string;
  paramNames: string[];
}

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

function groupByApiClass(meta: Map<string, OperationMeta>): Map<string, OperationMeta[]> {
  const groups = new Map<string, OperationMeta[]>();
  for (const op of meta.values()) {
    const list = groups.get(op.apiClass) || [];
    list.push(op);
    groups.set(op.apiClass, list);
  }
  return groups;
}

export function createWireProtocolClient<T>(config: WireProtocolConfig): T {
  const meta = loadOperationMeta(config.moduleDir);
  const byApiClass = groupByApiClass(meta);

  const httpsAgent = new https.Agent({ rejectUnauthorized: false });
  const client: AxiosInstance = axios.create({
    baseURL: config.baseUrl,
    httpsAgent,
    timeout: 90000,
    validateStatus: () => true,
    headers: {
      'Content-Type': 'application/json',
      ...(config.apiKey ? { 'Authorization': `APIKey ${config.apiKey}` } : {}),
      ...(config.orgId ? { 'dana-org-id': config.orgId } : {}),
    },
  });

  function makeMethod(op: OperationMeta) {
    return async (...args: unknown[]) => {
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

      if (response.status >= 400) {
        if (config.errorDeserializer) {
          throw config.errorDeserializer(response.data);
        }
        const msg = response.data?.message || response.data?.error || `HTTP ${response.status}`;
        const err = new Error(msg);
        (err as any).statusCode = response.status;
        throw err;
      }

      // Debug: log raw response shape for hub mode
      if (config.mode === 'hub' && process.env.LOG_LEVEL === 'debug') {
        const keys = response.data ? Object.keys(response.data) : [];
        console.error(`[module-test-client] ${op.operationId}: status=${response.status} type=${typeof response.data} keys=[${keys.join(',')}]`);
      }

      return response.data;
    };
  }

  const apiProxies: Record<string, any> = {};
  for (const [apiClass, ops] of byApiClass) {
    const apiObj: Record<string, Function> = {};
    for (const op of ops) {
      apiObj[op.methodName] = makeMethod(op);
    }
    apiProxies[apiClass] = apiObj;
  }

  const proxy: any = {};
  for (const [apiClass] of byApiClass) {
    const getterName = `get${apiClass}`;
    proxy[getterName] = () => apiProxies[apiClass];
  }

  proxy.connect = async () => {};
  proxy.disconnect = async () => {};
  proxy.isConnected = async () => true;
  proxy.metadata = async () => ({});

  return proxy as T;
}

// ═══════════════════════════════════════════════════════════════════
// Test Runner — DI-based client provider
// ═══════════════════════════════════════════════════════════════════

/**
 * Resolve secret via zbb secret get.
 */
function getSecret(name: string): Record<string, unknown> {
  const json = execSync(`zbb secret get ${name}`, { encoding: 'utf-8' });
  return JSON.parse(json);
}

/**
 * Test context — holds the connected client and teardown function.
 * Module tests import this and use ctx.client.
 */
export interface TestContext<T = any> {
  client: T;
  mode: string;
  secretName: string;
  teardown: () => Promise<void>;
}

// Singleton context — initialized by getClient(), shared across tests
let _ctx: TestContext | null = null;

/**
 * Get or create the test client.
 *
 * Reads configuration from environment (set by Gradle):
 *   TEST_MODE     — direct | docker | hub
 *   MODULE_DIR    — path to module root (default: cwd)
 *   SECRET_NAME   — which secret to use (default: from module name)
 *   CONTAINER_URL — Docker container URL (docker mode)
 *   TARGET_ID     — Hub target UUID (hub mode)
 *   SERVER_URL    — Hub Server URL via Dana (hub mode)
 *   API_KEY       — Hub auth (hub mode)
 *   ORG_ID        — Org context (hub mode)
 *
 * For direct mode, also needs:
 *   DIRECT_IMPL   — path to module impl (e.g., ../../src/GithubImpl.js)
 *   DIRECT_PASCAL — pascal name of impl class (e.g., Github)
 *
 * @param errorDeserializer — CoreError.deserialize from consumer's types-core-js
 */
export async function getClient<T = any>(
  errorDeserializer?: (data: unknown) => Error
): Promise<T> {
  if (_ctx) return _ctx.client as T;

  const mode = process.env.TEST_MODE || 'direct';
  const moduleDir = process.env.MODULE_DIR || process.cwd();

  // Secret name: explicit env var, or discover first matching secret
  let secretName = process.env.SECRET_NAME;
  if (!secretName) {
    const moduleKey = readModuleKey(moduleDir);
    if (moduleKey) {
      const secrets = discoverSecrets(moduleKey);
      secretName = secrets[0]; // Use first matching secret
    }
  }
  if (!secretName) {
    throw new Error(
      'No SECRET_NAME set and no secrets found for this module.\n' +
      'Create one with: zbb secret create <name> --module <key> key=value'
    );
  }

  switch (mode) {
    case 'direct':
      _ctx = await createDirectContext(moduleDir, secretName);
      break;
    case 'docker':
      _ctx = await createDockerContext(moduleDir, secretName, errorDeserializer);
      break;
    case 'hub':
      _ctx = await createHubContext(moduleDir, secretName, errorDeserializer);
      break;
    default:
      throw new Error(`Unknown TEST_MODE: ${mode}. Use direct|docker|hub`);
  }

  return _ctx.client as T;
}

/**
 * Get the full test context (client + metadata).
 */
export async function getTestContext<T = any>(
  errorDeserializer?: (data: unknown) => Error
): Promise<TestContext<T>> {
  await getClient<T>(errorDeserializer);
  return _ctx as TestContext<T>;
}

/**
 * Teardown — call in after() hook.
 */
export async function teardown(): Promise<void> {
  if (_ctx) {
    await _ctx.teardown();
    _ctx = null;
  }
}

/**
 * Discover secrets for a module via `zbb secret list --module <key> --json`.
 * Returns array of secret names.
 */
function discoverSecrets(moduleKey: string): string[] {
  try {
    const json = execSync(`zbb secret list --module ${moduleKey} --json`, { encoding: 'utf-8' });
    const parsed = JSON.parse(json);
    // Handle both formats: ["name"] or [{name:"name", ...}]
    if (parsed.length > 0 && typeof parsed[0] === 'object') {
      return parsed.map((s: any) => s.name);
    }
    return parsed;
  } catch {
    return [];
  }
}

/**
 * Read module key from package.json in moduleDir.
 */
function readModuleKey(moduleDir: string): string {
  try {
    const pkg = JSON.parse(readFileSync(join(moduleDir, 'package.json'), 'utf-8'));
    return pkg.name || '';
  } catch {
    return '';
  }
}

/**
 * Describe a module test suite — auto-discovers secrets and runs once per secret.
 *
 * Usage:
 *   import { describeModule } from '@zerobias-org/module-test-client';
 *
 *   describeModule('SQL Module', (client) => {
 *     it('should get root', async () => {
 *       const root = await client.getObjectsApi().getObject('/');
 *       expect(root).to.be.ok;
 *     });
 *   });
 *
 * If SECRET_NAME env is set, runs only that secret.
 * Otherwise discovers all secrets matching the module's _module key.
 *
 * @param name — describe block name (secret name appended)
 * @param fn — test function receiving the connected client
 * @param errorDeserializer — CoreError.deserialize from consumer
 */
export function describeModule<T = any>(
  name: string,
  fn: (client: T) => void,
  errorDeserializer?: (data: unknown) => Error
): void {
  const mode = process.env.TEST_MODE || 'direct';
  const moduleDir = process.env.MODULE_DIR || process.cwd();
  const explicitSecret = process.env.SECRET_NAME;

  let secretNames: string[];

  if (explicitSecret) {
    secretNames = [explicitSecret];
  } else {
    const moduleKey = readModuleKey(moduleDir);
    secretNames = moduleKey ? discoverSecrets(moduleKey) : [];
    if (secretNames.length === 0) {
      // No secrets — warn and skip (allows gate to pass without credentials)
      describe(`${name} [${mode}]`, function () {
        it('SKIPPED — no secrets configured (run: zbb secret create <name> --module ' + moduleKey + ')', function () {
          console.warn(
            `⚠ No secrets found for module ${moduleKey}. ` +
            `E2E tests skipped. Create one with: zbb secret create <name> --module ${moduleKey} key=value`
          );
          this.skip();
        });
      });
      return;
    }
  }

  for (const secretName of secretNames) {
    describe(`${name} [${mode}] (${secretName})`, function () {
      this.timeout(120000);
      // Deferred client — proxy that forwards to the real client after before() runs
      const clientRef: { value: T | null } = { value: null };
      const clientProxy = new Proxy({} as any, {
        get(_target, prop) {
          if (!clientRef.value) throw new Error('Client not initialized — use inside it()');
          return (clientRef.value as any)[prop];
        },
      }) as T;

      before(async function () {
        // Reset singleton for each secret
        _ctx = null;
        process.env.SECRET_NAME = secretName;
        clientRef.value = await getClient<T>(errorDeserializer);
      });

      after(async function () {
        await teardown();
      });

      fn(clientProxy);
    });
  }
}

// ── Direct mode ──────────────────────────────────────────────

async function createDirectContext(
  moduleDir: string,
  secretName: string
): Promise<TestContext> {
  // Dynamic import of the module's impl class
  const pascal = process.env.DIRECT_PASCAL;
  const implPath = process.env.DIRECT_IMPL;

  if (!pascal || !implPath) {
    throw new Error(
      'Direct mode requires DIRECT_PASCAL and DIRECT_IMPL env vars.\n' +
      'Example: DIRECT_PASCAL=Github DIRECT_IMPL=../../src/GithubImpl.js'
    );
  }

  const implModule = await import(join(moduleDir, implPath));
  const ImplClass = implModule[`${pascal}Impl`];
  if (!ImplClass) {
    throw new Error(`${pascal}Impl not found in ${implPath}`);
  }

  const profileModule = await import(join(moduleDir, 'generated/model/index.js'));
  const { ConnectionProfile } = profileModule;

  const impl = new ImplClass();
  const secret = getSecret(secretName);
  const cp = ConnectionProfile.newInstance(secret);
  await impl.connect(cp);

  return {
    client: impl,
    mode: 'direct',
    secretName,
    teardown: async () => { try { await impl.disconnect(); } catch { /* ignore */ } },
  };
}

// ── Docker mode ──────────────────────────────────────────────

async function createDockerContext(
  moduleDir: string,
  secretName: string,
  errorDeserializer?: (data: unknown) => Error
): Promise<TestContext> {
  const containerUrl = process.env.CONTAINER_URL;
  if (!containerUrl) throw new Error('CONTAINER_URL not set — run via zbb testDocker');

  const secret = getSecret(secretName);

  // Create connection via wire protocol
  const httpsAgent = new https.Agent({ rejectUnauthorized: false });
  await axios.post(`${containerUrl}/connections`, {
    connectionId: 'e2e',
    connectionProfile: secret,
  }, { httpsAgent });

  const client = createWireProtocolClient({
    mode: 'docker',
    baseUrl: containerUrl,
    connectionId: 'e2e',
    moduleDir,
    errorDeserializer,
  });

  return {
    client,
    mode: 'docker',
    secretName,
    teardown: async () => {},
  };
}

// ── Hub mode ─────────────────────────────────────────────────

async function createHubContext(
  moduleDir: string,
  secretName: string,
  errorDeserializer?: (data: unknown) => Error
): Promise<TestContext> {
  const serverUrl = process.env.SERVER_URL;
  if (!serverUrl) throw new Error('SERVER_URL not set — slot must be loaded');

  const targetId = process.env.TARGET_ID;
  if (!targetId) throw new Error('TARGET_ID not set — run via zbb testHub');

  const apiKey = process.env.API_KEY;
  const orgId = process.env.ORG_ID;

  // Dynamic import of the module's hub-sdk (generated by buildHubSdk with -g hub-module)
  const hubSdkPath = join(moduleDir, 'hub-sdk', 'generated', 'api', 'index.js');
  const hubSdk = await import(hubSdkPath);

  // Find the main HubImpl class — the one that has connect() (extends HubConnector)
  // Individual API HubImpls (BinaryApiHubImpl etc.) don't have connect.
  // The main class name matches the module name + HubImpl (e.g., GithubHubImpl).
  const hubImplName = Object.keys(hubSdk).find(k => {
    if (!k.endsWith('HubImpl') || typeof hubSdk[k] !== 'function') return false;
    // Main client has connect() via HubConnector inheritance
    // Individual API HubImpls (BinaryApiHubImpl etc.) don't
    const inst = new hubSdk[k]();
    return typeof inst.connect === 'function';
  });
  if (!hubImplName) {
    throw new Error(`No HubImpl client class found in ${hubSdkPath}. Run: zbb buildHubSdk`);
  }

  const hubClient = new hubSdk[hubImplName]();
  const { URL: ZbURL, UUID, HubConnectionProfile } = await import('@zerobias-org/types-core-js');
  const profile = new HubConnectionProfile(
    new ZbURL(`${serverUrl}/api/hub`),
    new UUID(targetId),
    apiKey,
    orgId ? new UUID(orgId) : undefined,
  );
  await hubClient.connect(profile);

  return {
    client: hubClient,
    mode: 'hub',
    secretName,
    teardown: async () => {
      try { await hubClient.disconnect(); } catch { /* ignore */ }
    },
  };
}
