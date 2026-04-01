/**
 * Monorepo command dispatcher.
 * Routes clean/build/test/gate/publish commands to the appropriate handlers.
 */
/**
 * Check if the repo at repoRoot is a monorepo with monorepo mode enabled.
 */
export declare function isMonorepo(repoRoot: string): boolean;
/**
 * Check if a command should be handled by the monorepo system.
 */
export declare function isMonorepoCommand(command: string): boolean;
/**
 * Main monorepo command handler.
 */
export declare function handleMonorepo(command: string, args: string[], repoRoot: string): Promise<void>;
