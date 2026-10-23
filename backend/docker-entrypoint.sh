#!/bin/sh
set -eu

migration_url="${MIGRATION_DATABASE_URL:-$DATABASE_URL}"
DATABASE_URL="$migration_url" node src/db/migrate.ts
DATABASE_URL="$migration_url" node src/db/seed.ts

exec node src/main.ts
