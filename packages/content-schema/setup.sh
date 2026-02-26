#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Database connection — override via .envrc or env vars, otherwise defaults apply.
export PGHOST="${PGHOST:-localhost}"
export PGPORT="${PGPORT:-15432}"
export PGUSER="${PGUSER:-postgres}"
export PGPASSWORD="${PGPASSWORD:-welcome}"
export PGDATABASE="${PGDATABASE:-content_dev}"
export DB_URL="postgres://$PGUSER:$PGPASSWORD@$PGHOST:$PGPORT/$PGDATABASE"

# --- helpers ---
info()  { echo "==> $*"; }
ok()    { echo "  ✓ $*"; }
fail()  { echo "  ✗ $*" >&2; exit 1; }

check_command() {
  command -v "$1" >/dev/null 2>&1 || fail "$1 is required but not installed."
}

# --- preflight ---
info "Checking prerequisites"
check_command docker
check_command psql
check_command node
check_command npm

NODE_MAJOR=$(node -v | sed 's/v//' | cut -d. -f1)
[[ "$NODE_MAJOR" -ge 22 ]] || fail "Node.js >= 22 required (found $(node -v))"

docker info >/dev/null 2>&1 || fail "Docker daemon is not running. Start Docker and try again."

[[ -n "${ZB_TOKEN:-}" ]] || fail "ZB_TOKEN is not set. Get your token from app.zerobias.com > Settings > API Keys, then: export ZB_TOKEN=\"your-token\""

[[ -f "$SCRIPT_DIR/sql/content-schema.sql" ]] || fail "Schema file not found at $SCRIPT_DIR/sql/content-schema.sql"
[[ -f "$SCRIPT_DIR/docker-compose.yml" ]] || fail "docker-compose.yml not found at $SCRIPT_DIR/"

# Check port is available
if lsof -i :"$PGPORT" >/dev/null 2>&1; then
  fail "Port $PGPORT is already in use. Stop the existing service or set PGPORT to a different value."
fi

ok "Prerequisites satisfied"

# --- docker ---
info "Starting PostgreSQL on port $PGPORT"
cd "$SCRIPT_DIR"
docker compose up -d --wait
ok "PostgreSQL is ready"

# --- database ---
info "Creating database '$PGDATABASE'"
psql -d postgres -tc "SELECT 1 FROM pg_database WHERE datname = '$PGDATABASE'" | grep -q 1 \
  && dropdb "$PGDATABASE" 2>/dev/null || true
createdb "$PGDATABASE"
ok "Database created (clean)"

# --- schema ---
info "Loading schema"
psql -d "$PGDATABASE" -f "$SCRIPT_DIR/sql/content-schema.sql" -q 2>&1 \
  | grep -i "error" | grep -iv "already exists" | grep -iv "does not exist" || true
ok "Schema loaded"

# --- RLS role ---
SYSTEM_PRINCIPAL="00000000-0000-0000-0000-000000000000"
info "Creating RLS role"
psql -d "$PGDATABASE" -q <<SQL
DO \$\$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '$SYSTEM_PRINCIPAL') THEN
    EXECUTE format('CREATE ROLE %I LOGIN', '$SYSTEM_PRINCIPAL');
  END IF;
END
\$\$;
GRANT "$SYSTEM_PRINCIPAL" TO postgres;
GRANT ALL ON SCHEMA hydra, catalog, store, portal TO "$SYSTEM_PRINCIPAL";
GRANT ALL ON ALL TABLES IN SCHEMA hydra, catalog, store, portal TO "$SYSTEM_PRINCIPAL";
GRANT ALL ON ALL SEQUENCES IN SCHEMA hydra, catalog, store, portal TO "$SYSTEM_PRINCIPAL";
ALTER DEFAULT PRIVILEGES IN SCHEMA hydra, catalog, store, portal
  GRANT ALL ON TABLES TO "$SYSTEM_PRINCIPAL";
SQL
ok "RLS role ready"

# --- verify ---
info "Verifying"
SCHEMA_COUNT=$(psql -d "$PGDATABASE" -Atc "
  SELECT count(*) FROM information_schema.schemata
  WHERE schema_name IN ('hydra', 'store', 'catalog', 'portal');
")
[[ "$SCHEMA_COUNT" -eq 4 ]] || fail "Expected 4 schemas, found $SCHEMA_COUNT"

TABLE_COUNT=$(psql -d "$PGDATABASE" -Atc "
  SELECT count(*) FROM information_schema.tables
  WHERE table_schema IN ('hydra', 'store', 'catalog', 'portal')
  AND table_type = 'BASE TABLE';
")
ok "4 schemas, $TABLE_COUNT tables"

# --- dataloader ---
info "Installing dataloader"
if npx dataloader -v >/dev/null 2>&1; then
  ok "Dataloader already installed ($(npx dataloader -v 2>&1 | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1))"
else
  npm install -g @zerobias-com/platform-dataloader@latest
  ok "Dataloader installed"
fi

# --- done ---
echo ""
echo "Ready. Load content with:"
echo "  npx dataloader @zerobias-org/framework-nist-csf-v2"
echo ""
echo "Other examples:"
echo "  npx dataloader -t @zerobias-org/framework-nist-csf-v2   # dry run"
echo "  npx dataloader -d ./my-local-package                    # local dir"
echo "  npx dataloader -l packages                              # list installed"
