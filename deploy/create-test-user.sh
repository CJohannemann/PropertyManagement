#!/usr/bin/env bash
#
# Creates a confirmed account and puts it in an organization with a role,
# for testing each role's view without needing a real mailbox per role.
#
#   bash deploy/create-test-user.sh <email> <password> <role> [full name] [lease id]
#
#   bash deploy/create-test-user.sh admin@example.com  pw admin
#   bash deploy/create-test-user.sh pm@example.com     pw property_manager
#   bash deploy/create-test-user.sh tech@example.com   pw technician
#   bash deploy/create-test-user.sh renter@example.com pw tenant 'Test Renter'
#
# Roles: admin | property_manager | technician | tenant
#
# This exists because the normal ways in are deliberately closed: signup
# needs a confirmable email address, and joining an organization needs an
# invite. Both are right for real users and both are in the way when you
# want to look at the technician view for thirty seconds.
#
# A tenant is attached to a lease, since a tenant without one only ever
# sees "no lease on file". With exactly one active lease it is picked
# automatically; with several, pass the id as the fifth argument and the
# script lists them.
#
# A technician is granted access to every property, for the same reason:
# access defaults to none, so an unscoped technician sees no jobs at all
# and the role looks broken rather than empty.
#
# Accounts made here are real and confirmed, and can sign in from
# anywhere. Remove them with deploy/delete-test-users.sh.

set -euo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO/deploy/selfhost"

EMAIL="${1:-}"
PASSWORD="${2:-}"
ROLE="${3:-}"
FULL_NAME="${4:-}"
LEASE_ID="${5:-}"

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

# Values are passed as psql variables and referenced with :'name', never
# interpolated into the SQL string. Two traps behind that:
#
#   * Postgres dollar-quoting cannot be used here at all: bash expands a
#     bare double-dollar to its own PID before psql ever sees it, which
#     produced SQL reading `34807admin@example.com34807`.
#   * psql does NOT expand :'vars' given in a -c string, only in SQL it
#     reads from stdin. Same command, silently different behaviour.
psql() {
  docker compose exec -T db psql -U postgres -d postgres -qtAX "$@"
}

# SQL on stdin, values as -v variables.
psql_in() {
  local sql="$1"; shift
  printf '%s\n' "$sql" \
    | docker compose exec -T db psql -U postgres -d postgres -qtAX "$@"
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
           do update set role = excluded.role, status = 'active';" \
  -v org="$ORG_ID" -v uid="$USER_ID" -v role="$ROLE" -v nm="$FULL_NAME" > /dev/null

MEMBER_ID="$(psql_in "select id from org_members
                       where organization_id = :'org' and user_id = :'uid';" \
  -v org="$ORG_ID" -v uid="$USER_ID")"

ATTACHED=""

# A technician with no property access sees no jobs, because access
# defaults to none. That is the right default for a real technician and
# makes a test one look broken, so grant everything: a null property_id
# means "all properties" (see db/schema.sql).
if [ "$ROLE" = "technician" ]; then
  psql_in "insert into technician_property_access (org_member_id, property_id)
           values (:'m', null) on conflict do nothing;" -v m="$MEMBER_ID" > /dev/null
  ATTACHED="access to all properties"
fi

if [ "$ROLE" = "tenant" ]; then
  if [ -z "$LEASE_ID" ]; then
    LEASE_COUNT="$(psql -c "select count(*) from leases where status = 'active';")"
    if [ "$LEASE_COUNT" = "0" ]; then
      ATTACHED="no lease — create one first, then re-run to attach them"
    elif [ "$LEASE_COUNT" = "1" ]; then
      LEASE_ID="$(psql -c "select id from leases where status = 'active' limit 1;")"
    else
      echo
      echo "There is more than one active lease, so pick which one this renter is on"
      echo "and pass its id as the fifth argument:"
      docker compose exec -T db psql -U postgres -d postgres -c \
        "select l.id, p.name as property, u.label as unit, l.rent_amount
           from leases l join units u on u.id = l.unit_id
           join properties p on p.id = u.property_id
          where l.status = 'active';"
      exit 1
    fi
  fi

  if [ -n "$LEASE_ID" ]; then
    # is_primary only when nobody else holds it, so adding a second test
    # renter to a lease makes a roommate rather than a second primary.
    psql_in "insert into lease_tenants (lease_id, org_member_id, is_primary)
             select :'l', :'m',
                    not exists (select 1 from lease_tenants
                                 where lease_id = :'l' and is_primary)
             on conflict (lease_id, org_member_id) do nothing;" \
      -v l="$LEASE_ID" -v m="$MEMBER_ID" > /dev/null
    ATTACHED="$(psql_in "select p.name || ' · ' || u.label
                           from leases l join units u on u.id = l.unit_id
                           join properties p on p.id = u.property_id
                          where l.id = :'l';" -v l="$LEASE_ID")"
  fi
fi

echo
echo "Done."
echo "  sign in with: $EMAIL"
echo "  role:         $ROLE"
[ -n "$ATTACHED" ] && echo "  attached to:  $ATTACHED"
echo
echo "Delete it again with: bash deploy/delete-test-users.sh"
