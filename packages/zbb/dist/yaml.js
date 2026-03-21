import yaml from 'js-yaml';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname } from 'node:path';
export async function loadYaml(filePath) {
    const content = await readFile(filePath, 'utf-8');
    return yaml.load(content);
}
export async function loadYamlOrDefault(filePath, defaultValue) {
    if (!existsSync(filePath))
        return defaultValue;
    try {
        return await loadYaml(filePath);
    }
    catch {
        return defaultValue;
    }
}
export async function saveYaml(filePath, data) {
    const dir = dirname(filePath);
    if (!existsSync(dir))
        await mkdir(dir, { recursive: true });
    const content = yaml.dump(data, { indent: 2, lineWidth: 120, noRefs: true });
    await writeFile(filePath, content, 'utf-8');
}
export function parseYaml(content) {
    return yaml.load(content);
}
export function stringifyYaml(data) {
    return yaml.dump(data, { indent: 2, lineWidth: 120, noRefs: true });
}
