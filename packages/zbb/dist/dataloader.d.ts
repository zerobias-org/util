/**
 * zbb dataloader — wraps platform dataloader CLI with slot PG env injection
 *
 * Usage:
 *   zbb dataloader [args...]         → run dataloader with slot PG env vars injected
 *   zbb dataloader -d .              → process current directory
 *   zbb dataloader -d /path/to/pkg   → process specific package directory
 *
 * Reads PG connection from active zbb slot (ZB_SLOT env var) and injects:
 *   PGHOST, PGPORT, PGUSER, PGPASSWORD, PGDATABASE
 */
export declare function handleDataloader(args: string[]): Promise<void>;
