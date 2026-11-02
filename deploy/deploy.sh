#!/usr/bin/env bash
#
# Deploys on the VPS: pull, migrate the database if needed, install, build.
# nginx serves dist/ directly (see nginx-property-management.conf), so
# there's no copy step and no service to restart — the new files are live
# the moment the build finishes.
#
#   bash deploy/deploy.sh
#   SKIP_MIGRATIONS=1 bash deploy/deploy.sh     # frontend only
#
# Migrations run when db/migrations/ changed since the last successful
# migration (or when there is no record of one — every migration is safe to
# re-run). Before them, the database is backed up (selfhost/backup-db.sh);
# each migration file runs in its own transaction, so a failure leaves that
# file entirely unapplied; and the frontend is only rebuilt once they have
# succeeded, so a new screen never goes live against a database that lacks
# the tables it reads.
#
# A failed migration stops the deploy and is recorded in
# .deploy-state/blocked, so auto-deploy.sh stops retrying that commit every
# two minutes. Pushing a fix (any newer commit) clears it.

set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO"

step() { printf '\n=== %s ===\n' "$1"; }

step "checking for a .env"
if [ ! -f .env ]; then
  cat <<'WARN' >&2
STOP. No .env in the repo root.

The build bakes VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY into the
static files, so without one the deployed site can't reach the backend at
all — it renders a "Backend not configured" message and nothing else.

  cp .env.example .env
  nano .env

VITE_SUPABASE_ANON_KEY is the ANON_KEY value from
deploy/selfhost/.env. Never put SERVICE_ROLE_KEY in this file — it ships
to every browser that loads the page.
WARN
  exit 1
fi

if ! grep -q '^VITE_SUPABASE_ANON_KEY=..*' .env; then
  echo "VITE_SUPABASE_ANON_KEY is empty in .env — fill it in first." >&2
  exit 1
fi

STATE="$REPO/.deploy-state"
mkdir -p "$STATE"

step "pulling"
git pull
head="$(git rev-parse HEAD)"

step "database migrations"
last_migrated="$(cat "$STATE/last-migrated" 2>/dev/null || true)"
need_migrations=""
if [ "${SKIP_MIGRATIONS:-}" = "1" ]; then
  echo "SKIP_MIGRATIONS=1 — leaving the database alone."
elif [ -z "$last_migrated" ] || ! git cat-file -e "${last_migrated}^{commit}" 2>/dev/null; then
  echo "No record of a previous migration run — applying all of them (each is safe to re-run)."
  need_migrations=1
elif [ -n "$(git diff --name-only "$last_migrated" "$head" -- db/migrations/)" ]; then
  echo "Migrations changed since ${last_migrated:0:7}:"
  git diff --name-only "$last_migrated" "$head" -- db/migrations/ | sed 's/^/  /'
  need_migrations=1
else
  echo "No new migrations."
fi

if [ -n "$need_migrations" ]; then
  bash deploy/selfhost/backup-db.sh
  if ! bash deploy/selfhost/apply-migrations.sh; then
    echo "$head" > "$STATE/blocked"
    cat <<FAIL >&2

============================================================
DEPLOY STOPPED: a database migration failed at ${head:0:7}.

The failing migration file was rolled back, and the site is still serving
the previous build. Earlier files in the run may have applied (each is its
own transaction, and all are safe to re-run). A backup from just before
this run is in ${PM_BACKUP_DIR:-$HOME/property-management-backups}.

Auto-deploy will not retry this commit. Push a fix, or after fixing the
database by hand run:
  cd $REPO && rm .deploy-state/blocked && bash deploy/deploy.sh
============================================================
FAIL
    exit 1
  fi
  echo "$head" > "$STATE/last-migrated"
  rm -f "$STATE/blocked"
fi

step "installing dependencies"
# npm ci over npm install: reproducible, and it won't quietly rewrite
# package-lock.json on the server.
npm ci

step "building"
npm run build

echo "$head" > "$STATE/last-deployed"

step "done"
echo "Built to $REPO/dist — nginx serves it directly, so it's already live."
