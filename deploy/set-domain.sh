#!/usr/bin/env bash
#
# Points both halves of the app at a hostname: the backend's APP_URL (which
# GoTrue uses for its external URL, site URL, and email links) and the
# frontend's VITE_SUPABASE_URL (baked into the bundle at build time).
#
# Exists because these live in two separate .env files that must agree —
# and because the previous variables (API_HOST/API_PORT/FRONTEND_DEV_URL)
# were replaced by a single APP_URL when the app moved to one origin, so
# an .env written before that needs converting rather than editing by hand.
#
#   bash deploy/set-domain.sh                                  # default host
#   bash deploy/set-domain.sh properties.farmhandmanager.com   # explicit
#
# Safe to re-run. Does not restart anything — see the printed next steps.

set -euo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO"

HOST="${1:-properties.farmhandmanager.com}"
URL="https://${HOST}"
BACKEND_ENV="deploy/selfhost/.env"
FRONTEND_ENV=".env"

# set_kv <file> <key> <value> — replaces the line if the key is present,
# appends it if not. `|` as the sed delimiter, never `/`, since these
# values are URLs.
set_kv() {
  local file="$1" key="$2" value="$3"
  if grep -q "^${key}=" "$file"; then
    sed -i "s|^${key}=.*|${key}=${value}|" "$file"
  else
    printf '%s=%s\n' "$key" "$value" >> "$file"
  fi
}

if [ ! -f "$BACKEND_ENV" ]; then
  echo "No $BACKEND_ENV — run deploy/selfhost/generate-secrets.sh first." >&2
  exit 1
fi

set_kv "$BACKEND_ENV" APP_URL "$URL"

# The three variables APP_URL replaced. Commented rather than deleted, so
# that if something was depending on one, it's visible in the file rather
# than having silently vanished.
for old in API_HOST API_PORT FRONTEND_DEV_URL; do
  if grep -q "^${old}=" "$BACKEND_ENV"; then
    sed -i "s|^${old}=|# replaced by APP_URL: ${old}=|" "$BACKEND_ENV"
    echo "  (retired ${old} in $BACKEND_ENV)"
  fi
done
echo "APP_URL=$URL"

if [ ! -f "$FRONTEND_ENV" ]; then
  cp .env.example "$FRONTEND_ENV"
fi
set_kv "$FRONTEND_ENV" VITE_SUPABASE_URL "$URL"
echo "VITE_SUPABASE_URL=$URL"

cat <<EOF

Both .env files now point at ${URL}.

Next, in order:
  1. DNS: point ${HOST} at this server (an A record at your registrar).
  2. sudo cp deploy/nginx-property-management.conf /etc/nginx/sites-available/property-management
     sudo ln -sf /etc/nginx/sites-available/property-management /etc/nginx/sites-enabled/
     sudo nginx -t && sudo systemctl reload nginx
  3. sudo certbot --nginx -d ${HOST}
  4. cd deploy/selfhost && docker compose up -d auth   # picks up APP_URL
  5. cd "$REPO" && bash deploy/deploy.sh               # rebuild with the new URL

The frontend URL is baked in at build time, so step 5 is required — the
site keeps calling the old address until it is rebuilt.
EOF
