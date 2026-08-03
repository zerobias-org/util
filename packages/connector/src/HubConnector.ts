import { CoreError, DateTime, NotConnectedError } from '@zerobias-org/types-core-js';
import {
  ConnectionMetadata,
  ConnectionStatus,
  HubConnectionProfile,
  ObjectSerializer,
  OperationSupportStatus,
  OperationSupportStatusDef
} from '@zerobias-org/types-core-js';
import { LoggerEngine } from '@zerobias-org/logger';
import axios, { AxiosInstance } from 'axios';

import { Connector } from './Connector.js';
import { attachRetryInterceptor, loadRetryConfig, RetryConfig } from './HttpRetry.js';
import { isTransportError, markTransportFailure, transportCodeOf } from './TransportError.js';

const logger = LoggerEngine.root();

export class HubConnector implements Connector<HubConnectionProfile, void> {
  /**
   * Marks this build as retrying transient failures itself.
   *
   * hub-client used to monkey-patch `HubConnector.prototype.connect` at runtime to attach a
   * retry interceptor. If that patch stays active alongside the native implementation every
   * call retries twice over - a multiplied budget aimed at an already-struggling node - so the
   * patch must check this flag and stand down. It is deliberately a plain static boolean:
   * hub-client reads it off a copy of this package resolved from the collector's own
   * `node_modules`, which may predate this field and yield `undefined`.
   */
  static readonly hasNativeRetry = true;

  /**
   * Static registry of all HubConnector instances, mirroring BaseApiClient.onInstance in
   * @zerobias-org/util-api-client-base. Lets external tooling (loggers, request inspectors)
   * attach interceptors without patching the prototype.
   */
  private static _instances: Set<HubConnector> = new Set();

  private static _onInstanceCallbacks: Array<(connector: HubConnector) => void> = [];

  /**
   * Register a callback for every current and future HubConnector instance.
   *
   * Callbacks fire from the constructor, so `httpClient()` is still undefined at that point -
   * the axios instance is not created until connect(). Consumers that need the client should
   * keep the reference and read it after connect, or rely on the native retry instead.
   */
  static onInstance(callback: (connector: HubConnector) => void): void {
    HubConnector._onInstanceCallbacks.push(callback);
    Array.from(HubConnector._instances).forEach((instance) => callback(instance));
  }

  /** Remove a previously registered onInstance callback. */
  static removeOnInstance(callback: (connector: HubConnector) => void): void {
    const idx = HubConnector._onInstanceCallbacks.indexOf(callback);
    if (idx !== -1) HubConnector._onInstanceCallbacks.splice(idx, 1);
  }

  private _client?: AxiosInstance;

  private _headers: Record<string, string> = {};

  private _metadata = new ConnectionMetadata(ConnectionStatus.Off);

  private _retryConfig?: RetryConfig;

  constructor() {
    HubConnector._instances.add(this);
    HubConnector._onInstanceCallbacks.forEach((callback) => {
      try {
        callback(this);
      } catch (error) {
        // A misbehaving observer must never stop a connector from being constructed.
        logger.warning(`HubConnector.onInstance callback failed: ${(error as Error).message}`);
      }
    });
  }

  /**
   * Overrides the retry policy for this connector. Must be called before connect(), which is
   * where the interceptor is installed. Passing `{ attempts: 1 }` disables retrying.
   */
  configureRetry(config: Partial<RetryConfig>): void {
    this._retryConfig = { ...loadRetryConfig(), ...config };
  }

  protected get client(): AxiosInstance {
    if (!this._client) {
      throw new NotConnectedError();
    }
    return this._client;
  }

  protected get headers(): Record<string, string> {
    return this._headers;
  }

