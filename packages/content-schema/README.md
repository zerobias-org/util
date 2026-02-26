# @zerobias-org/util-content-dev-schema

Local database + dataloader for testing ZeroBias content packages (frameworks, standards, products, etc.).

## Prerequisites

- **Node.js** >= 22 / **npm** >= 10
- **Docker** (running)
- **psql** (`brew install libpq && brew link --force libpq` on macOS)
- **ZB_TOKEN** from [app.zerobias.com](https://app.zerobias.com) > Settings > API Keys

## Quick Start

```bash
# 1. Set your token
export ZB_TOKEN="your-token-here"

# 2. Run setup
./setup.sh

# 3. Load content
npx dataloader @zerobias-org/framework-nist-csf-v2
```

Or via npx (no clone needed):

```bash
export ZB_TOKEN="your-token-here"
npx @zerobias-org/util-content-dev-schema
```

### What `setup.sh` Does

1. Validates prerequisites (Node, Docker, psql, ZB_TOKEN, port availability)
2. Starts PostgreSQL 17 via Docker Compose (port 15432)
3. Creates the `content_dev` database
4. Loads the platform schema (hydra, catalog, store, portal — 300+ tables)
5. Creates the RLS role the dataloader needs
6. Installs `@zerobias-com/platform-dataloader`

### Using direnv (optional)

If you use [direnv](https://direnv.net/), edit `.envrc` with your `ZB_TOKEN` and run `direnv allow`. The `.npmrc` and all PG connection vars are set automatically when you enter the directory.

## Loading Content

```bash
# Load a package
npx dataloader @zerobias-org/framework-nist-csf-v2

# Dry run (validate without committing)
npx dataloader -t @zerobias-org/framework-nist-csf-v2

# Load from a local directory
npx dataloader -d ./my-package

# Force reinstall
npx dataloader -f @zerobias-org/framework-nist-csf-v2

# List installed packages
npx dataloader -l packages

# Check for updates
npx dataloader -l updates

# Update a package
npx dataloader -u @zerobias-org/framework-nist-csf-v2
```

## Verify Data

```bash
psql -d content_dev -c "SELECT count(*) FROM catalog.framework_element_new;"
psql -d content_dev -c "SELECT package_code, package_type FROM catalog.package ORDER BY package_code;"
```

## Cleanup

```bash
docker compose down -v   # stop PostgreSQL and delete data
```

## Troubleshooting

The setup script validates everything upfront before making changes. If it fails, you'll see a clear message:

| Error | Cause | Fix |
|-------|-------|-----|
| `ZB_TOKEN is not set` | Token not exported | `export ZB_TOKEN="your-token"` |
| `Docker daemon is not running` | Docker not started | Start Docker Desktop / `dockerd` |
| `Port 15432 is already in use` | Another service on that port | Stop it, or `export PGPORT=25432` |
| `Node.js >= 22 required` | Older Node version | Update Node.js |
| `psql is required but not installed` | Missing PG client | `brew install libpq && brew link --force libpq` |
| `401 Unauthorized` on npm install | Invalid or expired token | Get a new token from app.zerobias.com |
| `404 Not Found` on a package | Wrong package name | `npm view @zerobias-org/framework-nist-csf-v2` |
| `permission denied to set role` | RLS role missing | Re-run `./setup.sh` |
