#!/usr/bin/env bash
#
# Fills in the secret values in .env automatically — POSTGRES_PASSWORD,
# JWT_SECRET, ANON_KEY, SERVICE_ROLE_KEY, VAPID_PUBLIC_KEY,
# VAPID_PRIVATE_KEY — instead of generating each by hand and pasting it
# into nano. Creates .env from .env.example first if it doesn't exist yet.
# Safe to run more than once: never overwrites a value that's already
# filled in, so re-running after manually setting one or two of these just
# fills in whatever's still blank.
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
  # An .env created before this key existed has no line to replace, and a
  # sed that matches nothing still succeeds — so this would report "set."
  # having set nothing, and the feature would be quietly dead. Append.
  if ! grep -q "^${key}=" .env; then
    printf '%s=%s\n' "$key" "$value" >> .env
    echo "$key added."
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

# The public and private VAPID keys are one keypair, not two independent
# secrets — generating them separately through set_kv would pair a
# leftover public key with a freshly generated, unrelated private one. So
# this only regenerates when neither is set yet, and writes both together.
if grep -q '^VAPID_PUBLIC_KEY=..*' .env; then
  echo "VAPID_PUBLIC_KEY already set in .env — leaving the VAPID keypair alone."
else
  vapid="$(node generate-vapid-keys.mjs)"
  set_kv VAPID_PUBLIC_KEY "$(printf '%s' "$vapid" | grep '^VAPID_PUBLIC_KEY=' | cut -d= -f2-)"
  set_kv VAPID_PRIVATE_KEY "$(printf '%s' "$vapid" | grep '^VAPID_PRIVATE_KEY=' | cut -d= -f2-)"
fi

echo
echo "Done — secrets are in .env. SMTP_* and VAPID_SUBJECT can stay blank for now."
