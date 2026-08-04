import type { AxiosError, AxiosInstance, AxiosRequestConfig, AxiosResponse } from 'axios';
import { LoggerEngine } from '@zerobias-org/logger';

import { isTransportError, transportCodeOf } from './TransportError.js';

const logger = LoggerEngine.root().get('HubConnectorRetry');

// Retry lives here rather than in a consumer because every module that talks to hub goes
// through HubConnector: a generated `XHubImpl` extends it, and all of a module's sub-clients
// share the single axios instance connect() creates. Previously hub-client monkey-patched
// HubConnector.prototype.connect at runtime to bolt this on, which only covered collector runs
// and had to fight interceptor ordering. See HubConnector.hasNativeRetry.

// ── Hub-reported unavailability ─────────────────────────────────────────────────────────
// Hub server does not always fail a dispatch with an HTTP error status. TargetProducerImpl's
// catch sets `hub-error: true` plus `hub-error-status` and *returns* the serialized CoreError,
// so the controller answers 200 and the failure is invisible to any status-based retry.
//
// That bucket also holds genuine module failures, and replaying a module operation is not safe
// in general, so retrying is gated on the message as well as the status. Every pattern below
// names a specific server-side condition that resolves on its own.
const HUB_TRANSIENT_MESSAGE = new RegExp([
  // Dispatcher.ts - node dropped between target lookup and dispatch.
  'is no longer connected',
  // Waiter.ts - node accepted the message and never answered within the waiter timeout.
  'exceeded \\d+ second timeout',
  // Node still bringing the module container up - the start races seen under burst load.
  //
  // These are copied from the node's actual throw sites, not guessed:
  //   `Deployment [id]: no port in state - not running`  (node ContainerDeployment.ts)
  //   `Container failed to start: <state>`               (node lib/docker/Container.ts)
  //
  // Both arrive as a hub-error 500, which is not in retryStatuses, so this message gate is the
  // only thing that makes them retryable - the text has to be right rather than plausible. An
  // earlier version of this list guessed at `container ... is not running` and `image pull`,
  // neither of which the node ever emits, so the container-start race - the trigger of the
  // production incident this retry layer exists for - was silently not retried.
  //
  // Kept deliberately in sync with hub-client's copy in `com/hub/client/src/HttpRetry.ts`.
  // hub-client stands down when `HubConnector.hasNativeRetry` is true, so once that ships this
  // list is the live one for the dominant vendor-module path; a divergence here un-fixes the
  // incident rather than merely degrading coverage.
  'no port in state',
  'Container failed to start',
].join('|'), 'i');

// Explicitly not retryable even when they arrive with a transient-looking status: these are
// decisions, not blips, and replaying them just burns the budget.
const HUB_PERMANENT_MESSAGE = /administratively disabled|Cannot execute on (Connection|Scope) in status/i;

export type FailureKind = 'transport' | 'unavailable';

export interface FailureClassification {
  kind: FailureKind;
  reason: string;
}

export interface RetryConfig {
  /** Total attempts including the first. 1 disables retrying. */
  attempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  /**
   * A transport failure with no response is usually a reused idle socket that the peer had
   * already closed; re-dialling costs nothing and almost always succeeds, so the first retry
   * skips the backoff entirely.
   */
  immediateFirstRetry: boolean;
  /** HTTP statuses treated as unavailability, including hub-error-status values. */
  retryStatuses: number[];
  /** Uppercase HTTP methods eligible for replay. */
  retryMethods: string[];
  /**
   * Consecutive transient failures against one target before retrying is abandoned.
   * 0 disables the breaker.
   */
  breakerThreshold: number;
}

/** process.env is not a given - HubConnector supports browsers (see `withCredentials`). */
const env = (name: string): string | undefined => {
  if (typeof process === 'undefined' || !process.env) {
    return undefined;
  }
  return process.env[name];
};

/**
 * `HUB_CONNECTOR_*` is the name for this package; `HUB_CLIENT_*` is accepted as a fallback so
 * deployments already tuning hub-client's runtime patch keep their settings when it stands
 * down in favour of the native implementation.
 */
const readEnv = (suffix: string): string | undefined => env(`HUB_CONNECTOR_${suffix}`) ?? env(`HUB_CLIENT_${suffix}`);

