/**
 * Project-centric TTY display for zbb monorepo lifecycle commands
 * (build/test/gate/clean/publish).
 *
 * Reads JSON-line events from `<repo>/.zbb-monorepo/events.jsonl` (written by
 * the zb.monorepo-base Gradle plugin's MonorepoEventEmitter) and renders a
 * live table where each row is a workspace package. The row updates in place
 * to show:
 *   - icon (spinner / ✓ / ✗)
 *   - project short name (column-aligned)
 *   - current step name + elapsed (column-aligned)
 *   - timeline of completed steps trailing to the right with their durations
 *
 * Layout:
 *
 *   [zbb] ./gradlew monorepoBuild -Pmonorepo.all=true
 *
 *     ⠋ aws-common  transpile  18.7s   generate 4.6s · lint 1.2s
 *     ✓ core        transpile  12.7s   lint 1.2s · transpile 12.7s
 *     ⠋ events      generate    1.5s
 *     ⠋ pg          lint        0.3s
 *
 * The trailing timeline shows parallelism at a glance: aws-common is on
 * transpile while pg is still on lint, but you can see aws-common already
 * finished generate and lint.
 *
 * Implementation notes:
 *   - Spawns gradle with `detached: true` so the child has no controlling
 *     terminal — prevents Java's System.console() from bleeding gradle's
 *     own progress output to the user's terminal.
 *   - Uses cursor-up positioning with the PREVIOUS rendered row count (not
 *     the current count), so newly-added rows don't desync the cursor math.
 *   - Per-task log files in .zbb-monorepo/logs/ are referenced in the
 *     final summary so users can `cat` them after the run.
 */

