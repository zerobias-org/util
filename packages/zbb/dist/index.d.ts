export { SlotManager, type CreateOptions } from './slot/SlotManager.js';
export { Slot, type SlotMeta } from './slot/Slot.js';
export { SlotEnvironment, type ManifestEntry } from './slot/SlotEnvironment.js';
export { scanEnvDeclarations, type ScannedVar } from './env/Scanner.js';
export { resolveAll, extractRefs, interpolate, type ResolvedVar } from './env/Resolver.js';
export { generateSecret } from './env/SecretGen.js';
export { findRepoRoot, getSlotsDir, getZbbDir, loadUserConfig, loadRepoConfig, loadProjectConfig, type UserConfig, type RepoConfig, type ProjectConfig, type EnvVarDeclaration, type ToolRequirement, } from './config.js';
export { runPreflightChecks, formatPreflightResults, type CheckResult } from './preflight.js';
export { findGradleRoot, resolveStackAlias } from './gradle.js';
