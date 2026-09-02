#!/usr/bin/env bash
#
# Brings up the backend containers and loads the schema: Postgres, Auth,
# then the REST API, each with the sanity check README.md describes, so
# this stops at the first real problem instead of plowing through it.
#
#   bash bring-up.sh
#
# Backend only — nginx, TLS and the frontend build are a separate step,
# because nginx now serves the built site from the same origin as the API
# and therefore can't be configured until that build exists. See
# ../README.md for that half.
#
# Everything here binds to 127.0.0.1: nothing this script starts is
# reachable from outside the VPS until nginx is put in front of it.

set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

if [ ! -f .env ]; then
  echo "No .env here. Run: cp .env.example .env && bash generate-secrets.sh" >&2
  exit 1
fi
set -a; source .env; set +a
for v in POSTGRES_PASSWORD JWT_SECRET ANON_KEY SERVICE_ROLE_KEY APP_URL; do
  if [ -z "${!v:-}" ]; then
    echo "$v is empty in .env." >&2
    [ "$v" = "APP_URL" ] && echo "Run: bash ../set-domain.sh" >&2
    [ "$v" != "APP_URL" ] && echo "Run: bash generate-secrets.sh" >&2
    exit 1
  fi
done

# Mail is not optional now that GOTRUE_MAILER_AUTOCONFIRM is "false":
# without it nobody can complete a signup, and that failure shows up as a
# confusing error during signup rather than anything pointing at SMTP.
if [ -z "${SMTP_USER:-}" ] || [ -z "${SMTP_PASS:-}" ]; then
  echo "WARNING: SMTP_USER/SMTP_PASS are empty in .env." >&2
  echo "  Email confirmation is ON, so signups cannot complete without working mail." >&2
  echo "  Fill in the SMTP_* values and re-run 'docker compose up -d auth'." >&2
  echo >&2
fi

step() { printf '\n=== %s ===\n' "$1"; }
wait_for_stable() {
  # wait_for_stable <description> <consecutive successes> <command...>
  # supabase/postgres restarts itself partway through its own init (to load
  # extensions needing shared_preload_libraries), so a single successful
  # ping can land in the window before that restart. Requiring several in a
  # row means the restart resets the streak instead of us declaring
  # victory early and losing the connection mid-command straight after.
  local desc="$1" need="$2"; shift 2
  local streak=0
  for _ in $(seq 1 60); do
    if "$@" >/dev/null 2>&1; then
      streak=$((streak+1)); [ "$streak" -ge "$need" ] && return 0
    else streak=0; fi
    sleep 3
  done
  echo "Timed out waiting for: $desc" >&2
  return 1
}
wait_for() {
  local desc="$1"; shift
  for _ in $(seq 1 20); do "$@" >/dev/null 2>&1 && return 0; sleep 2; done
  echo "Timed out waiting for: $desc" >&2
  return 1
}

step "1. Postgres"
docker compose up -d db
echo "waiting for Postgres to settle (it restarts itself once mid-init)..."
wait_for_stable "Postgres stable" 5 docker compose exec -T db pg_isready -U postgres \
  || { echo "check: docker compose logs db" >&2; exit 1; }
bash set-role-passwords.sh

step "2. Auth"
docker compose up -d auth
echo "waiting for GoTrue to bootstrap the auth schema..."
wait_for "auth schema present" bash -c \
  "docker compose exec -T db psql -U postgres -d postgres -tAc \"select 1 from pg_namespace where nspname='auth';\" | grep -q 1" \
  || { echo "check: docker compose logs auth" >&2; exit 1; }
echo "auth schema present, good."

step "3. Load schema"
bash apply-schema.sh

step "4. REST API"
docker compose up -d rest
echo "waiting for PostgREST to respond..."
rest_ok() {
  [ "$(curl -s -o /dev/null -w '%{http_code}' \
      "http://127.0.0.1:8002/properties?select=id&limit=1" -H "apikey: $ANON_KEY")" = "200" ]
}
wait_for "REST API responding" bash -c "$(declare -f rest_ok); rest_ok" \
  || { echo "check: docker compose logs rest" >&2; exit 1; }
echo "REST API responding, good."

step "Backend up"
cat <<EOF
Reachable only from this machine so far (127.0.0.1:8002 / :9998).

Next, to put it on ${APP_URL}:
  cd ..
  bash deploy/link-env.sh     # anon key into the frontend .env
  bash deploy/deploy.sh       # build the site nginx will serve
  sudo cp deploy/nginx-property-management.conf /etc/nginx/sites-available/property-management
  sudo ln -sf /etc/nginx/sites-available/property-management /etc/nginx/sites-enabled/
  sudo nginx -t && sudo systemctl reload nginx
  sudo certbot --nginx -d \$(echo "${APP_URL}" | sed 's|https\?://||')
EOF
