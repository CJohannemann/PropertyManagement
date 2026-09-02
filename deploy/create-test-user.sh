#!/usr/bin/env bash
#
# Creates a confirmed account and puts it in an organization with a role,
# for testing each role's view without needing a real mailbox per role.
#
#   bash deploy/create-test-user.sh <email> <password> <role> [full name]
#
#   bash deploy/create-test-user.sh admin@example.com 'S0meth1ng-Better' admin
#   bash deploy/create-test-user.sh pm@example.com    'S0meth1ng-Better' property_manager
#   bash deploy/create-test-user.sh tech@example.com  'S0meth1ng-Better' technician
#
# Roles: admin | property_manager | technician | tenant
#
# This exists because the normal ways in are deliberately closed: signup
# needs a confirmable email address, and joining an organization needs an
# invite. Both are right for real users and both are in the way when you
# want to look at the technician view for thirty seconds.
#
# ─────────────────────────────────────────────────────────────────────
#  THESE ARE TEST ACCOUNTS ON A PUBLICLY REACHABLE SITE.
#
#  Every account made here is real, confirmed, and can sign in from
#  anywhere. An admin account with a guessable password is a way into
#  every lease, tenant name and rent record in the system — so before real
#  tenant data lands, delete them:
#
#    bash deploy/delete-test-users.sh
#
#  A tenant account also needs a lease to be attached to; this script does
#  not do that, since a tenant with no lease is exactly what you want for
#  testing the "no lease yet" screen. Use a real invite for the rest.
# ─────────────────────────────────────────────────────────────────────

set -euo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO/deploy/selfhost"

EMAIL="${1:-}"
PASSWORD="${2:-}"
ROLE="${3:-}"
FULL_NAME="${4:-}"

if [ -z "$EMAIL" ] || [ -z "$PASSWORD" ] || [ -z "$ROLE" ]; then
  echo "Usage: bash deploy/create-test-user.sh <email> <password> <role> [full name]" >&2
  echo "Roles: admin | property_manager | technician | tenant" >&2
  exit 1
fi

case "$ROLE" in
  admin|property_manager|technician|tenant) ;;
  *) echo "Unknown role '$ROLE'." >&2; exit 1 ;;
esac

if [ ! -f .env ]; then
  echo "No deploy/selfhost/.env — run generate-secrets.sh first." >&2
  exit 1
fi
set -a; source .env; set +a

# Warn rather than refuse: it is the operator's system, and a bad password
# on a throwaway account is a judgement call. Silence would not be.
if [ "${#PASSWORD}" -lt 12 ] || printf '%s' "$PASSWORD" | grep -qiE '^(password|test|admin|letmein|123)'; then
  echo "WARNING: that password is short or guessable, and this account will be" >&2
  echo "         reachable from the public internet. Fine for today; delete it" >&2
  echo "         before real tenant data exists (deploy/delete-test-users.sh)." >&2
  echo >&2
fi

# Values are passed as psql variables and referenced with :'name', never
# interpolated into the SQL string. Two traps behind that:
#
#   * `$`-quoting cannot be used here at all — bash expands $ to its own
#     PID before psql sees it, producing SQL reading `34807admin@...`.
#   * psql does NOT expand :'vars' in a -c string, only in SQL it reads
#     from stdin. Same command, silently different behaviour.
psql() {
  docker compose exec -T db psql -U postgres -d postgres -qtAX "$@"
}

# SQL on stdin, values as -v variables.
psql_in() {
  local sql="$1"; shift
  printf '%s
' "$sql" | docker compose exec -T db     psql -U postgres -d postgres -qtAX "$@"
}

# Created through GoTrue's admin API rather than by writing to auth.users
# directly: it owns the password hashing format, and a hand-rolled row is
# a login that fails for reasons nothing explains.
echo "Creating the account…"
RESPONSE="$(curl -s --max-time 20 -X POST "http://127.0.0.1:9998/admin/users" \
  -H "Authorization: Bearer ${SERVICE_ROLE_KEY}" \
  -H "apikey: ${SERVICE_ROLE_KEY}" \
  -H "Content-Type: application/json" \
  -d "$(printf '{"email":"%s","password":"%s","email_confirm":true}' "$EMAIL" "$PASSWORD")")"

USER_ID="$(printf '%s' "$RESPONSE" | grep -o '"id":"[0-9a-f-]\{36\}"' | head -1 | cut -d'"' -f4)"

if [ -z "$USER_ID" ]; then
  # Already existing is the common case on a re-run, and is fine — the
  # membership below is what actually needs to be right.
  if printf '%s' "$RESPONSE" | grep -qi "already been registered\|already exists"; then
    echo "That address already has an account; reusing it."
    USER_ID="$(psql_in "select id from auth.users where email = :'em';" -v em="$EMAIL")"
  fi
fi

if [ -z "$USER_ID" ]; then
  echo "Could not create or find the account. GoTrue said:" >&2
  echo "$RESPONSE" >&2
  exit 1
fi

ORG_COUNT="$(psql -c "select count(*) from organizations;")"
if [ "$ORG_COUNT" = "0" ]; then
  echo "There are no organizations yet — sign in as yourself and create one first." >&2
  exit 1
fi
if [ "$ORG_COUNT" != "1" ]; then
  echo "There is more than one organization, so this script cannot guess which" >&2
  echo "one to add the account to. Add it by hand:" >&2
  psql -c "select id, name from organizations;" >&2
  exit 1
fi
ORG_ID="$(psql -c "select id from organizations limit 1;")"

# An admin needs to be able to create organizations, same as any other.
if [ "$ROLE" = "admin" ]; then
  psql_in "insert into org_creation_allowlist (email, note)
           values (:'em', 'test account') on conflict do nothing;" -v em="$EMAIL" > /dev/null
fi

psql_in "insert into org_members (organization_id, user_id, role, status, full_name)
         values (:'org', :'uid', :'role'::org_role, 'active', nullif(:'nm', ''))
         on conflict (organization_id, user_id)
           do update set role = excluded.role, status = 'active';"   -v org="$ORG_ID" -v uid="$USER_ID" -v role="$ROLE" -v nm="$FULL_NAME" > /dev/null

echo
echo "Done."
echo "  sign in with: $EMAIL"
echo "  role:         $ROLE"
echo
echo "Delete it again with: bash deploy/delete-test-users.sh"
