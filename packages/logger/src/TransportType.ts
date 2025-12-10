/**
 * Well-known transport types for common logging destinations
 */
export enum TransportType {
  /** CLI transport with ANSI color support */
  CLI = 'cli',
  /** Console transport using console.* methods */
  CONSOLE = 'console',
  /** File-based transport */
  FILE = 'file',
  /** In-memory transport (typically for testing) */
  MEMORY = 'memory',
  /** API/HTTP-based remote transport */
  API = 'api'
}
