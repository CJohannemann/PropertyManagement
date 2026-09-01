#!/usr/bin/env bash
#
# supabase/postgres only sets a password for its own "supabase_admin"
# superuser automatically (POSTGRES_PASSWORD) — the three roles GoTrue and
# PostgREST actually connect as (authenticator, supabase_auth_admin,
# supabase_storage_admin) are created with none. The official self-hosting
# stack fixes this by mounting a /etc/postgresql.schema.sql file into the
# container; simpler here to just run it directly, once, right after `db`
# first comes up. Run this before starting auth/rest — GoTrue crash-loops
# on "password authentication failed" without it.
#
#   bash deploy/selfhost/set-role-passwords.sh

set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
[ -f .env ] && . .env

# supabase_admin is the real superuser here — "postgres" is deliberately
# demoted by the image's own setup, and can't alter these reserved roles.
docker compose exec -T -e PGPASSWORD="$POSTGRES_PASSWORD" db \
  psql -U supabase_admin -d postgres -c "
    ALTER USER authenticator WITH PASSWORD '$POSTGRES_PASSWORD';
    ALTER USER supabase_auth_admin WITH PASSWORD '$POSTGRES_PASSWORD';
    ALTER USER supabase_storage_admin WITH PASSWORD '$POSTGRES_PASSWORD';
  "

echo "Role passwords set."