const readInt = (suffix: string, fallback: number): number => {
  const raw = readEnv(suffix);
  if (raw === undefined || raw.trim() === '') {
    return fallback;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    logger.warning(`Ignoring ${suffix}=${raw}, expected a non-negative number`);
    return fallback;
  }
  return Math.floor(parsed);
};

const readList = (suffix: string, fallback: string): string[] => (readEnv(suffix) ?? fallback)
  .split(',')
  .map((entry) => entry.trim())
  .filter((entry) => entry.length > 0);

/**
 * Defaults deliberately match the values hub-client's runtime patch already runs with in
 * production. Weakening them here would silently regress collector runs the moment hub-client
 * stands its patch down: the ECS task definition does not forward `HUB_CLIENT_*`, so those code
 * defaults *are* the production configuration today.
 *
 * The ladder is sized against what it waits for. A node reconnects on a 30s timer with +/-2.5s
 * jitter, so anything giving up before ~33s cannot outlast a single reconnect. These put the
 * ladder's floor at 34s and its ceiling at 68s.
 */
export const loadRetryConfig = (): RetryConfig => ({
  attempts: Math.max(1, readInt('RETRY_ATTEMPTS', 6)),
  baseDelayMs: readInt('RETRY_BASE_MS', 4_000),
  maxDelayMs: readInt('RETRY_MAX_MS', 20_000),
  immediateFirstRetry: (readEnv('RETRY_IMMEDIATE_FIRST') ?? 'true') !== 'false',
  // 429 is absent deliberately: neither hub nor Dana runs a rate limiter, so it cannot occur.
  // 598 is Dana's ECONNRESET mapping (it deliberately does not use 504).
  retryStatuses: readList('RETRY_STATUSES', '502,503,504,598')
    .map((entry) => Number(entry))
    .filter((status) => Number.isInteger(status)),
  // POST and PATCH are left out: a reset can arrive after the server already applied the
  // request, and replaying those risks duplicate writes.
  retryMethods: readList('RETRY_METHODS', 'GET,HEAD,OPTIONS,PUT,DELETE')
    .map((entry) => entry.toUpperCase()),
  breakerThreshold: readInt('RETRY_BREAKER_THRESHOLD', 5),
});

/**
 * Retry counters for the process.
 *
 * Retries make a degraded node invisible: the job still succeeds, so nothing signals that the
 * infrastructure is struggling until it fails outright. These are what a caller reports at the
 * end of a run so a spike is an early warning of node starvation rather than something only
 * visible by reading logs nobody watches.
 *
 * Shape is identical to hub-client's RetryStats so the two can be summed field by field while
 * both retry paths coexist.
 */
export interface RetryStats {
  /** Retries performed after a transport-level failure (nothing came back off the wire). */
  transportRetries: number;
  /** Retries performed after the target reported itself unavailable. */
  unavailableRetries: number;
  /** Requests that ran out of attempts. */
  exhausted: number;
  /** Times the breaker opened on a target. */
  breakerTrips: number;
  /** Retries per target, so a single bad node stands out from general noise. */
  byTarget: Record<string, number>;
}

const emptyStats = (): RetryStats => ({
  transportRetries: 0,
  unavailableRetries: 0,
  exhausted: 0,
  breakerTrips: 0,
  byTarget: {},
});

// Held on globalThis rather than in module scope on purpose. Collector bundles routinely carry
// several copies of this package - hub-client's findPackageCopies exists precisely because of
// that - and a module-level counter would give each copy its own private tally, so whichever
// copy the reader resolved would silently under-report. Symbol.for keeps one object per
// process, shared by every duplicate.
const STATS_KEY = Symbol.for('zerobias.connector.retry.stats');

const globalStats = globalThis as unknown as Record<symbol, RetryStats | undefined>;
if (!globalStats[STATS_KEY]) {
  globalStats[STATS_KEY] = emptyStats();
}
const stats: RetryStats = globalStats[STATS_KEY]!;

/**
 * A snapshot of the retry counters. The result is a copy, `byTarget` included, so a caller
 * cannot mutate the live counters by holding on to it.
 */
export const getRetryStats = (): RetryStats => ({ ...stats, byTarget: { ...stats.byTarget } });

/**
 * Zeroes the counters, typically at the start of a job.
 *
 * Mutates in place rather than rebinding: duplicate copies of this package share the one
 * object, and replacing it would leave them incrementing an orphan.
 */
