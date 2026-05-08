import { UnexpectedError } from '@zerobias-org/types-core-js';
import filePath from 'node:path';
import process from 'node:process';
import { lstatSync, readdirSync } from 'node:fs';
import { access, lstat, readFile, writeFile } from 'node:fs/promises';
import { parse as yamlParse } from 'yaml';

import { SecretNode } from '../generated/model/index.js';
import { TreeNode } from './TreeNode.js';
import { JsonNode } from './JsonNode.js';
import { DELIMITER, SecretType } from './SecretsManager.js';
import { errorMessage, logger } from './common.js';
import stringify from 'safe-stable-stringify';

export const ROOT = 'file';

const supportedFileTypes = [
  'json',
  'yaml',
  'yml',
];

// Helper function to find supported file with given base path
async function findSupportedFile(basePath: string): Promise<string | null> {
  for (const ext of supportedFileTypes) {
    const fullPath = `${basePath}.${ext}`;
    try {
      await access(fullPath);
      return fullPath;
    } catch {
      continue;
    }
  }

  return null;
}

async function resolver(node: FileNode, path: string): Promise<TreeNode[]> {
  const [, ...subpath] = path.split(DELIMITER);
  let dir = filePath.join(process.env.FILE_SECRET_ROOT!, ...subpath);

  try {
    await access(dir);
  } catch {
    const foundFile = await findSupportedFile(dir);
    if (!foundFile) {
      throw new UnexpectedError(`Could not resolve FileNode for path ${path}`);
    }
    dir = foundFile;
  }

  const dirStat = await lstat(dir);
  if (dirStat.isDirectory()) {
    try {
      const entries = readdirSync(dir);
      const nodes: FileNode[] = [];

      for (const name of entries) {
        try {
          const fstat = lstatSync(filePath.join(dir, name));
          let nodeName = name;

          if (fstat.isFile()) {
            if (name.startsWith('.')) continue;
            const parts = name.split('.');
            if (parts.length !== 2) continue;
            if (!supportedFileTypes.includes(parts[1].toLowerCase())) continue;
            [nodeName] = parts;
          }

          nodes.push(new FileNode(nodeName, SecretNode.TypeEnum.Node, node));
        } catch {
          continue;
        }
      }
      return nodes;
    } catch (error) {
      logger.error(`Error reading directory ${dir}: ${errorMessage(error)}`);
      return [];
    }
  }

  if (dirStat.isFile()) {
    try {
      const contents = await readFile(dir, 'utf8');
      const obj = dir.endsWith('json') ? JSON.parse(contents) : await yamlParse(contents);
      logger.debug(`Resolved ${dir} → [${Object.keys(obj).join(',')}]`);
      return Object.keys(obj).map((k) => new JsonNode(obj[k], k, node));
    } catch (error) {
      logger.error(`Error reading file ${dir}: ${errorMessage(error)}`);
      return [];
    }
  }
  return [];
}

export class FileNode extends TreeNode {
  constructor(
    path: string,
    type: SecretNode.TypeEnumDef,
    parent?: TreeNode
  ) {
     
    super(
      path,
      type,
      parent,
      true,
      async (resolvePath: string) => resolver(this, resolvePath)
    );
    // Constructor — no logging (called frequently during traversal)
  }

  override async setValue(
    path: string,
    value: SecretType | Record<string, any>
  ): Promise<SecretNode> {
    logger.debug(`Entered FileNode.setValue - ${path} - ${value}`);
    const [, fileName, ...subpath] = path.split(DELIMITER);
    logger.debug(`FileNode decoded ${path}: fileName=${fileName} subpath=${subpath}`);

    try {
      await access(process.env.FILE_SECRET_ROOT!);
    } catch {
      throw new UnexpectedError(`Could not resolve FILE_SECRET_ROOT ${process.env.FILE_SECRET_ROOT} directory.`);
    }

     
    let file = filePath.join(process.env.FILE_SECRET_ROOT!, fileName);
    const secretNode = new FileNode(file, SecretNode.TypeEnum.Node, this);
    let obj: SecretType | Record<string, any>;

    try {
      logger.debug(`check if file exists ${file}`);
      const existingFile = await findSupportedFile(file);

      if (!existingFile) {
        throw new Error('File not found');
      }

      logger.debug(`Found matching file: ${existingFile}`);
      this.children = {};
      file = existingFile;

      const contents = await readFile(file, 'utf8');
      try {
        obj = file.endsWith('json') ? JSON.parse(contents) : await yamlParse(contents) as Record<string, any>;
      } catch (parseError) {
        const stack = parseError instanceof Error ? parseError.stack : undefined;
        logger.error(`Error parsing file ${file}: ${errorMessage(parseError)} - ${stringify(stack)}`);
        throw new UnexpectedError(`Invalid file format in ${file}`);
      }
    } catch {
      // File doesn't exist, create new JSON file
      file = `${file}.json`;
      logger.debug(`file didn't exist, creating new one at ${file}`);
      obj = {};
    }

    logger.debug(`Got contents of file: ${JSON.stringify(obj)}`);

    // Handle nested path creation
    if (subpath && subpath.length > 0) {
      logger.debug(`We had a subpath: ${subpath} - and current obj: ${JSON.stringify(obj)}`);

      // Ensure obj is a record for nested operations
      if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) {
        obj = {};
      }

      let current = obj as Record<string, any>;

      // Navigate/create nested structure
      for (let i = 0; i < subpath.length - 1; i += 1) {
        const key = subpath[i];
        logger.debug(`Creating/navigating to key: ${key}`);

        if (!(key in current) || typeof current[key] !== 'object' || current[key] === null || Array.isArray(current[key])) {
          current[key] = {};
        }
        current = current[key] as Record<string, any>;
      }

      // Set the final value
      const finalKey = subpath[subpath.length - 1];
      current[finalKey] = value;

      logger.debug(`Updated nested object: ${JSON.stringify(obj)}`);
      secretNode.children = {};
    } else {
      obj = value;
    }

    // Write file with proper formatting
    try {
      const fileContent = file.endsWith('.json')
        ? JSON.stringify(obj, null, 2)
        : JSON.stringify(obj);

      logger.debug(`Updating secret at ${path} to ${fileContent}`);
      await writeFile(file, fileContent);
    } catch (writeError) {
      const stack = writeError instanceof Error ? writeError.stack : undefined;
      logger.error(`Error writing file ${file}: ${errorMessage(writeError)} - ${stack}`);
      throw new UnexpectedError(`Failed to write file ${file}`);
    }

    // Return appropriate node
    if (subpath && subpath.length > 0) {
      let current = obj as Record<string, any>;
      for (const key of subpath.slice(0, -1)) {
        current = current[key] as Record<string, any>;
      }
      const finalKey = subpath[subpath.length - 1];
      return new JsonNode(current[finalKey], finalKey, this).asNode();
    }
    return secretNode.asNode();
  }
}
