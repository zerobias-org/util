/**
 * Request inspection and observability utilities
 * @module RequestInspector
 */

import { AxiosInstance, AxiosRequestConfig, AxiosResponse } from 'axios';

/**
 * Represents a captured HTTP request/response
 */
export interface RequestRecord {
  /** Request timestamp */
  timestamp: Date;
  /** HTTP method (GET, POST, etc.) */
  method: string;
  /** Full request URL */
  url: string;
  /** Request headers */
  headers: Record<string, string>;
  /** Request body (if any) */
  body?: any;
  /** Response details (if request completed) */
  response?: {
    /** HTTP status code */
    status: number;
    /** Response headers */
    headers: Record<string, string>;
    /** Response body */
    body: any;
    /** Request duration in milliseconds */
    duration: number;
  };
  /** Error details (if request failed) */
  error?: Error;
}

/**
 * Request callback function type
 */
export type RequestCallback = (config: AxiosRequestConfig) => void;

/**
 * Response callback function type
 */
export type ResponseCallback = (response: AxiosResponse) => void;

/**
 * Error callback function type
 */
export type ErrorCallback = (error: any) => void;

/**
 * Inspects and records HTTP requests/responses for debugging
 *
 * Attaches interceptors to Axios instance to capture all HTTP traffic.
 * Useful for debugging, testing, and observability.
 *
 * @example
 * ```typescript
 * const inspector = new RequestInspector(axiosClient);
 *
 * // Add custom callbacks
 * inspector.onRequest(config => {
 *   console.log(`Making request: ${config.method} ${config.url}`);
 * });
 *
 * inspector.onResponse(response => {
 *   console.log(`Response status: ${response.status}`);
 * });
 *
 * // Make requests...
 * await client.someOperation();
 *
 * // Review history
 * const history = inspector.getRequestHistory();
 * console.log(`Made ${history.length} requests`);
 *
 * history.forEach(record => {
 *   console.log(`${record.method} ${record.url} - ${record.response?.status}`);
 *   console.log(`Duration: ${record.response?.duration}ms`);
 * });
 * ```
 */
export class RequestInspector {
  private requestHistory: RequestRecord[] = [];
  private requestCallbacks: RequestCallback[] = [];
  private responseCallbacks: ResponseCallback[] = [];
  private errorCallbacks: ErrorCallback[] = [];
  private requestTimestamps: Map<AxiosRequestConfig, number> = new Map();

  /**
   * Creates RequestInspector and attaches to Axios instance
   *
   * @param axiosInstance - Axios instance to inspect
   */
  constructor(private axiosInstance: AxiosInstance) {
    this.attachInterceptors();
  }

  /**
   * Attaches request/response interceptors to Axios
   * @private
   */
  private attachInterceptors(): void {
    // Request interceptor
    this.axiosInstance.interceptors.request.use(
      (config) => {
        const timestamp = Date.now();
        this.requestTimestamps.set(config, timestamp);

        // Create record
        const record: RequestRecord = {
          timestamp: new Date(timestamp),
          method: config.method?.toUpperCase() || 'GET',
          url: this.buildFullUrl(config),
          headers: { ...config.headers } as Record<string, string>,
          body: config.data,
        };

        this.requestHistory.push(record);

        // Invoke callbacks
        this.requestCallbacks.forEach(cb => {
          try {
            cb(config);
          } catch (error) {
            console.error('Error in request callback:', error);
          }
        });

        return config;
      },
      (error) => {
        return Promise.reject(error);
      }
    );

    // Response interceptor
    this.axiosInstance.interceptors.response.use(
      (response) => {
        const startTime = this.requestTimestamps.get(response.config);
        const duration = startTime ? Date.now() - startTime : 0;
        this.requestTimestamps.delete(response.config);

        // Find corresponding request record
        const url = this.buildFullUrl(response.config);
        const record = this.requestHistory
          .slice()
          .reverse()
          .find(r => r.url === url && !r.response && !r.error);

        if (record) {
          record.response = {
            status: response.status,
            headers: { ...response.headers } as Record<string, string>,
            body: response.data,
            duration,
          };
        }

        // Invoke callbacks
        this.responseCallbacks.forEach(cb => {
          try {
            cb(response);
          } catch (error) {
            console.error('Error in response callback:', error);
          }
        });

        return response;
      },
      (error) => {
        if (error.config) {
          const startTime = this.requestTimestamps.get(error.config);
          const duration = startTime ? Date.now() - startTime : 0;
          this.requestTimestamps.delete(error.config);

          // Find corresponding request record
          const url = this.buildFullUrl(error.config);
          const record = this.requestHistory
            .slice()
            .reverse()
            .find(r => r.url === url && !r.response && !r.error);

          if (record) {
            record.error = error;
            if (error.response) {
              record.response = {
                status: error.response.status,
                headers: { ...error.response.headers } as Record<string, string>,
                body: error.response.data,
                duration,
              };
            }
          }
        }

        // Invoke callbacks
        this.errorCallbacks.forEach(cb => {
          try {
            cb(error);
          } catch (error) {
            console.error('Error in error callback:', error);
          }
        });

        return Promise.reject(error);
      }
    );
  }