export const resetRetryStats = (): void => {
  stats.transportRetries = 0;
  stats.unavailableRetries = 0;
  stats.exhausted = 0;
  stats.breakerTrips = 0;
  stats.byTarget = {};
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms); });

const messageOf = (body: unknown): string => {
  if (typeof body === 'string') {
    return body;
  }
  if (body && typeof body === 'object') {
    const candidate = body as Record<string, unknown>;
    if (typeof candidate.message === 'string') {
      return candidate.message;
    }
    try {
      return JSON.stringify(body);
    } catch {
      return '';
    }
  }
  return '';
};

/**
 * The effective status of a hub response. Hub answers 200 for some dispatch failures and
 * reports the real status in `hub-error-status`; a waiter timeout carries no status header at
 * all, so an unlabelled hub-error is treated as a 500.
 */
export const hubErrorStatus = (response: AxiosResponse): number | undefined => {
  if (response.headers?.['hub-error'] !== 'true') {
    return undefined;
  }
  const parsed = Number(response.headers['hub-error-status']);
  return Number.isInteger(parsed) ? parsed : 500;
};

/** Classifies a response that axios considered successful. Undefined means "keep it". */
export const classifyResponse = (
  response: AxiosResponse,
  cfg: RetryConfig
): FailureClassification | undefined => {
  const hubStatus = hubErrorStatus(response);
  const status = hubStatus ?? response.status;
  const message = messageOf(response.data);

  if (HUB_PERMANENT_MESSAGE.test(message)) {
    return undefined;
  }

  if (hubStatus !== undefined) {
    // A hub-error 500 is the common shape for node-unavailability, but it is also what a
    // module's own failure looks like, so the message has to agree before replaying.
    if (HUB_TRANSIENT_MESSAGE.test(message)) {
      return { kind: 'unavailable', reason: `hub-error ${status}: ${message.slice(0, 120)}` };
    }
    if (cfg.retryStatuses.includes(status)) {
      return { kind: 'unavailable', reason: `hub-error ${status}` };
    }
    return undefined;
  }

  if (cfg.retryStatuses.includes(response.status)) {
    return { kind: 'unavailable', reason: `status ${response.status}` };
  }
  return undefined;
};

/** Classifies a rejection. Undefined means the error is the server's answer, not a blip. */
export const classifyError = (
  error: AxiosError,
  cfg: RetryConfig
): FailureClassification | undefined => {
  if (error.response) {
    const fromResponse = classifyResponse(error.response, cfg);
    if (fromResponse) {
      return fromResponse;
    }
  }
  if (isTransportError(error)) {
    return { kind: 'transport', reason: transportCodeOf(error) ?? error.code ?? error.message ?? 'transport failure' };
  }
  return undefined;
};

// A request body consumed by the first attempt cannot be replayed: re-sending a drained stream
// or a used FormData produces a truncated request that looks like a second, different failure.
// Plain objects and strings are re-serialised by axios each time.
const isReplayableBody = (data: unknown): boolean => {
  if (data === undefined || data === null || typeof data === 'string') {
    return true;
  }
  if (typeof Buffer !== 'undefined' && Buffer.isBuffer(data)) {
    return true;
  }
  if (typeof URLSearchParams !== 'undefined' && data instanceof URLSearchParams) {
    return true;
  }
  if (typeof data === 'object') {
    const candidate = data as Record<string, unknown>;
    const isStream = typeof candidate.pipe === 'function';
    const isFormData = typeof candidate.getBoundary === 'function'
      || (typeof candidate.append === 'function' && typeof candidate.getHeaders === 'function');
    return !isStream && !isFormData;
  }
  return true;
};

/**
 * Exponential backoff with full jitter. Jitter matters because a node blip fails many callers
 * at once; without it they all come back in lockstep and re-create the thundering herd that
 * caused the drop.
 */
export const backoffDelay = (step: number, config: RetryConfig): number => {
  const ceiling = Math.min(config.maxDelayMs, config.baseDelayMs * (2 ** Math.max(0, step - 1)));
  return Math.round(ceiling / 2 + Math.random() * (ceiling / 2));
};

/**
 * Hub's `retry-after` on a 503, in ms, when it is a sane hint. Hub knows the node reconnect
 * timer better than the client's ladder does. Capped so a bad value cannot stall a caller.
 */
