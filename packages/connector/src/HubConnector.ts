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

const logger = LoggerEngine.root();

export class HubConnector implements Connector<HubConnectionProfile, void> {
  private _client?: AxiosInstance;

  private _headers: Record<string, string> = {};

  private _metadata = new ConnectionMetadata(ConnectionStatus.Off);

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

    this._client.interceptors.request.use((config) => {
      if (!this._metadata.bytesOut) {
        this._metadata.bytesOut = 0;
      }
      if (config.data) {
        this._metadata.bytesOut += JSON.stringify(config.data).length;
      }
      this._metadata.lastActivity = new DateTime(new Date());
      return config;
    }, (error) => {
      this._metadata.status = ConnectionStatus.Error;
      // Only ever touch the response body / message — never serialize or reject the
      // raw axios error, response, or request, which carry circular
      // ClientRequest/IncomingMessage refs that crash JSON serialization downstream.
      if (error.response) {
        return Promise.reject(CoreError.from(error.response.data));
      }
      if (error.request) {
        logger.info('Most likely was a network error');
        return Promise.reject(CoreError.from(error));
      }
      logger.info('Either we had bad error.response/request or just a different error: '
        + `${error.message}`);
      return Promise.reject(CoreError.from(error));
    });

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
    }, (error) => {
      this._metadata.status = ConnectionStatus.Error;
      // Only ever touch the response body / message — never serialize or reject the
      // raw axios error, response, or request, which carry circular
      // ClientRequest/IncomingMessage refs that crash JSON serialization downstream.
      if (error.response) {
        return Promise.reject(CoreError.from(error.response.data));
      }
      if (error.request) {
        logger.info('Most likely was a network error');
        return Promise.reject(CoreError.from(error));
      }
      logger.info('Either we had bad error.response/request or just a different error: '
        + `${error.message}`);
      return Promise.reject(CoreError.from(error));
    });

    // fetch all remote metadata - side-effect of updating _metadata
    await this.metadata();
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
      this._client.get(`/${operationId}/supported`)
        .then((resp) => ObjectSerializer.deserialize(resp.data, 'OperationSupportStatus'))
        .catch(() => OperationSupportStatus.Maybe);
    }
    return OperationSupportStatus.Maybe;
  }

  httpClient(): AxiosInstance | undefined {
    return this._client;
  }
}
