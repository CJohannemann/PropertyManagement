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

if grep -q '^VITE_VAPID_PUBLIC_KEY=..*' .env; then
  echo "VITE_VAPID_PUBLIC_KEY already set in .env — leaving it alone."
else
  vapid_pub="$(grep '^VAPID_PUBLIC_KEY=' "$BACKEND_ENV" | cut -d= -f2-)"
  if [ -z "$vapid_pub" ]; then
    echo "VAPID_PUBLIC_KEY is empty in $BACKEND_ENV — run generate-secrets.sh first." >&2
    exit 1
  fi
  sed -i "s|^VITE_VAPID_PUBLIC_KEY=.*|VITE_VAPID_PUBLIC_KEY=${vapid_pub}|" .env
  echo "VITE_VAPID_PUBLIC_KEY set from $BACKEND_ENV."
fi

if grep -q '^VITE_STRIPE_PUBLISHABLE_KEY=..*' .env; then
  echo "VITE_STRIPE_PUBLISHABLE_KEY already set in .env — leaving it alone."
else
  stripe_pub="$(grep '^STRIPE_PUBLISHABLE_KEY=' "$BACKEND_ENV" | cut -d= -f2-)"
  if [ -z "$stripe_pub" ]; then
    # Not fatal, unlike the two above: the rest of the app works fine
    # without payments, and this lets someone deploy before they have a
    # Stripe account. The tenant dashboard hides the pay button when this
    # is empty rather than offering one that cannot work.
    echo "STRIPE_PUBLISHABLE_KEY is empty in $BACKEND_ENV — skipping;" \
         "online rent payment will stay switched off."
  else
    sed -i "s|^VITE_STRIPE_PUBLISHABLE_KEY=.*|VITE_STRIPE_PUBLISHABLE_KEY=${stripe_pub}|" .env
    echo "VITE_STRIPE_PUBLISHABLE_KEY set from $BACKEND_ENV."
  fi
fi

echo
echo "Frontend .env ready:"
grep '^VITE_' .env \
  | sed 's|\(VITE_SUPABASE_ANON_KEY=.\{16\}\).*|\1…|' \
  | sed 's|\(VITE_VAPID_PUBLIC_KEY=.\{16\}\).*|\1…|'
