/**
 * Build orchestration for monorepo workspaces.
 * Runs npm scripts across packages in dependency order.
 */
import type { MonorepoConfig } from '../config.js';
import type { DependencyGraph } from './Workspace.js';
import { type TestSuiteEntry } from './GateStamp.js';
export interface BuildContext {
    repoRoot: string;
    graph: DependencyGraph;
    affectedOrdered: string[];
    config: MonorepoConfig;
    verbose?: boolean;
}
export declare function clean(ctx: BuildContext): void;
export declare function build(ctx: BuildContext): Map<string, Record<string, 'passed' | 'skipped' | 'not-found'>>;
export interface TestOutput {
    results: Map<string, Record<string, TestSuiteEntry>>;
    failed: boolean;
}
export declare function test(ctx: BuildContext): TestOutput;
export declare function install(repoRoot: string): void;
export declare function gate(ctx: BuildContext): void;
