#!/usr/bin/env bash
#
# Applies PropertyManagement's schema (schema.sql, seed.sql, then every
# migration in order) to the self-hosted Postgres. For a BRAND-NEW database
# only, once, after `docker compose up -d db auth` — this depends on
# GoTrue having already bootstrapped the auth schema and auth.uid(), which
# schema.sql's row-level security references. See README.md for the full
# order of operations.
#
# Re-running this against a database that already has it fails outright:
# schema.sql is bare `create table`, not `create table if not exists`, and
# seed.sql has no guard against inserting its rows a second time. Added a
# migration since and want it on an existing install? That's
# apply-migrations.sh instead — every migration file, unlike these two, is
# written to be safe to run again.
#
# Runs psql *inside* the db container rather than requiring it installed on
# the host — one less thing to apt install on a space-conscious VPS.
#
#   bash deploy/selfhost/apply-schema.sh

set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
REPO="$(cd ../.. && pwd)"

run() {
  echo "=== $1 ==="
  docker compose exec -T db psql -U postgres -d postgres -v ON_ERROR_STOP=1 < "$2"
}

run "schema" "$REPO/db/schema.sql"
run "seed"   "$REPO/db/seed.sql"
for f in "$REPO"/db/migrations/*.sql; do
  [ -e "$f" ] || continue
  run "migration: $(basename "$f")" "$f"
done

echo
echo "Sanity check — should print a blank/null row, not an error:"
docker compose exec -T db psql -U postgres -d postgres -c "select auth.uid();"
