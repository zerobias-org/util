# CLAUDE.md — @zerobias-org/pr-review

Agentic PR review CLI. See `README.md` for the roadmap and execution modes.

## Layout

```
bin/pr-review.mjs   thin ESM entry -> dist/cli.js
lib/
  cli.ts            command router (review | index)
  mode.ts           ci-vs-local detection — the ONLY place that reads GITHUB_ACTIONS
  types.ts          shared pipeline types
```

Later phases add `lib/diff/`, `lib/context/`, `lib/agent/`, `lib/indexer/` —
the three pipeline stages plus the knowledge-base indexer.

## Conventions

- TypeScript, ESM (`"type": "module"`), compiled with `tsc` to `dist/`.
- Mirrors the sibling package `@zerobias-org/zbb`: `lib/` source, `dist/`
  output, thin `bin/` shim.
- No `as any`. Run `npm run build` (tsc) before committing.
- Mode is detected once in `mode.ts`. Never branch on
  `process.env.GITHUB_ACTIONS` anywhere else — thread `ReviewConfig.mode`
  through instead.
- Keep the core pipeline (diff -> context -> agent) environment-agnostic;
  only the input source and output sink differ between `ci` and `local`.

## Build

```
npm run build      # tsc -b
npm run test
```

Building requires the `util` workspace dependencies (`@types/node`, etc.),
installed from the private registry — needs a registry token.
