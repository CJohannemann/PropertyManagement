#!/usr/bin/env bash
#
# Checks GitHub for new commits and, if there are any, rebuilds the
# frontend. Run on a timer by property-management-deploy.timer — see
# deploy/README.md for the install steps.
#
# Exits silently when there's nothing new, so the journal only carries
# entries for runs that actually did something.
#
# Deliberately does NOT apply database migrations. A frontend rebuild is
# safe to do unattended; schema changes against a live database with real
# tenant and payment data are not — an unattended migration that goes
# wrong at 3am is discovered by a tenant, not by you. New migration files
# are reported loudly instead, to be applied by hand with
# deploy/selfhost/apply-migrations.sh.

set -euo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO"

# systemd runs with a minimal PATH that won't include an nvm-installed
# node, so npm goes missing here even though it works fine in an
# interactive shell. Rather than hardcode a path that differs between
# nvm and apt installs, look for npm and fall back to sourcing nvm.
if ! command -v npm >/dev/null 2>&1; then
  for nvm_sh in "${NVM_DIR:-$HOME/.nvm}/nvm.sh" /usr/local/nvm/nvm.sh; do
    # shellcheck disable=SC1090
    [ -s "$nvm_sh" ] && . "$nvm_sh" && break
  done
fi
if ! command -v npm >/dev/null 2>&1; then
  echo "npm not on PATH and no nvm found — cannot build." >&2
  exit 1
fi

# A slow npm ci plus a 2-minute timer could otherwise overlap and have two
# builds writing dist/ at once. -n so the second run bows out rather than
# queueing up behind the first.
#
# The command -v guard matters more than it looks: written as a bare
# `flock -n 9 || { ...skipping...; exit 0; }`, a *missing* flock takes the
# same branch as a held lock, so every single run would exit 0 saying
# "already running" and the deploy would silently never happen again.
# flock ships with util-linux and is present on the VPS; this is about the
# failure being legible if it ever isn't.
if command -v flock >/dev/null 2>&1; then
  exec 9>/tmp/property-management-deploy.lock
  flock -n 9 || { echo "another deploy is already running; skipping this tick"; exit 0; }
else
  echo "WARNING: flock not found; running without an overlap guard." >&2
fi

before="$(git rev-parse HEAD)"
git fetch --quiet origin master
after="$(git rev-parse origin/master)"

if [ "$before" = "$after" ]; then
  exit 0
fi

echo "New commits ${before:0:7} -> ${after:0:7}, deploying."

# Checked before the pull, while `before` is still what's on disk.
new_migrations="$(git diff --name-only "$before" "$after" -- db/migrations/ || true)"

bash deploy/deploy.sh

if [ -n "$new_migrations" ]; then
  echo
  echo "============================================================"
  echo "WARNING: new database migrations were pulled but NOT applied:"
  echo "$new_migrations"
  echo
  echo "Apply them yourself when you're ready to watch it happen:"
  echo "  cd $REPO && bash deploy/selfhost/apply-migrations.sh"
  echo "============================================================"
fi
