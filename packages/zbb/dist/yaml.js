import { parse as yamlParse, stringify as yamlStringify } from 'yaml';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname } from 'node:path';
export async function loadYaml(filePath) {
    const content = await readFile(filePath, 'utf-8');
    return yamlParse(content);
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
    const content = yamlStringify(data, { indent: 2, lineWidth: 120 });
    await writeFile(filePath, content, 'utf-8');
}
export function parseYaml(content) {
    return yamlParse(content);
}
export function stringifyYaml(data) {
    return yamlStringify(data, { indent: 2, lineWidth: 120 });
}
