import { join, relative } from 'node:path';
import { loadYamlOrDefault } from '../yaml.js';
import type { EnvVarDeclaration, ProjectConfig, RepoConfig } from '../config.js';

export interface ScannedVar {
  name: string;
  declaration: EnvVarDeclaration;
  /** Relative path of the file that declared this var */
  source: string;
}

/**
 * Read env declarations from the stack zbb.yaml at `repoRoot`.
 *
 * Phase 3 single-file model: each stack lives in exactly one zbb.yaml.
 * Substacks are inlined under the parent's `substacks:` field — never as
 * separate files. Nested directories with their own zbb.yaml (e.g.
 * com/hub/node-stack/zbb.yaml inside com/hub/zbb.yaml) are SEPARATE
 * stacks added independently via `zbb stack add <path>`. So this
 * function reads only the manifest at the given root and never walks
 * into subdirectories.
 *
 * `projectOnly` keeps the legacy "scan exactly this file path" form for
 * callers that already know the manifest location.
 */
export async function scanEnvDeclarations(repoRoot: string, projectOnly?: string): Promise<ScannedVar[]> {
  if (projectOnly) {
    const vars: ScannedVar[] = [];
    const config = await loadYamlOrDefault<ProjectConfig>(projectOnly, {});
    if (config.env) {
      for (const [name, decl] of Object.entries(config.env)) {
        vars.push({ name, declaration: decl, source: relative(repoRoot, projectOnly) });
      }
    }
    return vars;
  }

  const vars: ScannedVar[] = [];
  const rootConfig = await loadYamlOrDefault<RepoConfig & ProjectConfig>(
    join(repoRoot, 'zbb.yaml'),
    {},
  );
  if (rootConfig.env) {
    for (const [name, decl] of Object.entries(rootConfig.env)) {
      vars.push({ name, declaration: decl, source: 'zbb.yaml' });
    }
  }
  return vars;
}
