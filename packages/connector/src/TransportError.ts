/**
 * Telling a transport blip apart from an answer the server actually gave.
 *
 * HubConnector normalizes every failure into a CoreError so that circular
 * ClientRequest/IncomingMessage references never reach anything serialized. `CoreError.from()`
 * flattens a raw system error into `err.unexpected` and discards its `code` in the process,
 * which left callers string-matching the message to tell a dropped socket from a module's own
 * 500. This module re-attaches that signal and exposes a predicate to read it.
 *
 * `@zerobias-org/types-core-js` has no transport/transient/network error type - the nearest
 * neighbours are NotConnectedError (statusCode 400, no payload) and TimeoutError (requires a
 * Duration) - and registering a new error key would produce errors that every other service's
 * `CoreError.deserialize` fails to recognise. Hence a marker on the existing error rather than
 * a new class.
 */

// Nothing came back off the wire. Codes are matched on the error and its `cause` chain because
// axios 1.x nests the original system error.
const TRANSIENT_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ECONNABORTED',
  'EPIPE',
  'ETIMEDOUT',
  'ESOCKETTIMEDOUT',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENETDOWN',
  'EAI_AGAIN',
  'ERR_NETWORK',
  'ERR_SOCKET_CONNECTION_TIMEOUT',
]);

// Matched only when the error carries no HTTP response. Deliberately narrow: a loose pattern
// (a bare `aborted` or `network error`) would tag ordinary module failures as infrastructure
// blips and replay them.
const TRANSIENT_MESSAGE = new RegExp([
  'socket hang up',
  'ECONNRESET',
  'ECONNREFUSED',
  'EPIPE',
  'ETIMEDOUT',
  'EAI_AGAIN',
  'Client network socket disconnected',
  'socket disconnected before secure TLS connection',
  'timeout of \\d+ms exceeded',
  // No bare 'aborted' or 'network error': both appear inside ordinary application messages
  // ("request aborted by policy", "network error rate exceeded quota"). The ECONNABORTED code
  // above already covers a real axios abort.
].join('|'), 'i');

/** Walks the `cause` chain, which is where axios 1.x nests the original system error. */
const walk = (error: unknown, visit: (node: any) => boolean): boolean => {
  const seen = new Set<unknown>();
  let current: any = error;
  while (current && typeof current === 'object' && !seen.has(current)) {
    seen.add(current);
    if (visit(current)) {
      return true;
    }
    current = current.cause ?? (Array.isArray(current.errors) ? current.errors[0] : undefined);
  }
  return false;
};

/** The system error code behind a failure, if it is one we recognise as transport-level. */
export const transportCodeOf = (error: unknown): string | undefined => {
  let found: string | undefined;
  walk(error, (node) => {
    const code = typeof node.code === 'string' ? node.code.toUpperCase() : undefined;
    if (code && TRANSIENT_CODES.has(code)) {
      found = code;
      return true;
    }
    return false;
  });
  return found;
};

/**
 * True when the failure is a transport-level blip rather than an answer from the server.
 * Falls back to message matching for errors rethrown as a different class, which drops `code`,
 * `config` and `response`.
 */
export const isTransportError = (error: unknown): boolean => {
  if (transportCodeOf(error)) {
    return true;
  }
  return walk(error, (node) => !node.response
    && typeof node.message === 'string'
    && TRANSIENT_MESSAGE.test(node.message));
};

/** Property name carrying the boolean transport marker on a normalized error. */
const TRANSIENT_FLAG = 'transient';

/**
 * Re-attaches the transport signal to an error that has been normalized into a CoreError.
 *
 * Both properties are primitives and non-enumerable: nothing circular becomes reachable from
 * the error, and the marker cannot leak into `{...error}` spreads or log serializers that walk
 * own enumerable keys. `CoreError.toJSON()` reads its internal model, so serialization is
 * unchanged - this signal is deliberately in-process only and does not survive an HTTP hop.
 *
 * `code` deliberately follows Node's system-error convention so predicates that already walk
 * `.code` - including hub-client's existing isTransientError - recognise it without knowing
 * anything about this package.
 */
export const markTransportFailure = <T extends Error>(error: T, code?: string): T => {
  const define = (prop: string, value: unknown): void => {
    Object.defineProperty(error, prop, {
      value, enumerable: false, configurable: true, writable: true,
    });
  };
  define(TRANSIENT_FLAG, true);
  if (code) {
    define('code', code);
  }
  return error;
};

/**
 * True when a failure was a transport blip rather than an answer from the server.
 *
 * Prefer this over matching on message text. Works both on a raw axios error and on the
 * CoreError HubConnector rejects with, because the marker survives that conversion.
 */
export const isTransportFailure = (error: unknown): boolean => {
  if (error && typeof error === 'object' && (error as any)[TRANSIENT_FLAG] === true) {
    return true;
  }
  return isTransportError(error);
};
