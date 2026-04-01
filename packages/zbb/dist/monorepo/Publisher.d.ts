/**
 * Publisher for monorepo workspaces.
 * Handles version validation, npm publish, Docker workflow dispatch, and git tagging.
 */
import type { MonorepoConfig } from '../config.js';
import type { DependencyGraph } from './Workspace.js';
interface PublishOptions {
    dryRun: boolean;
    force: boolean;
    verbose: boolean;
    repoRoot: string;
    graph: DependencyGraph;
    affectedOrdered: string[];
    config: MonorepoConfig;
}
export declare function publish(opts: PublishOptions): void;
export {};
