#!/usr/bin/env node
/**
 * pr-review — thin executable entry point.
 *
 * Mirrors @zerobias-org/zbb's bin/zbb.mjs: the published `bin` is a tiny ESM
 * shim that defers to the compiled CLI in dist/. All logic lives in lib/.
 */
import { main } from '../dist/cli.js';

main(process.argv).catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
