#!/usr/bin/env bash
#
# Removes the test accounts created by create-test-user.sh.
#
#   bash deploy/delete-test-users.sh            # lists what it would delete
#   bash deploy/delete-test-users.sh --confirm  # actually deletes
#
# Matches @example.com only. That domain is reserved by RFC 2606 precisely
# so it can never belong to a real person, which makes it safe to delete
# by pattern — unlike, say, anything ending @gmail.com.
#
# Run this before real tenant data exists. A test admin account with a
# guessable password is a way into every lease and rent record in the
# system, and it does not stop being one because it was only meant for an
# afternoon.

set -euo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO/deploy/selfhost"

psql() { docker compose exec -T db psql -U postgres -d postgres "$@"; }

echo "Test accounts (@example.com):"
psql -c "select u.email, m.role, m.status
           from auth.users u
           left join org_members m on m.user_id = u.id
          where u.email like '%@example.com'
          order by u.email;"

if [ "${1:-}" != "--confirm" ]; then
  echo
  echo "Nothing deleted. Re-run with --confirm to remove these accounts."
  exit 0
fi

# Deleting the auth user cascades to org_members, and from there to
# lease_tenants — so a test tenant is detached from any lease they were on.
# Rent charges are deliberately left: they belong to the lease, not the
# person, and are owed by whoever actually moves in.
psql -c "delete from auth.users where email like '%@example.com';"
psql -c "delete from org_creation_allowlist where email like '%@example.com';"

echo
echo "Test accounts removed."