import {
  existsSync, statSync, openSync, readSync, closeSync, unlinkSync, mkdirSync,
  createWriteStream, readFileSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { spawn } from 'node:child_process';

// ── Event types (must match MonorepoEventEmitter.kt) ────────────────

interface TaskStartEvent {
  event: 'task_start';
  project: string;
  step: string;
  ts: number;
}

interface TaskDoneEvent {
  event: 'task_done';
  project: string;
  step: string;
  status: 'passed' | 'failed' | 'skipped' | 'up-to-date' | 'from-cache';
  durationMs: number;
  ts: number;
}

type Event = TaskStartEvent | TaskDoneEvent;

// ── Per-project state ────────────────────────────────────────────────

type StepStatus = 'running' | 'passed' | 'failed' | 'skipped' | 'cached';

interface StepEntry {
  name: string;
  startedAt: number;
  durationMs?: number;
  status: StepStatus;
}

type ProjectStatus = 'running' | 'passed' | 'failed';

interface ProjectState {
  shortName: string;
  fullPath: string;
  steps: StepEntry[];
  status: ProjectStatus;
  /** Path to the failing task's log file (set on failure) */
  failedLogFile?: string;
  /** When the FIRST step started (project-wide elapsed) */
  projectStartedAt: number;
}

// ── ANSI color helpers ──────────────────────────────────────────────

const COLOR = {
  reset: '\x1b[0m',
  dim: '\x1b[90m',
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
};

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

// ── Display renderer ────────────────────────────────────────────────

export class MonorepoDisplay {
  private projects = new Map<string, ProjectState>();
  /** Insertion order — keeps row positions stable as projects appear */
  private projectOrder: string[] = [];
  private spinnerIdx = 0;
  private spinnerTimer: ReturnType<typeof setInterval> | null = null;
  /** How many rows we wrote in our last render() call. Used for cursor-up. */
  private lastRowCount = 0;
  private maxNameLen = 0;
  private maxCurrentStepLen = 0;
  private isTTY: boolean;
  private logsDir: string;
  private startTime: number;
  /** Set true after finalize() if we printed inline error output. Used by
   *  the caller to suppress the redundant gradle stderr block. */
  didShowInlineErrors = false;

  constructor(logsDir: string, isTTY: boolean = process.stdout.isTTY ?? false) {
    this.logsDir = logsDir;
    this.isTTY = isTTY;
    this.startTime = Date.now();
  }

  handleEvent(ev: Event): void {
    if (ev.event === 'task_start') this.onStart(ev);
    else if (ev.event === 'task_done') this.onDone(ev);
    this.maybeStartSpinner();
    this.render();
  }

  private onStart(ev: TaskStartEvent): void {
    // Use the local Node clock for startedAt (not the JVM-side ev.ts) so the
    // live elapsed display (`now - startedAt`) stays in a single clock domain.
    // Cross-process clock skew between the JVM and Node was producing either
    // brief negative values or 0.0s for ~1s before catching up.
    const localStart = Date.now();
    let state = this.projects.get(ev.project);
    if (!state) {
      const shortName = this.shortenProject(ev.project);
      state = {
        shortName,
        fullPath: ev.project,
        steps: [],
        status: 'running',
        projectStartedAt: localStart,
      };
      this.projects.set(ev.project, state);
      this.projectOrder.push(ev.project);
      if (shortName.length > this.maxNameLen) this.maxNameLen = shortName.length;
    }
    state.steps.push({
      name: ev.step,
      startedAt: localStart,
      status: 'running',
    });
    if (ev.step.length > this.maxCurrentStepLen) this.maxCurrentStepLen = ev.step.length;
  }

  private onDone(ev: TaskDoneEvent): void {
    // Map the wire status to our internal step status
    const stepStatus: StepStatus =
      ev.status === 'failed' ? 'failed'
      : ev.status === 'skipped' ? 'skipped'
      : ev.status === 'up-to-date' || ev.status === 'from-cache' ? 'cached'
      : 'passed';

    let state = this.projects.get(ev.project);
    if (!state) {
      // task_done with no prior task_start — this is a CACHED task (up-to-date
      // or from build cache) where the doFirst hook didn't fire because Gradle
      // skipped the task action. Create the project row on the fly.
      const shortName = this.shortenProject(ev.project);
      state = {
        shortName,
        fullPath: ev.project,
        steps: [],
        status: 'running',
        projectStartedAt: ev.ts - ev.durationMs,
      };
      this.projects.set(ev.project, state);
      this.projectOrder.push(ev.project);
      if (shortName.length > this.maxNameLen) this.maxNameLen = shortName.length;
    }

    // Find an in-flight step with the matching name, or push a new entry for
    // a directly-completed (cached/skipped) step.
    let matched = false;
    for (let i = state.steps.length - 1; i >= 0; i -= 1) {
      const s = state.steps[i];
      if (s.name === ev.step && s.status === 'running') {
        s.status = stepStatus;
        s.durationMs = ev.durationMs;
        matched = true;
        break;
      }
    }
    if (!matched) {
      // Push a new completed-step entry (cached/skipped path)
      state.steps.push({
        name: ev.step,
        startedAt: ev.ts - ev.durationMs,
        durationMs: ev.durationMs,
        status: stepStatus,
      });
      if (ev.step.length > this.maxCurrentStepLen) {
        this.maxCurrentStepLen = ev.step.length;
      }
    }

    if (ev.status === 'failed') {
      state.status = 'failed';
      state.failedLogFile = join(
        this.logsDir,
        `${ev.project.replace(/^:/, '').replace(/:/g, '-')}-${ev.step}.log`,
      );
    }
  }

  /**
   * Finalize the display when gradle exits. Derives each project's overall
   * status from its step states (NOT from the global gradle exit code), so
   * projects that completed all their steps successfully are shown as ✓
   * even if a different project caused the build to fail.
   *
   * Steps still in 'running' state are normalized:
   *   - If gradle exited successfully → mark as 'passed'
   *   - If gradle failed → mark as 'skipped' (the task never got to run because
   *     gradle aborted; it didn't fail itself)
   */
  finalize(success: boolean): void {
    const now = Date.now();

    for (const state of this.projects.values()) {
      // Normalize any still-running steps. If gradle exited successfully,
      // anything still running was probably the very last task to finish
      // (event arrived late) — mark passed. If gradle failed, the still-
      // running steps were aborted — mark skipped, NOT failed.
      for (const step of state.steps) {
        if (step.status === 'running') {
          step.status = success ? 'passed' : 'skipped';
          step.durationMs = now - step.startedAt;
        }
      }

      // Derive project status from steps:
      //   any step failed → project failed
      //   else → project passed (cached/skipped steps still count as success)
      const hasFailure = state.steps.some(s => s.status === 'failed');
      state.status = hasFailure ? 'failed' : 'passed';
    }

    // Track whether we showed inline error output, so the caller can decide
    // whether to also dump gradle's own stderr (which is usually noise after
    // the inline error).
    this.didShowInlineErrors = [...this.projects.values()].some(p => p.status === 'failed');

    this.stopSpinner();
    this.render();

    // For each failed step, print the log file path AND inline content
    // (last ~40 lines) so the user can see the error without leaving the
    // terminal. Full log is still available at the file path.
    const failedSteps: Array<{ project: ProjectState; step: StepEntry; logFile: string }> = [];
    for (const project of this.projects.values()) {
      for (const step of project.steps) {
        if (step.status !== 'failed') continue;
        const safeName = project.fullPath.replace(/^:/, '').replace(/:/g, '-');
        const logFile = join(this.logsDir, `${safeName}-${step.name}.log`);
        failedSteps.push({ project, step, logFile });
      }
    }

    if (failedSteps.length > 0) {
      process.stdout.write('\n');
      for (const { project, step, logFile } of failedSteps) {
        // Header for this failure
        process.stdout.write(
          `${COLOR.red}── ${project.shortName}: ${step.name} failed ──${COLOR.reset}\n\n`,
        );
        // Inline content: tail of the log file
        try {
          if (existsSync(logFile)) {
            const content = readFileSync(logFile, 'utf-8');
            const lines = content.split('\n').filter(l => l.length > 0);
            const tail = lines.slice(-40);
            for (const line of tail) {
              process.stdout.write(`  ${line}\n`);
            }
            if (lines.length > 40) {
              process.stdout.write(
                `${COLOR.dim}  … (${lines.length - 40} more lines in log file)${COLOR.reset}\n`,
              );
            }
          } else {
            process.stdout.write(`${COLOR.dim}  (log file not found)${COLOR.reset}\n`);
          }
        } catch (e) {
          process.stdout.write(
            `${COLOR.dim}  (could not read log: ${(e as Error).message})${COLOR.reset}\n`,
          );
        }
        // Log file path BELOW the error output
        process.stdout.write(`\n${COLOR.dim}  log: ${logFile}${COLOR.reset}\n\n`);
      }
    }

    // Footer: always print paths + timing for post-mortem inspection.
    // When no projects were registered (everything was up-to-date and
    // gradle finished instantly), show an explicit message so the user
    // knows something happened.
    const elapsed = ((Date.now() - this.startTime) / 1000).toFixed(1);
    if (this.projectOrder.length === 0) {
      process.stdout.write(`${COLOR.dim}  All tasks up-to-date (${elapsed}s)${COLOR.reset}\n`);
    }
    const eventsPath = join(dirname(this.logsDir), 'events.jsonl');
    const gradleLogPath = join(dirname(this.logsDir), 'gradle.log');
    process.stdout.write(
      `${COLOR.dim}  events: ${eventsPath}${COLOR.reset}\n` +
      `${COLOR.dim}  logs:   ${this.logsDir}${COLOR.reset}\n` +
      `${COLOR.dim}  gradle: ${gradleLogPath}${COLOR.reset}\n`,
    );
  }

  // ── Rendering ────────────────────────────────────────────────────

  private maybeStartSpinner(): void {
    if (this.spinnerTimer || !this.isTTY) return;
    this.spinnerTimer = setInterval(() => {
      this.spinnerIdx = (this.spinnerIdx + 1) % SPINNER_FRAMES.length;
      this.render();
    }, 100);
  }

  private stopSpinner(): void {
    if (this.spinnerTimer) {
      clearInterval(this.spinnerTimer);
      this.spinnerTimer = null;
    }
  }

  private render(): void {
    if (!this.isTTY || this.projectOrder.length === 0) return;

    // Move cursor up by the number of rows we wrote LAST time (not the
    // current count — they may differ if a new project just appeared).
    if (this.lastRowCount > 0) {
      process.stdout.write(`\x1b[${this.lastRowCount}A`);
    }

    let written = 0;
    for (const path of this.projectOrder) {
      const state = this.projects.get(path)!;
      // \x1b[2K clears the entire line before re-writing it
      process.stdout.write(`\x1b[2K${this.renderRow(state)}\n`);
      written += 1;
    }

    // If the last render had MORE rows than this one (shouldn't happen but
    // be defensive), clear the extra trailing rows so they don't linger.
    for (let i = written; i < this.lastRowCount; i += 1) {
      process.stdout.write('\x1b[2K\n');
    }

    this.lastRowCount = Math.max(written, this.lastRowCount);
  }

  private renderRow(state: ProjectState): string {
    const namePad = state.shortName.padEnd(this.maxNameLen);

    // Leading icon + project name
    let icon: string;
    let iconColor: string;
    if (state.status === 'passed') {
      icon = '✓';
      iconColor = COLOR.green;
    } else if (state.status === 'failed') {
      icon = '✗';
      iconColor = COLOR.red;
    } else {
      icon = SPINNER_FRAMES[this.spinnerIdx];
      iconColor = COLOR.cyan;
    }

    // Build the step timeline flowing left → right.
    // Each step is rendered as:
    //   running:           "name 0.3s"           (cyan, no checkmark yet)
    //   completed passed:  "name 1.2s ✓"         (green)
    //   completed failed:  "name 1.2s ✗"         (red)
    //   cached/up-to-date: "name ◆ cached"       (blue/dim)
    //   skipped:           "name · skipped"      (dim)
    //
    // Each step is also tagged with its plain-text width, used below to
    // truncate the timeline so the rendered row fits in the terminal width
    // and never wraps. Wrapping is catastrophic for the cursor-up render
    // strategy: a wrapped line consumes multiple terminal rows but the
    // cursor math only counts logical rows, so the cursor moves up too few
    // rows and each render leaves orphaned content scrolling off-screen.
    const now = Date.now();
    const stepParts: Array<{ rendered: string; width: number }> = state.steps.map(s => {
      if (s.status === 'running') {
        // Clamp to >= 0 in case the JVM-emitted ts is slightly ahead of
        // the Node clock (cross-process clock skew).
        const elapsed = (Math.max(0, now - s.startedAt) / 1000).toFixed(1);
        const text = `${s.name} ${elapsed}s`;
        return { rendered: `${COLOR.cyan}${text}${COLOR.reset}`, width: text.length };
      }
      const dur = s.durationMs != null ? `${(s.durationMs / 1000).toFixed(1)}s` : '?';
      if (s.status === 'failed') {
        const text = `${s.name} ${dur} ✗`;
        return { rendered: `${COLOR.red}${text}${COLOR.reset}`, width: text.length };
      }
      if (s.status === 'skipped') {
        const text = `${s.name} skipped`;
        return { rendered: `${COLOR.dim}${text}${COLOR.reset}`, width: text.length };
      }
      if (s.status === 'cached') {
        const text = `${s.name} ◆ cached`;
        return { rendered: `${COLOR.blue}${text}${COLOR.reset}`, width: text.length };
      }
      // passed
      const text = `${s.name} ${dur} ✓`;
      return { rendered: `${COLOR.green}${text}${COLOR.reset}`, width: text.length };
    });

    // Layout: "  <icon> <name>   <timeline>"
    // Plain-text width of the prefix (icon + space + padded name + 3 spaces).
    const prefixWidth = 2 + 1 + 1 + this.maxNameLen + 3;
    const sepPlain = '  ·  ';
    const sepRendered = `  ${COLOR.dim}·${COLOR.reset}  `;

    // Reserve a small right margin so we never sit *exactly* at the terminal
    // edge — some terminals auto-wrap on the last column even when the line
    // is empty after it. Default to 120 cols if stdout has no columns info.
    const maxCols = (process.stdout.columns ?? 120) - 1;
    const budget = Math.max(20, maxCols - prefixWidth);

    // Greedily emit step pills until we'd overflow `budget`. If we have to
    // drop steps, append a dim "+N more" suffix so the user knows.
    let timeline = '';
    let used = 0;
    let included = 0;
    for (const part of stepParts) {
      const sepW = included === 0 ? 0 : sepPlain.length;
      if (used + sepW + part.width > budget) break;
      if (included > 0) timeline += sepRendered;
      timeline += part.rendered;
      used += sepW + part.width;
      included += 1;
    }
    const dropped = stepParts.length - included;
    if (dropped > 0) {
      const suffix = ` +${dropped}`;
      // Trim earlier pills if needed to fit the suffix
      while (used + sepPlain.length + suffix.length > budget && included > 0) {
        // Strip trailing pill+sep — easier to just rebuild than parse ANSI
        timeline = '';
        used = 0;
        included -= 1;
        for (let i = 0; i < included; i += 1) {
          const part = stepParts[i];
          const sepW = i === 0 ? 0 : sepPlain.length;
          if (i > 0) timeline += sepRendered;
          timeline += part.rendered;
          used += sepW + part.width;
        }
      }
      if (included > 0) timeline += sepRendered;
      timeline += `${COLOR.dim}+${dropped}${COLOR.reset}`;
    }

    return `  ${iconColor}${icon} ${namePad}${COLOR.reset}   ${timeline}`;
  }

  private shortenProject(fullPath: string): string {
    const parts = fullPath.split(':').filter(s => s.length > 0);
    return parts[parts.length - 1] || fullPath;
  }
}

// ── File tailer ──────────────────────────────────────────────────────

/**
 * Tail an event file and call `onEvent` for each new event line. Polls the
 * file every `pollMs` ms (default 60ms) and reads any new bytes since the
 * last position.
 */
export class EventFileTailer {
  private fd: number | null = null;
  private position = 0;
  private buffer = '';
  private timer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;

  constructor(
    private readonly path: string,
    private readonly onEvent: (ev: Event) => void,
    private readonly pollMs: number = 60,
  ) {}

  start(): void {
    this.timer = setInterval(() => {
      if (this.stopped) return;
      try {
        if (this.fd === null) {
          if (!existsSync(this.path)) return;
          this.fd = openSync(this.path, 'r');
          this.position = 0;
        }
        this.readNew();
      } catch {
        /* ignore — file may be in flux */
      }
    }, this.pollMs);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    // Final read to drain anything written between the last poll and now
    if (this.fd !== null) {
      try { this.readNew(); } catch { /* ignore */ }
      try { closeSync(this.fd); } catch { /* ignore */ }
      this.fd = null;
    }
  }

  private readNew(): void {
    if (this.fd === null) return;
    const stats = statSync(this.path);
    if (stats.size <= this.position) return;
    const len = stats.size - this.position;
    const buf = Buffer.alloc(len);
    readSync(this.fd, buf, 0, len, this.position);
    this.position = stats.size;
    this.buffer += buf.toString('utf-8');

    let nlIdx;
    while ((nlIdx = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, nlIdx).trim();
      this.buffer = this.buffer.slice(nlIdx + 1);
      if (!line) continue;
      try {
        const ev = JSON.parse(line) as Event;
        this.onEvent(ev);
      } catch {
        /* skip malformed lines */
      }
    }
  }
}

// ── Top-level helper: spawn gradle, render display, await exit ──────

/**
 * Spawn the gradle command with the project-centric display, return a
 * Promise that resolves with the gradle exit code.
 */
export function runWithDisplay(
  repoRoot: string,
  command: string,
  args: string[],
  options: { verbose?: boolean } = {},
): Promise<number> {
  return new Promise((resolve) => {
    runWithDisplayBody(repoRoot, command, args, options, resolve);
  });
}

function runWithDisplayBody(
  repoRoot: string,
  command: string,
  args: string[],
  _options: { verbose?: boolean },
  resolve: (code: number) => void,
): void {
  const eventDir = join(repoRoot, '.zbb-monorepo');
  const logsDir = join(eventDir, 'logs');
  const eventFile = join(eventDir, 'events.jsonl');
  const gradleLogFile = join(eventDir, 'gradle.log');

  mkdirSync(eventDir, { recursive: true });
  mkdirSync(logsDir, { recursive: true });
  try { unlinkSync(eventFile); } catch { /* didn't exist */ }

  // ZBB_FORCE_TTY=1 forces the display path even when stdout isn't a tty
  // (useful for capturing display output to a file for review/testing).
  const isTTY = (process.stdout.isTTY ?? false) || process.env.ZBB_FORCE_TTY === '1';
  const display = new MonorepoDisplay(logsDir, isTTY);
  const tailer = new EventFileTailer(eventFile, (ev) => display.handleEvent(ev));

  process.stdout.write(`${COLOR.dim}[zbb] ${command} ${args.join(' ')}${COLOR.reset}\n\n`);

  // Force --console=plain to suppress gradle's own rendering, and --parallel
  // to actually run subproject tasks concurrently (gradle is sequential by
  // default!). detached: true below uses setsid() so the child has no
  // controlling terminal — Java's System.console() returns null and gradle's
  // rich console code path is disabled, preventing /dev/tty bleed-through.
  const gradleArgs = ['--console=plain', '--parallel', ...args];
  const gradleLog = createWriteStream(gradleLogFile);

  if (isTTY) {
    tailer.start();
  }

  const child = spawn(command, gradleArgs, {
    cwd: repoRoot,
    // Pipe gradle's output to a side log file. detached:true creates a new
    // session via setsid(), removing the controlling terminal so Java's
    // System.console() returns null and gradle's rich console disables itself.
    stdio: isTTY ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    detached: isTTY,
    env: {
      ...process.env,
      ZBB_MONOREPO_EVENT_FILE: eventFile,
      // Belt-and-suspenders: dumb terminal disables ANSI rendering in
      // anything that respects $TERM, in case detached/setsid doesn't
      // suffice (e.g. inside containers).
      TERM: 'dumb',
      // Force gradle's plain console at the JVM level too.
      GRADLE_OPTS: `${process.env.GRADLE_OPTS ?? ''} -Dorg.gradle.console=plain`.trim(),
    },
  });

  // Don't keep the parent process alive on the detached child; we want our
  // own exit handler to close us out.
  if (isTTY) {
    child.unref();
  }

  let stderrBuffer = '';
  if (isTTY && child.stdout) {
    child.stdout.pipe(gradleLog);
  }
  if (isTTY && child.stderr) {
    child.stderr.on('data', (chunk: Buffer) => {
      stderrBuffer += chunk.toString('utf-8');
      gradleLog.write(chunk);
    });
  }

  child.on('exit', (code) => {
    tailer.stop();
    display.finalize(code === 0);
    gradleLog.end();
    // Only print gradle's stderr if we DIDN'T show inline error output
    // already (otherwise it's just "Build failed with an exception" noise).
    if (code !== 0 && stderrBuffer.trim() && !display.didShowInlineErrors) {
      process.stderr.write(`\n${COLOR.dim}── gradle stderr ──${COLOR.reset}\n`);
      process.stderr.write(stderrBuffer);
    }
    resolve(code ?? 1);
  });

  child.on('error', (err) => {
    tailer.stop();
    gradleLog.end();
    process.stderr.write(`\n${COLOR.red}gradle spawn failed: ${err.message}${COLOR.reset}\n`);
    resolve(1);
  });
}
