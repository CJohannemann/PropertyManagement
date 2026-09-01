#!/usr/bin/env bash
#
# Fills in the four secret values in .env automatically — POSTGRES_PASSWORD,
# JWT_SECRET, ANON_KEY, SERVICE_ROLE_KEY — instead of generating each by
# hand and pasting it into nano. Creates .env from .env.example first if it
# doesn't exist yet. Safe to run more than once: never overwrites a value
# that's already filled in, so re-running after manually setting one or two
# of these just fills in whatever's still blank.
#
#   bash generate-secrets.sh

set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

[ -f .env ] || cp .env.example .env

set_kv() {
  local key="$1" value="$2"
  if grep -q "^${key}=..*" .env; then
    echo "$key already set in .env — leaving it alone."
    return
  fi
  # | as the sed delimiter, not the more usual / — these values (hex,
  # base64, base64url) can themselves contain a literal /.
  sed -i "s|^${key}=.*|${key}=${value}|" .env
  echo "$key set."
}

set_kv POSTGRES_PASSWORD "$(openssl rand -hex 32)"
set_kv JWT_SECRET "$(openssl rand -base64 32)"

# Read back whatever JWT_SECRET actually ended up in .env, rather than
# assuming it's the one just generated above — set_kv leaves an
# already-present value alone, so this covers a re-run too.
jwt="$(grep '^JWT_SECRET=' .env | cut -d= -f2-)"
set_kv ANON_KEY "$(node mint-jwt.mjs "$jwt" anon)"
set_kv SERVICE_ROLE_KEY "$(node mint-jwt.mjs "$jwt" service_role)"

echo
echo "Done — secrets are in .env. SMTP_* can stay blank for now."
