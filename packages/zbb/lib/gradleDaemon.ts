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
 * of all `env:` keys declared in the chain's zbb.yaml files. If a
 * daemon belonging to THIS stack/slot has a watched key that differs
 * (including unset-vs-set), kill that daemon by PID — the next
 * invocation will respawn a fresh daemon with the right env. The check
 * is cheap (pgrep + small reads) and fires at most once per zbb
 * invocation.
 *
 * Why kill by PID and not `./gradlew --stop`: `--stop` is global per
 * gradle-version-and-user, so it tears down EVERY daemon on the host —
 * including ones a concurrent `zbb gate` on a different stack is
 * actively building on, which dies with "stop command received". We
 * only ever want to restart our own stale daemon, so we signal the
 * specific PID(s) we identified as ours.
 *
 * Linux only — `/proc/<pid>/environ` doesn't exist on macOS/Windows.
 * Callers get a no-op return on other platforms.
 */

import { execSync, spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';

export interface DaemonRefreshResult {
  /** Whether at least one daemon was signalled to stop. */
  stopped: boolean;
  /** First key whose value drifted (for logging). */
  driftedKey?: string;
  /** Daemon PID where drift was first observed. */
  driftedPid?: number;
  /** Every daemon PID we signalled to stop. */
  stoppedPids?: number[];
}

/**
 * If a running gradle daemon belonging to THIS stack/slot disagrees
 * with `expectedEnv` for any of `watchedKeys`, kill that daemon by PID
 * so the next gradle invocation respawns with fresh env. Daemons owned
 * by other stacks/slots (or anonymous `./gradlew` runs) are left alone.
 *
 * @param expectedEnv reference env map (typically `process.env` after
 *   `prepareSlot` has populated stack values). `ZB_STACK` + `ZB_SLOT`
 *   identify which daemons count as ours.
 * @param watchedKeys env var names whose drift triggers a stop. Should
 *   be the union of `env:` keys declared in the chain's zbb.yaml
 *   files — i.e., everything zbb itself promises to track.
 */
export function refreshGradleDaemonEnv(
  expectedEnv: NodeJS.ProcessEnv,
  watchedKeys: string[],
  log?: (msg: string) => void,
): DaemonRefreshResult {
  if (process.platform !== 'linux') return { stopped: false };
  if (watchedKeys.length === 0) return { stopped: false };

  const pids = listGradleDaemonPids();
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

  // Walk daemons, collecting every one of OURS whose env has drifted.
  // We can't break at the first hit and `--stop` the world: that would
  // also kill other stacks' daemons. Instead gather each drifted PID
  // and signal them individually below.
  const drifted: { pid: number; key: string }[] = [];
  for (const pid of pids) {
    const environ = readDaemonEnv(pid);
    if (!environ) continue; // daemon vanished or perms denied — skip
    if (!ownsDaemon(environ, expectedEnv)) continue; // foreign stack/slot — not our problem
    for (const key of watchedKeys) {
      const expected = expectedEnv[key] ?? '';
      const actual = environ[key] ?? '';
      if (expected !== actual) {
        drifted.push({ pid, key });
        break;
      }
    }
  }

  if (drifted.length === 0) return { stopped: false };

  // SIGTERM lets the daemon run its JVM shutdown hooks and deregister
  // from the gradle daemon registry cleanly; a stale registry entry is
  // harmless anyway since gradle reconnects/respawns on the next run.
  const stoppedPids: number[] = [];
  for (const { pid, key } of drifted) {
    log?.(
      `[zbb] gradle daemon ${pid} env stale on ${key} — ` +
        `stopping (next gradle invocation will respawn with fresh env)`,
    );
    try {
      process.kill(pid, 'SIGTERM');
      stoppedPids.push(pid);
    } catch (e) {
      log?.(`[zbb] failed to stop gradle daemon ${pid}: ${(e as Error).message}`);
    }
  }

  const first = drifted[0];
  return {
    stopped: stoppedPids.length > 0,
    driftedKey: first.key,
    driftedPid: first.pid,
    stoppedPids,
  };
}

/**
 * Halt the gradle daemon(s) for THIS stack/slot after an interrupt
 * (Ctrl-C), WITHOUT a global `./gradlew --stop`. A bare `--stop` tears
 * down every daemon on the host, so interrupting one `zbb` build would
 * kill a concurrent build running a different stack ("Gradle build
 * daemon has been stopped: stop command received"). We only want to
 * stop our own build's daemon.
 *
 * On linux: SIGTERM each daemon whose ZB_STACK + ZB_SLOT match
 * `expectedEnv` (typically `process.env` — the daemon inherited these
 * from the gradle launch). Daemons owned by other stacks/slots, and
 * anonymous `./gradlew` daemons, are left running. If none of ours are
 * found there's nothing to stop — we do NOT fall back to a global stop,
 * since that would hit foreign daemons we deliberately spared.
 *
 * On non-linux (`/proc` unavailable, so we can't identify daemons by
 * env): fall back to a detached, best-effort global `./gradlew --stop`
 * from `repoRoot` — the pre-existing behaviour on those platforms.
 *
 * Safe to call from a signal handler: the linux path is a quick
 * pgrep + small reads + signals; the non-linux path is fire-and-forget.
 */
export function stopGradleDaemonsForStack(
  repoRoot: string,
  wrapper: string,
  expectedEnv: NodeJS.ProcessEnv,
): void {
  if (process.platform === 'linux') {
    for (const pid of listGradleDaemonPids()) {
      const environ = readDaemonEnv(pid);
      if (!environ) continue;
      if (!ownsDaemon(environ, expectedEnv)) continue;
      try {
        process.kill(pid, 'SIGTERM');
      } catch {
        // already gone — fine
      }
    }
    return;
  }

  try {
    spawn(wrapper, ['--stop'], {
      cwd: repoRoot,
      stdio: 'ignore',
      detached: true,
    }).unref();
  } catch {
    // best-effort cleanup — never let it mask the original interrupt
  }
}

/**
 * List PIDs of live gradle daemons across the whole host. A non-zero
 * pgrep exit ("no matches") and any other failure both yield [].
 */
function listGradleDaemonPids(): number[] {
  try {
    const out = execSync('pgrep -f GradleDaemon', {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return out
      .trim()
      .split('\n')
      .map(s => parseInt(s, 10))
      .filter(n => Number.isFinite(n));
  } catch {
    return [];
  }
}

/**
 * Whether a daemon (by its /proc environ) belongs to the same
 * stack/slot as `expectedEnv`. ZB_STACK + ZB_SLOT are stamped by
 * prepareSlot on every zbb spawn, so any daemon zbb launched carries
 * them; anonymous `./gradlew` daemons match only when we ourselves have
 * no stack/slot set.
 */
function ownsDaemon(
  environ: Record<string, string>,
  expectedEnv: NodeJS.ProcessEnv,
): boolean {
  return (
    (environ.ZB_STACK ?? '') === (expectedEnv.ZB_STACK ?? '') &&
    (environ.ZB_SLOT ?? '') === (expectedEnv.ZB_SLOT ?? '')
  );
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