export const retryAfterDelay = (
  response: AxiosResponse | undefined,
  cfg: RetryConfig
): number | undefined => {
  const header = response?.headers?.['retry-after'];
  if (header === undefined) {
    return undefined;
  }
  const seconds = Number(header);
  if (!Number.isFinite(seconds) || seconds < 0) {
    return undefined;
  }
  return Math.min(seconds * 1000, cfg.maxDelayMs * 2);
};

/** Ladder step for a given retry, accounting for the free immediate retry on transport errors. */
const ladderStep = (retryNumber: number, kind: FailureKind, cfg: RetryConfig): number => (
  kind === 'transport' && cfg.immediateFirstRetry ? retryNumber - 1 : retryNumber
);

export const delayForRetry = (retryNumber: number, kind: FailureKind, cfg: RetryConfig): number => {
  if (kind === 'transport' && retryNumber === 1 && cfg.immediateFirstRetry) {
    return 0;
  }
  return backoffDelay(ladderStep(retryNumber, kind, cfg), cfg);
};

/**
 * Fails fast once a target has proven to be down.
 *
 * Callers invoke per entity in loops - thousands of calls per collector run - and without this
 * a hard-down node costs every one of them the full ladder, turning a fast failure into tens of
 * minutes of sleeping before reaching the identical outcome.
 */
export class RetryBreaker {
  private readonly consecutive = new Map<string, number>();

  private readonly tripped = new Set<string>();

  constructor(private readonly threshold: number) {}

  isOpen(key: string): boolean {
    return this.threshold > 0 && this.tripped.has(key);
  }

  recordFailure(key: string): boolean {
    if (this.threshold <= 0) {
      return false;
    }
    const next = (this.consecutive.get(key) ?? 0) + 1;
    this.consecutive.set(key, next);
    if (next >= this.threshold && !this.tripped.has(key)) {
      this.tripped.add(key);
      logger.error(
        `Retry breaker open for ${key} after ${next} consecutive transient failures; `
        + 'further calls will fail fast instead of retrying'
      );
      return true;
    }
    return false;
  }

  recordSuccess(key: string): void {
    if (this.consecutive.get(key)) {
      this.consecutive.delete(key);
    }
    if (this.tripped.delete(key)) {
      logger.info(`Retry breaker closed for ${key}`);
    }
  }
}

let defaultBreaker: RetryBreaker | undefined;

export const getDefaultBreaker = (cfg: RetryConfig): RetryBreaker => {
  if (!defaultBreaker) {
    defaultBreaker = new RetryBreaker(cfg.breakerThreshold);
  }
  return defaultBreaker;
};

/** Test seam - resets the process-wide breaker. */
export const resetDefaultBreaker = (): void => {
  defaultBreaker = undefined;
};

// Deliberately a string key, not a symbol: axios rebuilds the request config through
// mergeConfig() on every call, and that merge walks Object.keys(), so a symbol-keyed attempt
// counter is silently dropped on the first replay and the retry loop never terminates.
const ATTEMPT_KEY = 'zerobiasHubRetryAttempt';
const ATTACHED_KEY = Symbol.for('zerobias.connector.retry.attached');

const describeRequest = (config: AxiosRequestConfig): string => {
  const method = (config.method ?? 'get').toUpperCase();
  const url = typeof config.url === 'string' ? config.url.split('?')[0] : '';
  return `${method} ${url}` || 'request';
};

const breakerKeyFor = (config: AxiosRequestConfig, label: string): string => (
  typeof config.baseURL === 'string' && config.baseURL.length > 0 ? config.baseURL : label
);

const attemptOf = (config: AxiosRequestConfig): number => (config as any)[ATTEMPT_KEY] ?? 1;

const newIdempotencyKey = (): string => {
  const webCrypto = (globalThis as any).crypto;
  if (webCrypto && typeof webCrypto.randomUUID === 'function') {
    return webCrypto.randomUUID();
  }
  return `${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`;
};

/**
 * Replays `config` if it is still eligible, returning the new response. Returns undefined when
 * the request must not be retried, leaving the caller to surface the original outcome.
 */
