#!/usr/bin/env bash
#
# Builds and publishes the frontend on the VPS: pull, install, build.
# nginx serves dist/ directly (see nginx-property-management.conf), so
# there's no copy step and no service to restart — the new files are live
# the moment the build finishes.
#
#   bash deploy/deploy.sh
#
# This does NOT touch the backend. A commit that adds a db/migrations/ file
# needs deploy/selfhost/apply-migrations.sh as well.

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

step "pulling"
git pull

step "installing dependencies"
# npm ci over npm install: reproducible, and it won't quietly rewrite
# package-lock.json on the server.
npm ci

step "building"
npm run build

step "done"
echo "Built to $REPO/dist — nginx serves it directly, so it's already live."
