#!/bin/sh
set -eu

node src/db/migrate.ts
node src/db/seed.ts

exec node src/main.ts
