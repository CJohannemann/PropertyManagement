#!/usr/bin/env bash
#
# Fills in the frontend's .env from the backend's, instead of copying the
# anon key between two files by hand. Creates .env from .env.example first
# if it doesn't exist, then pulls ANON_KEY out of deploy/selfhost/.env and
# writes it in as VITE_SUPABASE_ANON_KEY.
#
# Only useful on the VPS, where both halves live on one box. Safe to run
# more than once — an already-filled value is left alone.
#
#   bash deploy/link-env.sh

set -euo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO"

BACKEND_ENV="deploy/selfhost/.env"
if [ ! -f "$BACKEND_ENV" ]; then
  echo "No $BACKEND_ENV — run deploy/selfhost/generate-secrets.sh first." >&2
  exit 1
fi

[ -f .env ] || cp .env.example .env

if grep -q '^VITE_SUPABASE_ANON_KEY=..*' .env; then
  echo "VITE_SUPABASE_ANON_KEY already set in .env — leaving it alone."
else
  anon="$(grep '^ANON_KEY=' "$BACKEND_ENV" | cut -d= -f2-)"
  if [ -z "$anon" ]; then
    echo "ANON_KEY is empty in $BACKEND_ENV — run generate-secrets.sh first." >&2
    exit 1
  fi
  # | as the sed delimiter, not / — a JWT is base64url and can contain /.
  sed -i "s|^VITE_SUPABASE_ANON_KEY=.*|VITE_SUPABASE_ANON_KEY=${anon}|" .env
  echo "VITE_SUPABASE_ANON_KEY set from $BACKEND_ENV."
fi

echo
echo "Frontend .env ready:"
grep '^VITE_' .env | sed 's|\(VITE_SUPABASE_ANON_KEY=.\{16\}\).*|\1…|'
