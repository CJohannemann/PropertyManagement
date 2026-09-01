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

echo
echo "All migrations applied."
