/**
 * HTTP utilities for collector bots
 * Provides functions for downloading files and fetching remote data
 */

import axiosLib from 'axios';
import type { AxiosRequestConfig } from 'axios';
import * as fs from 'node:fs';
import * as yaml from 'js-yaml';

const axios = (axiosLib as any).default || axiosLib;

export interface FetchOptions {
  /** Request timeout in milliseconds (default: 30000) */
  timeout?: number;
  /** Custom headers to include in the request */
  headers?: Record<string, string>;
  /** Number of retry attempts on failure (default: 3) */
  retries?: number;
  /** Delay between retries in milliseconds (default: 1000) */
  retryDelay?: number;
}

const DEFAULT_TIMEOUT = 30_000;
const DEFAULT_RETRIES = 3;
const DEFAULT_RETRY_DELAY = 1000;

/**
 * Executes a function with retry logic
 */
async function withRetry<T>(
  fn: () => Promise<T>,
  retries: number = DEFAULT_RETRIES,
  delay: number = DEFAULT_RETRY_DELAY
): Promise<T> {
  let lastError: Error | undefined;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error as Error;
      if (attempt < retries) {
        await new Promise((resolve) => setTimeout(resolve, delay * (attempt + 1)));
      }
    }
  }
  throw lastError;
}

/**
 * Downloads a file from a URL and saves it to the specified path
 *
 * @param url - The URL to download from
 * @param filePath - The local path where the file should be saved
 * @param options - Optional fetch configuration
 * @throws Error if download fails after all retries
 *
 * @example
 * ```typescript
 * await downloadFile('https://example.com/data.xlsx', '/tmp/data.xlsx');
 * ```
 */
export async function downloadFile(
  url: string,
  filePath: string,
  options: FetchOptions = {}
): Promise<void> {
  const { timeout = DEFAULT_TIMEOUT, headers = {}, retries = DEFAULT_RETRIES, retryDelay = DEFAULT_RETRY_DELAY } = options;

  await withRetry(async () => {
    const config: AxiosRequestConfig = {
      url,
      method: 'GET',
      responseType: 'stream',
      timeout,
      headers,
    };

    const response = await axios(config);
    const writer = fs.createWriteStream(filePath);
    response.data.pipe(writer);

    return new Promise<void>((resolve, reject) => {
      writer.on('finish', () => resolve());
      writer.on('error', (err) => {
        // Clean up partial file on error
        fs.unlink(filePath, () => {});
        reject(err);
      });
    });
  }, retries, retryDelay);
}

/**
 * Fetches JSON data from a remote URL
 *
 * @param url - The URL to fetch from
 * @param options - Optional fetch configuration
 * @returns The parsed JSON data, or empty object on failure
 *
 * @example
 * ```typescript
 * const data = await fetchJson<MyType>('https://api.example.com/data.json');
 * ```
 */
export async function fetchJson<T = Record<string, unknown>>(
  url: string,
  options: FetchOptions = {}
): Promise<T> {
  const { timeout = DEFAULT_TIMEOUT, headers = {}, retries = DEFAULT_RETRIES, retryDelay = DEFAULT_RETRY_DELAY } = options;

  return withRetry(async () => {
    const config: AxiosRequestConfig = {
      url,
      method: 'GET',
      responseType: 'json',
      timeout,
      headers,
    };

    const response = await axios(config);
    return response.data as T;
  }, retries, retryDelay);
}

/**
 * Fetches YAML data from a remote URL and parses it
 *
 * @param url - The URL to fetch from
 * @param options - Optional fetch configuration
 * @returns The parsed YAML data
 *
 * @example
 * ```typescript
 * const data = await fetchYaml<AtlasData>('https://example.com/ATLAS.yaml');
 * ```
 */
export async function fetchYaml<T = Record<string, unknown>>(
  url: string,
  options: FetchOptions = {}
): Promise<T> {
  const { timeout = DEFAULT_TIMEOUT, headers = {}, retries = DEFAULT_RETRIES, retryDelay = DEFAULT_RETRY_DELAY } = options;

  return withRetry(async () => {
    const config: AxiosRequestConfig = {
      url,
      method: 'GET',
      responseType: 'text',
      timeout,
      headers,
    };

    const response = await axios(config);
    return yaml.load(response.data) as T;
  }, retries, retryDelay);
}

/**
 * Fetches text content from a remote URL
 *
 * @param url - The URL to fetch from
 * @param options - Optional fetch configuration
 * @returns The raw text content
 */
export async function fetchText(
  url: string,
  options: FetchOptions = {}
): Promise<string> {
  const { timeout = DEFAULT_TIMEOUT, headers = {}, retries = DEFAULT_RETRIES, retryDelay = DEFAULT_RETRY_DELAY } = options;

  return withRetry(async () => {
    const config: AxiosRequestConfig = {
      url,
      method: 'GET',
      responseType: 'text',
      timeout,
      headers,
    };

    const response = await axios(config);
    return response.data;
  }, retries, retryDelay);
}

/**
 * Downloads multiple files in parallel
 *
 * @param downloads - Array of [url, filePath] tuples
 * @param options - Optional fetch configuration
 * @returns Array of results with success/error status for each download
 *
 * @example
 * ```typescript
 * const results = await downloadFilesParallel([
 *   ['https://example.com/file1.xlsx', '/tmp/file1.xlsx'],
 *   ['https://example.com/file2.xlsx', '/tmp/file2.xlsx'],
 * ]);
 * ```
 */
export async function downloadFilesParallel(
  downloads: Array<[url: string, filePath: string]>,
  options: FetchOptions = {}
): Promise<Array<{ url: string; filePath: string; success: boolean; error?: Error }>> {
  const results = await Promise.allSettled(
    downloads.map(([url, filePath]) => downloadFile(url, filePath, options).then(() => ({ url, filePath })))
  );

  return results.map((result, index) => {
    const [url, filePath] = downloads[index];
    if (result.status === 'fulfilled') {
      return { url, filePath, success: true };
    }
    return { url, filePath, success: false, error: result.reason };
  });
}
