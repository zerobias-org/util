/**
 * TestProfileLoader - Load and validate test profiles from YAML files
 *
 * Test profiles define how to test a module:
 * - Which module and version to test
 * - Connection configuration
 * - Which operations to test
 * - Environment-specific settings
 */

import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import type { TestProfile, Logger } from './types.js';

/**
 * TestProfileLoader configuration
 */
export interface TestProfileLoaderConfig {
  /** Directory containing test profiles (default: ./test-profiles) */
  profilesDir?: string;
  /** Logger instance */
  logger?: Logger;
}

/**
 * Default configuration
 */
const DEFAULTS = {
  PROFILES_DIR: './test-profiles'
} as const;

/**
 * Profile validation error
 */
export class ProfileValidationError extends Error {
  constructor(
    public readonly profilePath: string,
    message: string
  ) {
    super(`Invalid profile ${profilePath}: ${message}`);
    this.name = 'ProfileValidationError';
  }
}

/**
 * TestProfileLoader loads and validates test profiles from YAML files
 */
export class TestProfileLoader {
  private config: Required<TestProfileLoaderConfig>;
  private logger: Logger;
  private resolvedDir: string;

  constructor(config: TestProfileLoaderConfig = {}) {
    this.logger = config.logger ?? this.createDefaultLogger();
    this.config = {
      profilesDir: config.profilesDir ?? DEFAULTS.PROFILES_DIR,
      logger: this.logger
    };
    this.resolvedDir = path.resolve(process.cwd(), this.config.profilesDir);
  }

  /**
   * Load a single profile by name
   * @param name Profile name (without extension)
   */
  async loadProfile(name: string): Promise<TestProfile> {
    const filePath = await this.findProfileFile(name);

    if (!filePath) {
      throw new Error(`Profile not found: ${name} (looked in ${this.resolvedDir})`);
    }

    return this.loadProfileFromFile(filePath);
  }

  /**
   * Load all profiles from the profiles directory
   */
  async loadAllProfiles(): Promise<TestProfile[]> {
    if (!fs.existsSync(this.resolvedDir)) {
      this.logger.warn(`Profiles directory not found: ${this.resolvedDir}`);
      return [];
    }

    const files = await fs.promises.readdir(this.resolvedDir);
    const profiles: TestProfile[] = [];

    for (const file of files) {
      if (this.isProfileFile(file)) {
        const filePath = path.join(this.resolvedDir, file);
        try {
          const profile = await this.loadProfileFromFile(filePath);
          profiles.push(profile);
        } catch (error) {
          this.logger.error(`Failed to load profile ${file}: ${error}`);
        }
      }
    }

    return profiles;
  }

  /**
   * Load profiles filtered by environment (CI vs local)
   */
  async loadProfilesForEnvironment(isCi: boolean): Promise<TestProfile[]> {
    const allProfiles = await this.loadAllProfiles();

    return allProfiles.filter(profile => {
      if (isCi && profile.skipCi) {
        this.logger.info(`Skipping profile ${profile.name} in CI`);
        return false;
      }
      if (!isCi && profile.skipLocal) {
        this.logger.info(`Skipping profile ${profile.name} in local environment`);
        return false;
      }
      return true;
    });
  }

  /**
   * Load a profile from a specific file path
   */
  async loadProfileFromFile(filePath: string): Promise<TestProfile> {
    const content = await fs.promises.readFile(filePath, 'utf-8');
    const ext = path.extname(filePath).toLowerCase();

    let raw: unknown;

    if (ext === '.json') {
      raw = JSON.parse(content);
    } else if (ext === '.yml' || ext === '.yaml') {
      raw = yaml.load(content);
    } else {
      throw new ProfileValidationError(filePath, `Unsupported file extension: ${ext}`);
    }

    const profile = this.validateProfile(raw, filePath);
    this.logger.debug(`Loaded profile: ${profile.name} from ${filePath}`);

    return profile;
  }

  /**
   * Get the profiles directory
   */
  getProfilesDir(): string {
    return this.resolvedDir;
  }

  /**
   * Find a profile file by name
   */
  private async findProfileFile(name: string): Promise<string | null> {
    const extensions = ['.yml', '.yaml', '.json'];

    // Check if name already has extension
    if (extensions.some(ext => name.endsWith(ext))) {
      const filePath = path.join(this.resolvedDir, name);
      if (fs.existsSync(filePath)) {
        return filePath;
      }
      return null;
    }

    // Try each extension
    for (const ext of extensions) {
      const filePath = path.join(this.resolvedDir, `${name}${ext}`);
      if (fs.existsSync(filePath)) {
        return filePath;
      }
    }

    return null;
  }

