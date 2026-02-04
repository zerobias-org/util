# @zerobias-org/util-content-dev-schema

Content development database schema for third-party catalog content development.

This package provides a self-contained PostgreSQL schema dump that includes the core Hydra tables needed for developing and testing catalog content locally.

## Included Schemas

- **hydra** - Core resource and principal tables
- **store** - Resource property extensions
- **catalog** - Content catalog (frameworks, standards, controls, etc.)
- **portal** - Portal configuration and navigation

## Prerequisites

- PostgreSQL 17 with the following extensions available:
  - `uuid-ossp`
  - `btree_gist`
  - `citext`
  - `pgcrypto`

**Start PostgreSQL using docker-compose:**

```bash
docker compose up -d
```

This starts a Supabase PostgreSQL 17 container with:
- Port 5432 exposed
- Data persisted to `~/.docker/volumes/supabase17`

## Installation

```bash
npm install @zerobias-org/util-content-dev-schema
```

## Loading the Schema

Set libpq environment variables for your PostgreSQL connection, or pass a connection URL directly.

**Environment variables:**

```bash
export PGHOST=localhost
export PGPORT=5432
export PGUSER=postgres
export PGPASSWORD=welcome
export PGDATABASE=content_dev
```

**Or use a connection URL:**

```bash
psql "postgresql://postgres:welcome@localhost:5432/content_dev" -f content-schema.sql
```

### Option 1: Create a new database and load

```bash
# Create a fresh database
createdb content_dev

# Load the schema (extensions require superuser or appropriate privileges)
psql -f node_modules/@zerobias-org/util-content-dev-schema/sql/content-schema.sql
```

### Option 2: Using psql with explicit connection

```bash
createdb -h localhost -U postgres content_dev
psql -h localhost -U postgres -d content_dev -f node_modules/@zerobias-org/util-content-dev-schema/sql/content-schema.sql
```

### Option 3: From within psql

```sql
CREATE DATABASE content_dev;
\c content_dev
\i node_modules/@zerobias-org/util-content-dev-schema/sql/content-schema.sql
```

## Verification

After loading, verify the schema is working:

```sql
-- Check schemas exist
SELECT schema_name FROM information_schema.schemata
WHERE schema_name IN ('hydra', 'store', 'catalog', 'portal');

-- Check core tables
SELECT count(*) FROM hydra.resource;
SELECT count(*) FROM catalog.framework;
```
