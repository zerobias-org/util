# pr-review — Progress

Working notes for the agentic PR-review tool. See `README.md` for the
product overview and roadmap; this file tracks build status.

- **Repo / branch:** `zerobias-org/util` → `feat/pr-review-agent`
- **Status:** Phase 2a + 1.5. Cross-repo knowledge (zb-knowledge MCP) is
  **runtime-verified** — `--provider anthropic` ran end to end against the UAT
  knowledge endpoint and produced a high-quality review (caught a version-bump
  convention violation). Phase 1.5 (post reviews as PR comments) is built and
  build-verified (`tsc -b` + eslint clean) but **not yet runtime-tested against
  a real PR**. Nothing committed yet.

---

## Done

### Phase 0 — package skeleton

- `package.json`, `tsconfig.json`, `.gitignore`, `bin/pr-review.mjs`
- `lib/cli.ts`, `lib/mode.ts`, `lib/types.ts`
- `README.md`, `CLAUDE.md`
- Auto-registers as a `util` workspace package (`packages/*`).

### Phase 1a — pluggable model layer

- `lib/config.ts` — `ModelConfig` + resolution (flags > env > defaults).
- `lib/agent/providers/types.ts` — `ModelProvider` interface.
- `lib/agent/providers/anthropic.ts` — Claude via `@anthropic-ai/sdk`;
  static context sent as a cached system block; streaming + adaptive
  thinking + `effort`.
- `lib/agent/providers/openai-compat.ts` — any OpenAI-compatible `/v1`
  endpoint; covers qwen3-coder via Ollama / vLLM. Native `fetch`, no SDK.
- `lib/agent/providers/factory.ts` — `createProvider(config)`.
- Added `@anthropic-ai/sdk` (`^0.88.0` floor) to `package.json`.

### Phase 1b — the review pipeline

- `lib/git.ts` — local git helpers (diff name-status, patch, file-at-HEAD).
- `lib/diff/identifier.ts` — stage 1: changed files, OpenAPI/schema files
  flagged as contracts.
- `lib/context/gatherer.ts` — stage 2: changed-file contents + repo docs
  (`CLAUDE.md` / `README.md`).
- `lib/agent/prompts.ts` — stage 3: system prompt + request builder.
- `lib/agent/reviewer.ts` — stage 3: calls the provider, tolerant JSON parse
  into `ReviewResult`. `sanitizeJson` repairs small-model malformations
  (uppercase / Python literals, trailing commas); raw output is surfaced on
  a parse failure. *(`sanitizeJson` was added after smoke testing — see
  below.)*
- `lib/render.ts` — terminal rendering of a review.
- `lib/cli.ts` — wires `diff → context → agent → render`.
- `lib/types.ts` / `lib/config.ts` — pipeline + review-config types.

### Phase 2a — cross-repo knowledge (zb-knowledge MCP)

Gives the reviewer context from *every* indexed repo in the org, not just the
repo under review. Two halves, both driven from `reviewer.ts`:

- **Seed** — one deterministic query run up front. For each changed file the
  reviewer calls `get_affected_files` (scoped to the repo's `origin` slug) and
  injects the combined "who depends on this?" impact into the prompt as static,
  cacheable context. The model starts knowing the blast radius.
- **Loop** — the model drives. The Anthropic provider runs an agentic tool-use
  loop: it offers the curated zb-knowledge tools (`search_code`, `get_file`,
  `get_affected_files`, `get_dependency_chain`, `check_package_versions`),
  executes each `tool_use` via a `ToolRunner`, feeds results back, and repeats
  until the model stops or the `maxToolCalls` budget is spent (then tools are
  withheld so it must finalize).

Pieces:
- `lib/knowledge/zb-mcp.ts` — `ZbKnowledgeClient` (stdio or streamable-HTTP via
  `@modelcontextprotocol/sdk`) + `createToolRunner`. Only place that speaks MCP.
  The http transport forwards auth headers (`requestInit.headers`); tool results
  are clamped to a per-result char budget. Errors come back as text, never
  thrown, so a failed lookup can't crash the review.
- `lib/knowledge/factory.ts` — `openKnowledgeClient`; returns `undefined` (with
  a warning) when disabled or unreachable, so reviews degrade gracefully.
- `lib/git.ts` — `remoteSlug()` parses `origin` into `{org, repo}` for the seed.
- `lib/agent/providers/types.ts` — `ToolSpec` + `ToolRunner` contracts; the
  `ModelProvider.review()` signature now takes optional `tools` + `runTool`.
- `lib/agent/providers/anthropic.ts` — the tool-use loop (preserves the cached
  system block; pushes back full assistant turns incl. thinking blocks).
- `lib/agent/prompts.ts` — `TOOLS_CLAUSE` + a "Cross-repo impact" context
  section, both conditional on the knowledge layer being active.
- `lib/config.ts` — `KnowledgeConfig` (`PR_REVIEW_KNOWLEDGE*` env) +
  `anthropic.maxToolCalls` (`PR_REVIEW_MAX_TOOL_CALLS`).
- Added `@modelcontextprotocol/sdk` (`^1.29.0`) to the package.

**Design note — seed benefits both providers; the loop only Anthropic.** The
seed is plain prompt context, so the local (OpenAI-compatible) provider still
gets cross-repo impact. The local provider ignores `tools` (tool-use on local
OSS models is deferred), so it just doesn't run the loop.

### Phase 1.5 — post reviews as PR comments

The output sink is now the pluggable *edge* (the diff → context → agent core is
unchanged): ci posts to the PR, local prints.

- `lib/sink/types.ts` — `ReviewSink` interface (`publish(result)`).
- `lib/sink/terminal.ts` — `TerminalSink`; wraps `renderReview` (local default).
- `lib/sink/github.ts` — `GitHubSink`; posts a single markdown summary comment,
  **upserted** via a hidden `<!-- pr-review -->` marker so re-runs update the
  same comment instead of spamming. Native `fetch` to the GitHub REST API.
- `lib/sink/markdown.ts` — markdown rendering + the marker.
- `lib/github.ts` — `resolvePrContext()`: owner/repo/PR-number/token from the
  Actions env + event payload, or `--pr` + `remoteSlug()` + `gh auth token`
  locally. Returns undefined → graceful fall back to terminal.
- `lib/sink/factory.ts` — `createSink`; ci or `--post` → GitHub, else terminal.
- `lib/cli.ts` — `--post` flag; routes the result through the sink.
- `ci/ai-review.reusable.yml` + `ci/ai-review.caller.yml` — the reusable
  GitHub Actions workflow (installs the package, runs it; ci mode auto-posts)
  plus a caller template. Templates only — deploy the reusable one to a central
  repo (devops) and the caller into consuming repos' `.github/workflows/`.

Inline line-anchored comments are deliberately **not** done — they need
accurate line numbers (Phase 2c AST work); GitHub 422s on lines outside the
diff. The summary comment sidesteps that.

---

## Verified

- **Build** — `npm install` at the `util` root (with `ZB_TOKEN`) +
  `npm run build --workspace=packages/pr-review` (`tsc -b`) compiles clean;
  `dist/` is produced.
- **Smoke test** — ran `pr-review review --provider local` against a scratch
  repo with three planted bugs, using Ollama `llama3.2`. The full pipeline
  ran end to end: mode detection → diff → context → OpenAI-compatible
  provider → Ollama → JSON parse → render.
- **Found by testing:** `llama3.2` emitted `"line": NULL` (invalid JSON) —
  fixed by adding `sanitizeJson`.
- **Model-quality note:** `llama3.2` (3B, general-purpose) caught 2 of 3
  planted bugs with imprecise reasoning and one false positive. The pipeline
  is sound; review quality needs a coding model (qwen-coder) or Claude.

### Build & run

```
# build (needs ZB_TOKEN for the util workspace install)
cd util && npm install
npm run build --workspace=packages/pr-review

# run locally against Ollama
cd <a git repo with a feature branch>
PR_REVIEW_LOCAL_MODEL=qwen2.5-coder:7b \
  node <util>/packages/pr-review/bin/pr-review.mjs review --provider local
```

---

## Key decisions

- **One CLI, two launchers.** The tool auto-detects `ci` vs `local` from
  `GITHUB_ACTIONS` (one check, in `mode.ts`). CI runs it via a reusable
  workflow; local can run it directly or via a `zbb review` verb.
- **Pluggable model layer.** The reviewer depends only on `ModelProvider`.
  Local OSS models (qwen3-coder) are reached through the OpenAI-compatible
  provider — every local serving stack (Ollama, vLLM) speaks that API.
- **Built like `zbb`, not via `zbb`.** A pure-TS workspace package; built
  with plain `npm`/`tsc`, the same as the sibling `zbb` package. Not wired
  into the Gradle monorepo build.
- **Distribution = npm.** Published as `@zerobias-org/pr-review`; consuming
  repos `npm i -g` it. The `zbb` verb is an optional local convenience, not
  the distribution mechanism.
- **Review asks for coverage, not self-filtering** — every finding carries a
  severity + confidence; ranking is a downstream (Phase 3) concern.

---

## Caveats

- **zb-knowledge MCP loop not yet runtime-tested.** Compiles clean against
  `@modelcontextprotocol/sdk` 1.29.0, but no live server run yet. The real
  server is an authenticated HTTP MCP endpoint
  (`https://api.uat.zerobias.com/knowledge-mcp/mcp`, UAT) requiring
  `dana-org-id` + `Authorization: ApiKey` headers — supplied via
  `PR_REVIEW_KNOWLEDGE_HEADERS` (JSON, from a secret store; never committed).
  Still need an end-to-end check that the seed query and tool-use loop behave.
  CI has no knowledge server wired yet → it degrades to a repo-local review
  (by design).
- **Anthropic provider runtime-verified** end to end against UAT knowledge
  (local/Ollama path was already smoke-tested earlier).
- **GitHub PR posting runtime-verified** — posted a review comment to
  `zerobias-org/vendor#29` via local `--post`. The marker-based upsert (update
  vs. duplicate on re-run) is the one bit still unconfirmed. The reusable
  workflow is still a template — not yet deployed to devops or wired into any
  repo.
- **Local posting auth gotcha:** the `gh` CLI OAuth token is blocked by
  zerobias-org's SAML / third-party-OAuth-app policy (403 even via `gh api`).
  A **classic PAT** with `repo` scope, SSO-authorized for zerobias-org, set as
  `GITHUB_TOKEN`, works. CI's Actions `GITHUB_TOKEN` is unaffected.
- **`@anthropic-ai/sdk`** is pinned at a `^0.88.0` floor — fine (build
  passed), but can be bumped to the true latest.
- **Line numbers are imprecise.** The diff identifier is file-level, so the
  model guesses line numbers from file content. AST-based line anchoring is
  a later enhancement.

---

## Not done yet

- **Phase 1.5 (remaining)** — PR-comment posting is built (summary comment,
  upserted) and the reusable workflow is scaffolded in `ci/`. Still open:
  runtime-test against a real PR; deploy `ci/ai-review.reusable.yml` to the
  central/devops repo and add the caller to consuming repos; later, inline
  line-anchored comments (after AST line numbers).
- **Phase 2 (remaining)** — context retrieval now consumes the *existing*
  zb-knowledge index live over MCP (Phase 2a, above), so no index is built
  here. Still open: `pr-review index` is a stub (rebuilding the KB is owned by
  zb-knowledge, TBD whether pr-review drives it); runtime-verify the loop
  against a live server; tool-use on the local OpenAI-compatible provider.
- **Phase 3** — scoring + narrow, CI-only auto-approve; `.pr-review.yml`
  policy file.
- AST-level method/API extraction in the diff identifier (currently
  file-level + contract-path detection). Unlocks symbol-scoped seed/loop
  queries via the `symbol` param on `get_affected_files` /
  `get_dependency_chain`.