  /**
   * Check if a file is a profile file
   */
  private isProfileFile(filename: string): boolean {
    const ext = path.extname(filename).toLowerCase();
    return ['.yml', '.yaml', '.json'].includes(ext);
  }

  /**
   * Validate and normalize a raw profile object
   */
  private validateProfile(raw: unknown, filePath: string): TestProfile {
    if (typeof raw !== 'object' || raw === null) {
      throw new ProfileValidationError(filePath, 'Profile must be an object');
    }

    const obj = raw as Record<string, unknown>;

    // Required fields
    if (!obj.name || typeof obj.name !== 'string') {
      throw new ProfileValidationError(filePath, 'Profile must have a "name" string');
    }

    if (!obj.module || typeof obj.module !== 'string') {
      throw new ProfileValidationError(filePath, 'Profile must have a "module" string');
    }

    if (!obj.connection || typeof obj.connection !== 'object') {
      throw new ProfileValidationError(filePath, 'Profile must have a "connection" object');
    }

    const connection = obj.connection as Record<string, unknown>;

    if (!connection.profileType || typeof connection.profileType !== 'string') {
      throw new ProfileValidationError(filePath, 'Connection must have a "profileType" string');
    }

    // Validate that either secretsPath or profile is specified
    if (!connection.secretsPath && !connection.profile) {
      throw new ProfileValidationError(
        filePath,
        'Connection must have either "secretsPath" or "profile"'
      );
    }

    // Build validated profile
    const profile: TestProfile = {
      name: obj.name as string,
      module: obj.module as string,
      connection: {
        profileType: connection.profileType as string,
        secretsPath: connection.secretsPath as string | undefined,
        profile: connection.profile as Record<string, unknown> | undefined
      }
    };

    // Optional fields
    if (obj.version !== undefined) {
      if (typeof obj.version !== 'string') {
        throw new ProfileValidationError(filePath, '"version" must be a string');
      }
      profile.version = obj.version;
    }

    if (obj.image !== undefined) {
      if (typeof obj.image !== 'string') {
        throw new ProfileValidationError(filePath, '"image" must be a string');
      }
      profile.image = obj.image;
    }

    if (obj.skipCi !== undefined) {
      profile.skipCi = Boolean(obj.skipCi);
    }

    if (obj.skipLocal !== undefined) {
      profile.skipLocal = Boolean(obj.skipLocal);
    }

    if (obj.operations !== undefined) {
      if (!Array.isArray(obj.operations)) {
        throw new ProfileValidationError(filePath, '"operations" must be an array');
      }
      profile.operations = obj.operations.map(String);
    }

    if (obj.environment !== undefined) {
      if (typeof obj.environment !== 'object' || obj.environment === null) {
        throw new ProfileValidationError(filePath, '"environment" must be an object');
      }
      profile.environment = obj.environment as Record<string, string>;
    }

    return profile;
  }

  /**
   * Create default console logger
   */
  private createDefaultLogger(): Logger {
    return {
      debug: (msg: string, ...args: unknown[]) => console.debug(`[ProfileLoader] ${msg}`, ...args),
      info: (msg: string, ...args: unknown[]) => console.info(`[ProfileLoader] ${msg}`, ...args),
      warn: (msg: string, ...args: unknown[]) => console.warn(`[ProfileLoader] ${msg}`, ...args),
      error: (msg: string, ...args: unknown[]) => console.error(`[ProfileLoader] ${msg}`, ...args)
    };
  }
}

/**
 * Create a test profile programmatically
 */
export function createTestProfile(options: {
  name: string;
  module: string;
  version?: string;
  image?: string;
  profileType: string;
  secretsPath?: string;
  profile?: Record<string, unknown>;
  operations?: string[];
  environment?: Record<string, string>;
  skipCi?: boolean;
  skipLocal?: boolean;
}): TestProfile {
  return {
    name: options.name,
    module: options.module,
    version: options.version,
    image: options.image,
    skipCi: options.skipCi,
    skipLocal: options.skipLocal,
    connection: {
      profileType: options.profileType,
      secretsPath: options.secretsPath,
      profile: options.profile
    },
    operations: options.operations,
    environment: options.environment
  };
}