  /**
   * Builds full URL from Axios config
   * @private
   */
  private buildFullUrl(config: AxiosRequestConfig): string {
    if (config.baseURL) {
      return `${config.baseURL}${config.url || ''}`;
    }
    return config.url || '';
  }

  /**
   * Registers callback for request events
   *
   * Callback is invoked before each request is sent.
   *
   * @param callback - Function to call on each request
   *
   * @example
   * ```typescript
   * inspector.onRequest(config => {
   *   console.log(`Request: ${config.method} ${config.url}`);
   *   console.log('Headers:', config.headers);
   * });
   * ```
   */
  onRequest(callback: RequestCallback): void {
    this.requestCallbacks.push(callback);
  }

  /**
   * Registers callback for response events
   *
   * Callback is invoked after each successful response.
   *
   * @param callback - Function to call on each response
   *
   * @example
   * ```typescript
   * inspector.onResponse(response => {
   *   console.log(`Response: ${response.status}`);
   *   console.log('Body:', response.data);
   * });
   * ```
   */
  onResponse(callback: ResponseCallback): void {
    this.responseCallbacks.push(callback);
  }

  /**
   * Registers callback for error events
   *
   * Callback is invoked when request fails.
   *
   * @param callback - Function to call on each error
   *
   * @example
   * ```typescript
   * inspector.onError(error => {
   *   console.error('Request failed:', error.message);
   *   if (error.response) {
   *     console.error('Status:', error.response.status);
   *   }
   * });
   * ```
   */
  onError(callback: ErrorCallback): void {
    this.errorCallbacks.push(callback);
  }

  /**
   * Gets complete request history
   *
   * Returns all captured requests in chronological order.
   *
   * @returns Array of request records
   *
   * @example
   * ```typescript
   * const history = inspector.getRequestHistory();
   * console.log(`Total requests: ${history.length}`);
   *
   * const failedRequests = history.filter(r => r.error || (r.response?.status >= 400));
   * console.log(`Failed requests: ${failedRequests.length}`);
   * ```
   */
  getRequestHistory(): RequestRecord[] {
    return [...this.requestHistory];
  }

  /**
   * Clears request history
   *
   * Removes all captured request records.
   * Callbacks are not affected.
   *
   * @example
   * ```typescript
   * inspector.clearHistory();
   * console.log('History cleared');
   * ```
   */
  clearHistory(): void {
    this.requestHistory = [];
    this.requestTimestamps.clear();
  }

  /**
   * Gets summary statistics of captured requests
   *
   * @returns Statistics object
   */
  getStatistics(): {
    total: number;
    successful: number;
    failed: number;
    averageDuration: number;
    byMethod: Record<string, number>;
    byStatus: Record<number, number>;
  } {
    const stats = {
      total: this.requestHistory.length,
      successful: 0,
      failed: 0,
      averageDuration: 0,
      byMethod: {} as Record<string, number>,
      byStatus: {} as Record<number, number>,
    };

    let totalDuration = 0;
    let durationCount = 0;

    this.requestHistory.forEach(record => {
      // Count by method
      stats.byMethod[record.method] = (stats.byMethod[record.method] || 0) + 1;

      // Count by status
      if (record.response) {
        const status = record.response.status;
        stats.byStatus[status] = (stats.byStatus[status] || 0) + 1;

        if (status >= 200 && status < 400) {
          stats.successful++;
        } else {
          stats.failed++;
        }

        // Sum duration
        if (record.response.duration) {
          totalDuration += record.response.duration;
          durationCount++;
        }
      } else if (record.error) {
        stats.failed++;
      }
    });

    if (durationCount > 0) {
      stats.averageDuration = totalDuration / durationCount;
    }

    return stats;
  }
}
