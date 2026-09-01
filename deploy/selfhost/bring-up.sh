#!/usr/bin/env bash
#
# Runs the whole PropertyManagement backend bring-up in one pass — steps 2
# through 6 of README.md (Postgres, Auth, schema, REST API, nginx), each
# with the same sanity check README.md calls out, so this stops at the
# first real problem instead of plowing through it. Run from
# ~/PropertyManagement/deploy/selfhost, after finishing step 1 in
# README.md (.env filled in: POSTGRES_PASSWORD, JWT_SECRET, ANON_KEY,
# SERVICE_ROLE_KEY).
#
#   bash bring-up.sh
#
# Needs sudo for the nginx step only — you'll be prompted right before
# that happens, not up front.

set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

if [ ! -f .env ]; then
  echo "No .env here — finish step 1 in README.md first (cp .env.example .env, fill it in)." >&2
  exit 1
fi
set -a; source .env; set +a
for v in POSTGRES_PASSWORD JWT_SECRET ANON_KEY SERVICE_ROLE_KEY API_HOST API_PORT; do
  if [ -z "${!v:-}" ]; then
    echo "$v is empty in .env — finish step 1 in README.md first." >&2
    exit 1
  fi
done

step() { printf '\n=== %s ===\n' "$1"; }
wait_for() {
  # wait_for <description> <check-command...>
  local desc="$1"; shift
  for i in $(seq 1 15); do
    "$@" >/dev/null 2>&1 && return 0
    sleep 2
  done
  echo "Timed out waiting for: $desc" >&2
  return 1
}
wait_for_stable() {
  # wait_for_stable <description> <consecutive successes needed> <check-command...>
  # supabase/postgres restarts itself partway through its own init (to load
  # extensions like pg_cron/timescaledb that need shared_preload_libraries)
  # — a single pg_isready success can land in the brief window before that
  # restart, not after it. Requiring several checks in a row to succeed
  # means a mid-window restart resets the streak instead of us declaring
  # victory too early and losing the connection mid-command right after.
  local desc="$1" need="$2"; shift 2
  local streak=0
  for i in $(seq 1 60); do
    if "$@" >/dev/null 2>&1; then
      streak=$((streak+1))
      [ "$streak" -ge "$need" ] && return 0
    else
      streak=0
    fi
    sleep 3
  done
  echo "Timed out waiting for: $desc" >&2
  return 1
}

step "2. Postgres"
docker compose up -d db
echo "waiting for Postgres to settle (it restarts itself once mid-init — this takes a bit)..."
wait_for_stable "Postgres stable" 5 docker compose exec -T db pg_isready -U postgres \
  || { echo "check: docker compose logs db" >&2; exit 1; }
bash set-role-passwords.sh

step "3. Auth"
docker compose up -d auth
echo "waiting for GoTrue to bootstrap the auth schema..."
wait_for "auth schema present" bash -c \
  "docker compose exec -T db psql -U postgres -d postgres -tAc \"select 1 from pg_namespace where nspname='auth';\" | grep -q 1" \
  || { echo "check: docker compose logs auth" >&2; exit 1; }
echo "auth schema present, good."

step "4. Load schema"
bash apply-schema.sh

step "5. REST API"
docker compose up -d rest
echo "waiting for PostgREST to respond..."
rest_ok() {
  [ "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:8002/properties?select=id&limit=1" -H "apikey: $ANON_KEY")" = "200" ]
}
wait_for "REST API responding" bash -c "$(declare -f rest_ok); rest_ok" \
  || { echo "check: docker compose logs rest" >&2; exit 1; }
echo "REST API responding, good."

step "6. nginx (will ask for your sudo password)"
sudo cp nginx-property-management-api.conf /etc/nginx/sites-available/property-management-api
sudo cp nginx-property-management-cors.conf /etc/nginx/conf.d/property-management-cors.conf
sudo ln -sf /etc/nginx/sites-available/property-management-api /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl reload nginx
echo "waiting for the public endpoint to respond..."
public_ok() {
  [ "$(curl -s -o /dev/null -w '%{http_code}' "http://${API_HOST}:${API_PORT}/rest/v1/properties?select=id&limit=1" -H "apikey: $ANON_KEY")" = "200" ]
}
wait_for "public endpoint responding" bash -c "$(declare -f public_ok); public_ok" \
  || { echo "check: sudo tail -50 /var/log/nginx/error.log" >&2; exit 1; }

step "All done"
echo "Backend is live at http://${API_HOST}:${API_PORT}"
