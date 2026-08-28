# @zerobias-org/dev-stack

The shared **development env stack** for zbb slots. Pure env/config — no
services, no lifecycle. It declares (and exports) the developer
credentials every ZeroBias dev tool needs:

| Var | Purpose |
|-----|---------|
| `ZB_TOKEN` | REGISTRY key — pkg.zerobias.org auth (npm + gate Neon step) |
| `ZB_API_KEY` | ORG key — org-owner API key of the target org/env (MCPs, org publish) |
| `ZB_ORG_ID` | Target org UUID (`.mcp.json` placeholder) |
| `ZB_PLATFORM_URL` | Platform API base of the target environment |
| `KNOWLEDGE_MCP_URL` | Per-env zb-knowledge MCP endpoint |
| `NPM_CONFIG_TAG` | npm dist-tag for org-private rc publishes |

## Why

zbb vars are stack-scoped. Before this stack existed, every content repo
stack (vendor, suite, product, module, …) redeclared the same six vars
and setup scripts seeded identical values into each stack — N copies
that could drift. Now the values live once, on the `dev` stack, and
content stacks inherit them (the same `depends`/`imports`/`exports`
pattern the platform and hub stacks use to inherit from `dana`).

## Consume it from a stack

```yaml
depends:
  dev:
    package: "@zerobias-org/dev-stack@^1.0.0"   # auto-pulled at `zbb stack add`

imports:
  dev:
    optional: true    # unseeded slot → empty vars, never a resolve error
    vars:
      - ZB_TOKEN
      - ZB_API_KEY
      - ZB_ORG_ID
      - ZB_PLATFORM_URL
      - KNOWLEDGE_MCP_URL
      - NPM_CONFIG_TAG
```

## Seed / use

```bash
# one-time per slot (scripts/setup-org-credentials.sh does this for you)
zbb --slot <slot> --stack dev env set ZB_API_KEY <key>

# creds work from ANY directory — no repo checkout needed
zbb --slot <slot> --stack dev exec claude
```

⚠️ A per-stack `env set` override shadows the imported value — keep
credentials on the `dev` stack only, or rotation stops propagating.