const replay = async (
  instance: AxiosInstance,
  config: AxiosRequestConfig,
  cfg: RetryConfig,
  breaker: RetryBreaker,
  label: string,
  failure: FailureClassification,
  delayOverride?: number
): Promise<AxiosResponse | undefined> => {
  const attempt = attemptOf(config);
  const key = breakerKeyFor(config, label);
  const method = (config.method ?? 'get').toUpperCase();

  if (breaker.isOpen(key)) {
    logger.warning(
      `[${label}] ${describeRequest(config)} failed (${failure.reason}); `
      + 'retry breaker is open for this target, failing fast'
    );
    return undefined;
  }
  if (!cfg.retryMethods.includes(method)) {
    logger.warning(
      `[${label}] ${describeRequest(config)} failed (${failure.reason}) but ${method} is not `
      + 'replayable (it may already have been applied); not retrying'
    );
    return undefined;
  }
  if (!isReplayableBody(config.data)) {
    logger.warning(
      `[${label}] ${describeRequest(config)} failed (${failure.reason}) but its body was `
      + 'consumed by the first attempt; not retrying'
    );
    return undefined;
  }
  if (attempt >= cfg.attempts) {
    logger.error(
      `[${label}] ${describeRequest(config)} failed after ${attempt} attempt(s): ${failure.reason}`
    );
    stats.exhausted += 1;
    if (breaker.recordFailure(key)) {
      stats.breakerTrips += 1;
    }
    return undefined;
  }

  if (failure.kind === 'transport') {
    stats.transportRetries += 1;
  } else {
    stats.unavailableRetries += 1;
  }
  stats.byTarget[key] = (stats.byTarget[key] ?? 0) + 1;

  const wait = delayOverride ?? delayForRetry(attempt, failure.kind, cfg);
  logger.warning(
    `[${label}] ${describeRequest(config)} failed (${failure.reason}); `
    + `retrying ${wait === 0 ? 'immediately' : `in ${wait}ms`} (attempt ${attempt + 1}/${cfg.attempts})`
  );
  if (wait > 0) {
    await sleep(wait);
  }
  (config as any)[ATTEMPT_KEY] = attempt + 1;
  return instance.request(config);
};

/**
 * Installs transient-failure retries on an axios instance.
 *
 * Idempotent - attaching twice on the same instance is a no-op, which matters because
 * HubConnector.onInstance replays for connectors that already exist.
 *
 * Must be attached *before* any interceptor that rewrites errors. HubConnector's own response
 * interceptor rejects via `CoreError.from()`, which discards the axios `config`, so a handler
 * registered after it could never replay. Axios runs response interceptors in registration
 * order, so HubConnector.connect() calls this first.
 */
export const attachRetryInterceptor = (
  instance: AxiosInstance,
  cfg: RetryConfig = loadRetryConfig(),
  label = 'module',
  breaker: RetryBreaker = getDefaultBreaker(cfg)
): boolean => {
  const marker = instance as unknown as Record<symbol, unknown>;
  if (marker[ATTACHED_KEY]) {
    return false;
  }
  marker[ATTACHED_KEY] = true;

  if (cfg.attempts <= 1) {
    return true;
  }

  // Stamped once, before the first attempt, and carried forward on every replay because axios
  // merges string-keyed config through. It lets hub recognise a replay as the same logical
  // invocation and join or reuse the original execution rather than running the module
  // operation twice - which is what makes replaying a mutating call safe rather than merely
  // unlikely to hurt. Reads are skipped: there is nothing to de-duplicate.
  instance.interceptors.request.use((config) => {
    const method = (config.method ?? 'get').toUpperCase();
    if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') {
      return config;
    }
    const headers = config.headers as unknown as Record<string, unknown>;
    if (headers && !headers['idempotency-key']) {
      headers['idempotency-key'] = newIdempotencyKey();
    }
    return config;
  });

  instance.interceptors.response.use(
    async (response) => {
      const failure = classifyResponse(response, cfg);
      if (!failure || !response.config) {
        if (response.config) {
          breaker.recordSuccess(breakerKeyFor(response.config, label));
        }
        return response;
      }
      const retried = await replay(
        instance,
        response.config,
        cfg,
        breaker,
        label,
        failure,
        retryAfterDelay(response, cfg)
      );
      return retried ?? response;
    },
    async (error: AxiosError) => {
      const failure = error.config ? classifyError(error, cfg) : undefined;
      if (!failure || !error.config) {
        throw error;
      }
      const retried = await replay(
        instance,
        error.config,
        cfg,
        breaker,
        label,
        failure,
        retryAfterDelay(error.response, cfg)
      );
      if (retried) {
        return retried;
      }
      throw error;
    }
  );

  return true;
};
