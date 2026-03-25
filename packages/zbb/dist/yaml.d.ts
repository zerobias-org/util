export declare function loadYaml<T = any>(filePath: string): Promise<T>;
export declare function loadYamlOrDefault<T = any>(filePath: string, defaultValue: T): Promise<T>;
export declare function saveYaml(filePath: string, data: any): Promise<void>;
export declare function parseYaml<T = any>(content: string): T;
export declare function stringifyYaml(data: any): string;
