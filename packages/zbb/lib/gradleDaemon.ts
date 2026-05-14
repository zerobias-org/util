/**
 * Detect and stop gradle daemons whose env has drifted from what the
 * current zbb invocation has resolved.
 *
 * Why this exists: gradle daemons are long-lived JVMs that snapshot
 * their environment at JVM start. `Exec` tasks spawn child processes
 * that inherit the *daemon's* env, not the launcher's — so refreshing
 * a value in zbb's `process.env` (via `prepareSlot` reading the stack
 * `.env`, or by exporting a new value in the slot subshell) silently
 * fails to reach `npm` / `psql` / `docker login` etc. when the daemon
 * predates the change. Symptom: cryptic 401s on `npm install`, stale
 * `PGHOST` pointing at a torn-down Neon branch, etc.
 *
 * Strategy: enumerate live gradle daemons, read each one's
 * `/proc/<pid>/environ`, compare against `process.env` for the union
 * of all `env:` keys declared in the chain's zbb.yaml files. If any
 * watched key differs (including unset-vs-set), run `./gradlew --stop`
 * — the next invocation will respawn a fresh daemon with the right
 * env. The check is cheap (pgrep + small reads) and fires at most
 * once per zbb invocation.
 *
 * Linux only — `/proc/<pid>/environ` doesn't exist on macOS/Windows.
 * Callers get a no-op return on other platforms.
 */

import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

export interface DaemonRefreshResult {
  /** Whether `./gradlew --stop` ran. */
  stopped: boolean;
  /** First key whose value drifted (for logging). */
  driftedKey?: string;
  /** Daemon PID where drift was first observed. */
  driftedPid?: number;
}

/**
 * If any running gradle daemon's env disagrees with `expectedEnv` for
 * any of `watchedKeys`, stop all daemons via `./gradlew --stop`.
 *
 * @param repoRoot directory from which to invoke `./gradlew --stop`.
 *   Should be a dir with a gradlew wrapper. `--stop` is global per
 *   gradle-version-and-user, so the exact dir mostly doesn't matter
 *   as long as gradlew exists there.
 * @param expectedEnv reference env map (typically `process.env` after
 *   `prepareSlot` has populated stack values).
 * @param watchedKeys env var names whose drift triggers a stop. Should
 *   be the union of `env:` keys declared in the chain's zbb.yaml
 *   files — i.e., everything zbb itself promises to track.
 */
export function refreshGradleDaemonEnv(
  repoRoot: string,
  expectedEnv: NodeJS.ProcessEnv,
  watchedKeys: string[],
  log?: (msg: string) => void,
): DaemonRefreshResult {
  if (process.platform !== 'linux') return { stopped: false };
  if (watchedKeys.length === 0) return { stopped: false };

  // Find live gradle daemons.
  let pids: number[] = [];
  try {
    const out = execSync('pgrep -f GradleDaemon', {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    pids = out
      .trim()
      .split('\n')
      .map(s => parseInt(s, 10))
      .filter(n => Number.isFinite(n));
  } catch {
    // Non-zero exit from pgrep means "no matches" — not an error.
    return { stopped: false };
  }
  if (pids.length === 0) return { stopped: false };

  // `pgrep -f GradleDaemon` is global — it returns daemons across every
  // stack/slot on the host, plus any anonymous daemons spawned by a
  // direct `./gradlew` invocation. Watched keys are scoped to THIS
  // chain's `env:`, so they'll legitimately be unset on daemons that
  // belong to a different stack (e.g. `HYDRA_SERVICE_PORT` is only
  // declared by the hydra-service stack — the platform stack's daemon
  // has no reason to carry it). Comparing watched keys against a
  // foreign daemon always reports drift, even though nothing actually
  // changed. Identify "our" daemons by matching ZB_STACK + ZB_SLOT
  // against the current process.env — these are stamped by prepareSlot
  // on every zbb spawn, so any daemon zbb itself launched will carry
  // them. Anonymous daemons (vanilla `./gradlew` from a user shell)
  // and foreign-stack daemons are skipped.
  const ourStack = expectedEnv.ZB_STACK ?? '';
  const ourSlot = expectedEnv.ZB_SLOT ?? '';
  const isOurDaemon = (env: Record<string, string>) =>
    (env.ZB_STACK ?? '') === ourStack && (env.ZB_SLOT ?? '') === ourSlot;

  // Walk daemons, compare each watched key.
  let drift: { pid: number; key: string } | null = null;
  for (const pid of pids) {
    const environ = readDaemonEnv(pid);
    if (!environ) continue; // daemon vanished or perms denied — skip
    if (!isOurDaemon(environ)) continue; // foreign stack/slot — not our problem
    for (const key of watchedKeys) {
      const expected = expectedEnv[key] ?? '';
      const actual = environ[key] ?? '';
      if (expected !== actual) {
        drift = { pid, key };
        break;
      }
    }
    if (drift) break;
  }

  if (!drift) return { stopped: false };

  log?.(
    `[zbb] gradle daemon ${drift.pid} env stale on ${drift.key} — ` +
      `restarting (next gradle invocation will respawn with fresh env)`,
  );

  try {
    execSync('./gradlew --stop', {
      cwd: repoRoot,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 30_000,
    });
  } catch (e) {
    log?.(`[zbb] gradle --stop failed: ${(e as Error).message}`);
  }

  return { stopped: true, driftedKey: drift.key, driftedPid: drift.pid };
}

/**
 * Read /proc/<pid>/environ as a map. Returns null on read error
 * (perms, vanished pid, etc.). Each entry is NUL-separated KEY=VAL.
 */
function readDaemonEnv(pid: number): Record<string, string> | null {
  try {
    const raw = readFileSync(`/proc/${pid}/environ`, 'utf-8');
    const env: Record<string, string> = {};
    for (const entry of raw.split('\0')) {
      if (entry.length === 0) continue;
      const eqIdx = entry.indexOf('=');
      if (eqIdx < 0) continue;
      env[entry.slice(0, eqIdx)] = entry.slice(eqIdx + 1);
    }
    return env;
  } catch {
    return null;
  }
}
