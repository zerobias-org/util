import yaml from 'js-yaml';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname } from 'node:path';

export async function loadYaml<T = any>(filePath: string): Promise<T> {
  const content = await readFile(filePath, 'utf-8');
  return yaml.load(content) as T;
}

export async function loadYamlOrDefault<T = any>(filePath: string, defaultValue: T): Promise<T> {
  if (!existsSync(filePath)) return defaultValue;
  try {
    return await loadYaml<T>(filePath);
  } catch {
    return defaultValue;
  }
}

export async function saveYaml(filePath: string, data: any): Promise<void> {
  const dir = dirname(filePath);
  if (!existsSync(dir)) await mkdir(dir, { recursive: true });
  const content = yaml.dump(data, { indent: 2, lineWidth: 120, noRefs: true });
  await writeFile(filePath, content, 'utf-8');
}

export function parseYaml<T = any>(content: string): T {
  return yaml.load(content) as T;
}

export function stringifyYaml(data: any): string {
  return yaml.dump(data, { indent: 2, lineWidth: 120, noRefs: true });
}
