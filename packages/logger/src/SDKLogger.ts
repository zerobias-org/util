/**
 * SDKLogger — auto-attaches request/response logging to all BaseApiClient instances.
 *
 * Usage:
 *   import { SDKLogger } from '@zerobias-org/logger/sdk';
 *   SDKLogger.install();   // attach to all current + future SDK clients
 *   SDKLogger.uninstall(); // detach from all
 *
 * Only logs when root logger level is DEBUG or more verbose.
 * Dynamic import of @zerobias-org/util-api-client-base — no hard dependency.
 */

import { LoggerEngine, LogLevel } from './index.js';

type BaseApiClientType = {
  onInstance(cb: (client: any) => void): void;
  removeOnInstance(cb: (client: any) => void): void;
};

let installedCallback: ((client: any) => void) | undefined;
let BaseApiClientRef: BaseApiClientType | undefined;

function shouldLog(): boolean {
  const level = LoggerEngine.root().getEffectiveLevel();
  return level >= LogLevel.DEBUG;
}

function attachToClient(client: any): void {
  // Skip if already has inspector attached by us
  if (client._sdkLoggerAttached) return;

  const axiosClient = client.httpClient?.();
  if (!axiosClient) return;

  const logger = LoggerEngine.root().get('sdk');

  axiosClient.interceptors.request.use(
    (config: any) => {
      if (shouldLog()) {
        const method = config.method?.toUpperCase() ?? '?';
        const url = config.baseURL
          ? `${config.baseURL}${config.url ?? ''}`
          : config.url ?? '?';
        const headers = { ...config.headers };
        // Mask auth header value
        if (headers.Authorization) {
          const parts = headers.Authorization.split(' ');
          if (parts.length === 2) {
            headers.Authorization = `${parts[0]} ${parts[1].slice(0, 4)}***`;
          }
        }
        logger.debug(`→ ${method} ${url}`, { headers, body: config.data });
      }
      return config;
    },
    (error: any) => Promise.reject(error)
  );

  axiosClient.interceptors.response.use(
    (response: any) => {
      if (shouldLog()) {
        const method = response.config.method?.toUpperCase() ?? '?';
        const url = response.config.baseURL
          ? `${response.config.baseURL}${response.config.url ?? ''}`
          : response.config.url ?? '?';
        logger.debug(`← ${method} ${url} ${response.status}`, { body: response.data });
      }
      return response;
    },
    (error: any) => {
      if (shouldLog()) {
        const config = error.config ?? {};
        const method = config.method?.toUpperCase() ?? '?';
        const url = config.baseURL
          ? `${config.baseURL}${config.url ?? ''}`
          : config.url ?? '?';
        const status = error.response?.status ?? 'ERR';
        logger.error(`← ${method} ${url} ${status}`, { body: error.response?.data, message: error.message });
      }
      return Promise.reject(error);
    }
  );

  client._sdkLoggerAttached = true;
}

export class SDKLogger {
  /**
   * Attach logging interceptors to all current and future BaseApiClient instances.
   * Only logs when root logger level is DEBUG.
   */
  static async install(): Promise<void> {
    if (installedCallback) return; // already installed

    try {
      const mod = await import('@zerobias-org/util-api-client-base');
      BaseApiClientRef = mod.BaseApiClient as any;
    } catch {
      // api-client-base not available — silently skip
      return;
    }

    installedCallback = attachToClient;
    BaseApiClientRef!.onInstance(installedCallback);
  }

  /**
   * Detach logging interceptors. Future instances won't get logging.
   * Already-attached interceptors remain (axios doesn't support removal by reference).
   */
  static uninstall(): void {
    if (!installedCallback || !BaseApiClientRef) return;
    BaseApiClientRef.removeOnInstance(installedCallback);
    installedCallback = undefined;
    BaseApiClientRef = undefined;
  }

  /**
   * Check if SDKLogger is currently installed.
   */
  static get installed(): boolean {
    return !!installedCallback;
  }
}