  /**
   * Connect to the service specified via the connection profile
   * @param {HubConnectionProfile} profile the connection profile to use for connecting
   * @returns {StateType} any connection state returned by connecting. This could include
   * refresh tokens, etc.
   */
  async connect(profile: HubConnectionProfile): Promise<void> {
    const base = profile.server.relative
      ? profile.server.path
      : `${profile.server.protocol}://${profile.server.host}${profile.server.path}`;
    if (profile.session) {
      this._headers.Authorization = `session ${profile.session}`;
    } else if (profile.apiKey) {
      this._headers.Authorization = `APIKey ${profile.apiKey}`;
    }
    if (profile.orgId) {
      this._headers['Dana-Org-Id'] = profile.orgId.toString();
    }
    this._client = axios.create({
      baseURL: `${base}/targets/${profile.targetId}${profile.server.search}${profile.server.hash}`,
      timeout: 119_634,
      headers: this._headers,
      withCredentials: typeof globalThis.window === 'object', // If running in a browser use withCredentials
    });
    this._metadata.connected = new DateTime(new Date());
    this._metadata.status = ConnectionStatus.Starting;

    // Attached first, and deliberately so. Axios runs response interceptors in registration
    // order, and the normalizing interceptor below rejects with CoreError.from(), which
    // discards the axios `config` a replay needs. Anything registered after it can see that a
    // call failed but can never repeat it - which is exactly why hub-client's runtime patch had
    // to reach into axios internals and reorder the handler chain. Here the ordering is ours.
    attachRetryInterceptor(
      this._client,
      this._retryConfig ?? loadRetryConfig(),
      this.constructor.name
    );

    this._client.interceptors.request.use((config) => {
      if (!this._metadata.bytesOut) {
        this._metadata.bytesOut = 0;
      }
      if (config.data) {
        this._metadata.bytesOut += JSON.stringify(config.data).length;
      }
      this._metadata.lastActivity = new DateTime(new Date());
      return config;
    }, (error) => Promise.reject(this.normalizeError(error)));

    this._client.interceptors.response.use((response) => {
      if (!this._metadata.bytesIn) {
        this._metadata.bytesIn = 0;
      }
      if (response.headers['content-length']) {
        this._metadata.bytesIn += Number(response.headers['content-length']);
      } else if (response.data) {
        this._metadata.bytesIn += JSON.stringify(response.data).length;
      }
      if (response.headers['hub-error'] === 'true') {
        this._metadata.status = ConnectionStatus.Error;
        return Promise.reject(CoreError.from(response.data));
      }
      this._metadata.status = ConnectionStatus.On;
      return response;
    }, (error) => Promise.reject(this.normalizeError(error)));

    // fetch all remote metadata - side-effect of updating _metadata
    await this.metadata();
  }

  /**
   * Collapses an axios failure into a CoreError, preserving the transport signal.
   *
   * Only ever touches the response body / message — never serializes or rejects the raw axios
   * error, response, or request, which carry circular ClientRequest/IncomingMessage refs that
   * crash JSON serialization downstream.
   *
   * When nothing came back off the wire, `CoreError.from()` flattens the failure into
   * `err.unexpected` and discards the system `code`, leaving callers to string-match the
   * message to tell a dropped socket from a module's own 500. The marker re-attaches that
   * signal as two primitives — see `isTransportFailure`.
   */
  private normalizeError(error: any): Error {
    this._metadata.status = ConnectionStatus.Error;
    if (error?.response) {
      // The server answered. That answer is the error, transport was fine.
      return CoreError.from(error.response.data);
    }
    if (error?.request) {
      logger.info('Most likely was a network error');
    } else {
      logger.info('Either we had bad error.response/request or just a different error: '
        + `${error?.message}`);
    }
    const converted = CoreError.from(error);
    return isTransportError(error)
      ? markTransportFailure(converted, transportCodeOf(error))
      : converted;
  }

  /**
   * @returns {boolean} indicates whether the connector is currently connected. This should be a
   * deep check to the underlying service
   */
  async isConnected(): Promise<boolean> {
    // TODO: API on /targets/{id} to check if the target is up/valid
    return !!this._client;
  }

  /**
   * Cleanly disconnects from the target service
   */
  async disconnect(): Promise<void> {
    this._client = undefined;
    this._metadata.status = ConnectionStatus.Off;
    this._metadata.disconnected = new DateTime(new Date());
  }

  async metadata(): Promise<ConnectionMetadata> {
    // fetch from server and merge
    if (this._client) {
      logger.info('Grabbing metadata...');
      const remote = await this._client.get('/metadata')
        .then((resp) => ObjectSerializer.deserialize(resp.data, 'ConnectionMetadata'));
      this._metadata.connectionProfile = remote.connectionProfile;
      this._metadata.remoteSystemInfo = remote.remoteSystemInfo;
      this._metadata.serverVersion = remote.serverVersion;
      this._metadata.tags = remote.tags;
      logger.info('Got metadata and set information.');
    }
    return this._metadata;
  }

  async isSupported(operationId: string): Promise<OperationSupportStatusDef> {
    if (this._client) {
      logger.info(`Checking if supported: ${operationId}...`);
      return await this._client.get(`/${operationId}/supported`)
        .then((resp) => ObjectSerializer.deserialize(resp.data, 'OperationSupportStatus'))
        .catch(() => OperationSupportStatus.Maybe);
    }
    return OperationSupportStatus.Maybe;
  }

  httpClient(): AxiosInstance | undefined {
    return this._client;
  }
}
