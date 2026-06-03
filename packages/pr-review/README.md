# @zerobias-org/pr-review

Agentic pull-request review for ZeroBias repositories. A single CLI —
`pr-review` — that analyses a diff, gathers repository context, and produces
an AI-assisted review.

## Status

**Phase 2a — cross-repo knowledge.** The full pipeline runs: diff → context →
agent → review. The reviewer pulls org-wide context from the zb-knowledge MCP
server — a deterministic affected-files *seed* up front, plus a model-driven
tool-use *loop* (Anthropic) for deeper lookups. Findings print to the terminal
in both modes; posting them as PR comments is still ahead. See the roadmap.

## Commands

```
pr-review review [--base <ref>] [--pr <number>]   Run the review pipeline
pr-review index                                   Rebuild the knowledge-base index
pr-review --help                                  Usage
```

## Execution modes

The CLI auto-detects where it runs and adapts the *edges* of the pipeline.
The core diff -> context -> agent logic is identical in both modes.

| Mode    | Detected by           | Diff source      | Output                  |
|---------|-----------------------|------------------|-------------------------|
| `ci`    | `GITHUB_ACTIONS=true` | local `git diff` | PR comment (upserted)   |
| `local` | anything else         | local `git diff` | the terminal            |

In `ci` mode (or with `--post`) the review is posted as a single PR comment,
re-using the same comment on subsequent runs via a hidden marker. Posting needs
`pull-requests: write` and a token (`GITHUB_TOKEN` in CI; `gh auth` or
`GITHUB_TOKEN`/`GH_TOKEN` locally). If the PR context can't be resolved it
falls back to printing.

## Roadmap

- **Phase 0** — package skeleton, mode detection, diff listing. *(done)*
- **Phase 1** — diff identifier + review agent; context is the diff + changed
  files + the repo's own docs. Advisory comments, no auto-approve. *(done)*
- **Phase 2a** — cross-repo context from the zb-knowledge MCP server: an
  affected-files seed + a tool-use loop. *(current)*
- **Phase 1.5 / 2 (remaining)** — post findings as GitHub PR comments; verify
  the knowledge loop against a live server; tool-use on the local provider.
- **Phase 3** — scoring and narrow, CI-only auto-approve.

### Cross-repo knowledge config

Set when a zb-knowledge MCP server is reachable; reviews degrade gracefully to
repo-local when it is not.

```
PR_REVIEW_KNOWLEDGE            on | off        (default: on when an endpoint is set)
PR_REVIEW_KNOWLEDGE_ENDPOINT  <stdio cmd | http url>
PR_REVIEW_KNOWLEDGE_TRANSPORT stdio | http     (default: inferred from endpoint)
PR_REVIEW_KNOWLEDGE_HEADERS   <JSON object>    (http auth headers — keep secret)
PR_REVIEW_MAX_TOOL_CALLS      <n>              (default: 15)
```

The zb-knowledge server is an authenticated HTTP MCP endpoint, so it needs auth
headers. Source `PR_REVIEW_KNOWLEDGE_HEADERS` from a secret store (CI:
vault-action; local: shell / `zbb`) — **never commit the API key**:

```bash
export PR_REVIEW_KNOWLEDGE_ENDPOINT="https://api.uat.zerobias.com/knowledge-mcp/mcp"
export PR_REVIEW_KNOWLEDGE_HEADERS='{"dana-org-id":"<org-id>","Authorization":"ApiKey <key>"}'
```

## Invocation

- **CI** — a reusable workflow installs the package and runs `pr-review review`.
  Templates live in [`ci/`](ci/): deploy `ai-review.reusable.yml` to a central
  repo (e.g. devops) and drop `ai-review.caller.yml` into each consuming repo's
  `.github/workflows/`.
- **Local** — run `pr-review review` directly, or via the `zbb review`
  lifecycle verb (which resolves `ANTHROPIC_API_KEY` from Vault). Add `--post`
  to post to a PR from local (needs `gh auth` and `--pr <n>`).

## Build

```
npm run build      # tsc -b -> dist/
npm run test
```

This is a workspace package of [`@zerobias-org/util`](../../). Building needs
the workspace dependencies, installed from the private registry — see the
meta-repo `docs/RegistrySetup.md`.
