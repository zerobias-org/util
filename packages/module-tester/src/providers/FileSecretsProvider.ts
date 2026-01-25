/**
 * FileSecretsProvider - File-based secrets for local development
 *
 * Reads secrets from local files in a configurable directory.
 * Supports JSON and YAML formats.
 *
 * Directory structure:
 * .secrets/
 *   aws/
 *     test-credentials.json    # {"accessKey": "...", "secretKey": "..."}
 *     test-credentials.yml     # accessKey: ...
 *   github/
 *     token.json
 *
 * Path resolution:
 * - "aws/test-credentials" -> .secrets/aws/test-credentials.json (or .yml)
 * - "github/token" -> .secrets/github/token.json (or .yml)
 */

import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import type { Logger } from '../types.js';
import type { SecretsProvider } from './SecretsProvider.js';

/**
 * FileSecretsProvider configuration
 */
export interface FileSecretsProviderConfig {
  /** Base directory for secrets (default: .secrets) */
  baseDir?: string;
  /** File extensions to try, in order (default: ['.json', '.yml', '.yaml']) */
  extensions?: string[];
}

/**
 * Default configuration
 */
const DEFAULTS = {
  BASE_DIR: '.secrets',
  EXTENSIONS: ['.json', '.yml', '.yaml']
} as const;

/**
 * File-based secrets provider for local development
 */
export class FileSecretsProvider implements SecretsProvider {
  readonly name = 'FileSecretsProvider';
  private config: Required<FileSecretsProviderConfig>;
  private logger: Logger;
  private resolvedBaseDir: string;

  constructor(config: FileSecretsProviderConfig = {}, logger?: Logger) {
    this.config = {
      baseDir: config.baseDir ?? DEFAULTS.BASE_DIR,
      extensions: config.extensions ?? [...DEFAULTS.EXTENSIONS]
    };
    this.logger = logger ?? this.createDefaultLogger();

    // Resolve base directory relative to cwd
    this.resolvedBaseDir = path.resolve(process.cwd(), this.config.baseDir);
  }

  /**
   * Get secret from file
   */
  async getSecret(path_: string): Promise<Record<string, unknown>> {
    const filePath = this.resolveFilePath(path_);

    if (!filePath) {
      throw new Error(`Secret file not found for path: ${path_} (looked in ${this.resolvedBaseDir})`);
    }

    const content = await fs.promises.readFile(filePath, 'utf-8');
    const ext = path.extname(filePath).toLowerCase();

    let parsed: unknown;

    if (ext === '.json') {
      parsed = JSON.parse(content);
    } else if (ext === '.yml' || ext === '.yaml') {
      parsed = yaml.load(content);
    } else {
      // Treat as plain text
      parsed = { value: content.trim() };
    }

    if (typeof parsed !== 'object' || parsed === null) {
      throw new Error(`Invalid secret format in ${filePath}: expected object`);
    }

    this.logger.debug(`Loaded secret from ${filePath}`);
    return parsed as Record<string, unknown>;
  }

  /**
   * Check if a secret file exists for this path
   */
  supports(path_: string): boolean {
    return this.resolveFilePath(path_) !== null;
  }

  /**
   * Resolve a path to an actual file path
   * Returns null if no matching file found
   */
  private resolveFilePath(secretPath: string): string | null {
    // Normalize the path
    const normalizedPath = secretPath.replace(/\\/g, '/');
    const basePath = path.join(this.resolvedBaseDir, normalizedPath);

    // Check if exact path exists (with extension)
    if (fs.existsSync(basePath)) {
      const stat = fs.statSync(basePath);
      if (stat.isFile()) {
        return basePath;
      }
    }

    // Try each extension
    for (const ext of this.config.extensions) {
      const fullPath = `${basePath}${ext}`;
      if (fs.existsSync(fullPath)) {
        const stat = fs.statSync(fullPath);
        if (stat.isFile()) {
          return fullPath;
        }
      }
    }

    return null;
  }

  /**
   * Get the base directory for secrets
   */
  getBaseDir(): string {
    return this.resolvedBaseDir;
  }

  /**
   * List available secret paths
   */
  async listSecrets(): Promise<string[]> {
    const secrets: string[] = [];

    if (!fs.existsSync(this.resolvedBaseDir)) {
      return secrets;
    }

    const walkDir = async (dir: string, prefix: string): Promise<void> => {
      const entries = await fs.promises.readdir(dir, { withFileTypes: true });

      for (const entry of entries) {
        const entryPath = path.join(dir, entry.name);

        if (entry.isDirectory()) {
          await walkDir(entryPath, path.join(prefix, entry.name));
        } else if (entry.isFile()) {
          // Check if it's a supported extension
          const ext = path.extname(entry.name).toLowerCase();
          if (this.config.extensions.includes(ext)) {
            const baseName = entry.name.substring(0, entry.name.length - ext.length);
            secrets.push(path.join(prefix, baseName).replace(/\\/g, '/'));
          }
        }
      }
    };

    await walkDir(this.resolvedBaseDir, '');
    return secrets;
  }

  /**
   * Create default console logger
   */
  private createDefaultLogger(): Logger {
    return {
      debug: (msg: string, ...args: unknown[]) => console.debug(`[FileSecrets] ${msg}`, ...args),
      info: (msg: string, ...args: unknown[]) => console.info(`[FileSecrets] ${msg}`, ...args),
      warn: (msg: string, ...args: unknown[]) => console.warn(`[FileSecrets] ${msg}`, ...args),
      error: (msg: string, ...args: unknown[]) => console.error(`[FileSecrets] ${msg}`, ...args)
    };
  }
}

/**
 * Create a secrets directory and file (for testing/setup)
 */
export async function createSecretFile(
  secretPath: string,
  value: Record<string, unknown>,
  baseDir = DEFAULTS.BASE_DIR
): Promise<string> {
  const resolvedBase = path.resolve(process.cwd(), baseDir);
  const fullPath = path.join(resolvedBase, `${secretPath}.json`);
  const dir = path.dirname(fullPath);

  // Ensure directory exists
  await fs.promises.mkdir(dir, { recursive: true });

  // Write the secret
  await fs.promises.writeFile(fullPath, JSON.stringify(value, null, 2));

  return fullPath;
}

/**
 * Delete a secret file (for testing cleanup)
 */
export async function deleteSecretFile(
  secretPath: string,
  baseDir = DEFAULTS.BASE_DIR
): Promise<void> {
  const resolvedBase = path.resolve(process.cwd(), baseDir);

  for (const ext of DEFAULTS.EXTENSIONS) {
    const fullPath = path.join(resolvedBase, `${secretPath}${ext}`);
    try {
      await fs.promises.unlink(fullPath);
    } catch {
      // File doesn't exist, ignore
    }
  }
}
