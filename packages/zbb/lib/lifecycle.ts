/**
 * Shared lifecycle definitions.
 *
 * The set of commands the cli.ts dispatcher routes through `isLifecycleCommand`,
 * plus the args parser that both standard- and monorepo-mode dispatchers consume.
 *
 * Lives at the top level of `lib/` (not under `monorepo/`) because the standard
 * path uses these too — `version` is standard-only, `publish` works in both, etc.
 * Anything that is genuinely monorepo-only (event pipeline, scope-aware spawning)
 * stays in `monorepo/`.
 */

// ── Lifecycle commands ───────────────────────────────────────────────
//
// These are the commands that route through the lifecycle dispatch in
// cli.ts. Anything else (slot/stack/registry/secret/env/logs/etc.) has
// its own subcommand handler. Anything not in this set and not a
// recognized subcommand falls through to the gradle wrapper.

export const LIFECYCLE_COMMANDS: ReadonlySet<string> = new Set([
  'clean',
  'build',
  'test',
  'testIntegration',
  'gate',
  'version',
  'publish',
  'dockerBuild',
]);

export function isLifecycleCommand(command: string): boolean {
  return LIFECYCLE_COMMANDS.has(command);
}

// ── Argument parsing ─────────────────────────────────────────────────

export interface ParsedLifecycleArgs {
  all: boolean;
  base?: string;
  /** `--clean` — wired to gradle's -Pcleanlocalregistry flag (verifyNoLocalRegistry guard). */
  clean: boolean;
  dryRun: boolean;
  force: boolean;
  verbose: boolean;
  check: boolean;
  skipDocker: boolean;
  /** `zbb version --modules=a,b,c` — comma-separated list passed to gradle as -PmodulesToVersion. */
  modules?: string;
  /** `zbb version --no-push` — keeps the version commit local; used for testing. */
  noPush: boolean;
  remaining: string[];
}

export function parseLifecycleArgs(args: string[]): ParsedLifecycleArgs {
  const result: ParsedLifecycleArgs = {
    all: false,
    clean: false,
    dryRun: false,
    force: false,
    verbose: false,
    check: false,
    skipDocker: false,
    noPush: false,
    remaining: [],
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    switch (arg) {
      case '--all':
        result.all = true;
        break;
      case '--base':
        result.base = args[i += 1];
        break;
      case '--dry-run':
        result.dryRun = true;
        break;
      case '--force':
        result.force = true;
        break;
      case '--verbose':
      case '-v':
        result.verbose = true;
        break;
      case '--check':
        result.check = true;
        break;
      case '--clean':
        result.clean = true;
        break;
      case '--skipDocker':
      case '--skip-docker':
        result.skipDocker = true;
        break;
      case '--modules':
        result.modules = args[i += 1];
        break;
      case '--no-push':
        result.noPush = true;
        break;
      default:
        // Support `--modules=a,b,c` (single token, equals form) in addition
        // to `--modules a,b,c`. Same shape as gradle's -P flags so the user
        // can pass either spelling without thinking about it.
        if (arg.startsWith('--modules=')) {
          result.modules = arg.slice('--modules='.length);
        } else {
          result.remaining.push(arg);
        }
    }
  }

  return result;
}
