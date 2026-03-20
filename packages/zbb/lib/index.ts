// Primary API
export { SlotManager, type CreateOptions } from './slot/SlotManager.ts';
export { Slot, type SlotMeta } from './slot/Slot.ts';
export { SlotEnvironment, type ManifestEntry } from './slot/SlotEnvironment.ts';

// Env utilities
export { scanEnvDeclarations, type ScannedVar } from './env/Scanner.ts';
export { resolveAll, extractRefs, interpolate, type ResolvedVar } from './env/Resolver.ts';
export { generateSecret } from './env/SecretGen.ts';

// Config
export {
  findRepoRoot,
  getSlotsDir,
  getZbbDir,
  loadUserConfig,
  loadRepoConfig,
  loadProjectConfig,
  type UserConfig,
  type RepoConfig,
  type ProjectConfig,
  type EnvVarDeclaration,
  type ToolRequirement,
} from './config.ts';

// Preflight
export { runPreflightChecks, formatPreflightResults, type CheckResult } from './preflight.ts';

// Gradle
export { findGradleRoot, resolveStackAlias } from './gradle.ts';
