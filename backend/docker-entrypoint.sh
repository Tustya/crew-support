#!/bin/sh
set -eu

node src/db/migrate.ts

seeded=$(node --input-type=module -e 'import { createPool } from "./src/db/pool.ts"; const pool = createPool(process.env.DATABASE_URL ?? ""); const found = await pool.query("SELECT 1 FROM app_users WHERE external_subject = $1", ["dev-specialist"]); await pool.end(); process.stdout.write(found.rowCount ? "yes" : "no");')

if [ "$seeded" = "no" ]; then
  node src/db/seed.ts
fi

exec node src/main.ts
