#!/usr/bin/env bash
#
# Applies every file in db/migrations/, in order, to the self-hosted
# Postgres — without touching schema.sql or seed.sql. Those two are for a
# brand-new database only (see apply-schema.sh); every migration, in
# contrast, is written to be safe to run again, including ones already
# applied. Use this one after pulling a new migration onto an existing
# install.
#
#   bash deploy/selfhost/apply-migrations.sh

set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
REPO="$(cd ../.. && pwd)"

shopt -s nullglob
files=("$REPO"/db/migrations/*.sql)
if [ ${#files[@]} -eq 0 ]; then
  echo "No migrations to apply."
  exit 0
fi

for f in "${files[@]}"; do
  echo "=== migration: $(basename "$f") ==="
  docker compose exec -T db psql -U postgres -d postgres -v ON_ERROR_STOP=1 < "$f"
done

# PostgREST caches the database schema at startup and does not notice a new
# function or column on its own. Without this, a migration adds
# rent_summary(), the migration reports success, and the app still gets
# "Could not find the function in the schema cache" — which looks like the
# migration silently failed when in fact it worked perfectly.
#
# NOTIFY is the zero-downtime way and works when db-channel is enabled
# (it is, by default). The restart is the belt-and-braces follow-up: this
# is a manual maintenance step, and a second of API downtime is a fair
# price for not having to debug a stale cache later.
echo
echo "=== reloading PostgREST's schema cache ==="
docker compose exec -T db psql -U postgres -d postgres -c "notify pgrst, 'reload schema';" >/dev/null
docker compose restart rest

echo
echo "All migrations applied."
