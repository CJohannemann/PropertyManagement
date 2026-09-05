#!/usr/bin/env bash
#
# Fills in the frontend's .env from the backend's, instead of copying
# values between two files by hand. Creates .env from .env.example first
# if it doesn't exist, then pulls ANON_KEY and VAPID_PUBLIC_KEY out of
# deploy/selfhost/.env and writes them in as VITE_SUPABASE_ANON_KEY and
# VITE_VAPID_PUBLIC_KEY.
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

# Copies one value from the backend .env into the frontend one.
#
#   copy_key <backend key> <VITE_ key> <required|optional>
#
# The append branch is not a nicety: an .env written before a given key
# existed has no line for sed to replace, and a sed that matches nothing
# still exits 0 — so an earlier version of this script reported the key
# "set" while setting nothing, leaving the feature silently dead on an
# already-deployed box.
copy_key() {
  local src="$1" dest="$2" requirement="$3"

  if grep -q "^${dest}=..*" .env; then
    echo "$dest already set in .env — leaving it alone."
    return
  fi

  local value
  value="$(grep "^${src}=" "$BACKEND_ENV" | cut -d= -f2-)"
  if [ -z "$value" ]; then
    if [ "$requirement" = required ]; then
      echo "$src is empty in $BACKEND_ENV — run generate-secrets.sh first." >&2
      exit 1
    fi
    echo "$src is empty in $BACKEND_ENV — skipping $dest."
    return
  fi

  if grep -q "^${dest}=" .env; then
    # | as the sed delimiter, not / — these are base64url and can contain /.
    sed -i "s|^${dest}=.*|${dest}=${value}|" .env
  else
    printf '%s=%s\n' "$dest" "$value" >> .env
  fi
  echo "$dest set from $BACKEND_ENV."
}

copy_key ANON_KEY VITE_SUPABASE_ANON_KEY required
copy_key VAPID_PUBLIC_KEY VITE_VAPID_PUBLIC_KEY required

# Optional, unlike the two above: everything except online rent payment
# works without it, so a box can be deployed before there is a Stripe
# account. The tenant dashboard hides the pay button when this is empty
# rather than offering one that cannot work.
copy_key STRIPE_PUBLISHABLE_KEY VITE_STRIPE_PUBLISHABLE_KEY optional

echo
echo "Frontend .env ready:"
grep '^VITE_' .env \
  | sed 's|\(VITE_SUPABASE_ANON_KEY=.\{16\}\).*|\1…|' \
  | sed 's|\(VITE_VAPID_PUBLIC_KEY=.\{16\}\).*|\1…|'
