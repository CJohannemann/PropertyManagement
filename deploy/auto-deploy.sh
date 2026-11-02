#!/usr/bin/env bash
#
# Checks GitHub for new commits and, if there are any, deploys them —
# database migrations included. Run on a timer by
# property-management-deploy.timer — see deploy/README.md for the install
# steps, and deploy.sh for how migrations are made safe to run unattended
# (a backup first, one transaction per file, and the frontend held back
# until they succeed).
#
# Exits silently when there's nothing new, so the journal only carries
# entries for runs that actually did something.

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

STATE="$REPO/.deploy-state"
git fetch --quiet origin master
after="$(git rev-parse origin/master)"

# Compared against the last deploy that *finished*, not against HEAD: a
# deploy that pulled and then failed (a migration, npm ci, the build) has
# HEAD already at the new commit, and comparing against HEAD would call
# that "nothing new" and never try again. No record at all — the first run
# after this was introduced — deploys, which is also what applies any
# migration pulled back when they were left to be run by hand.
last="$(cat "$STATE/last-deployed" 2>/dev/null || true)"
if [ "$last" = "$after" ]; then
  exit 0
fi

# A migration failed on exactly this commit; deploy.sh already said so,
# loudly, once. Retrying every two minutes would take a fresh backup each
# time and bury that message. A newer commit gets a fresh attempt.
if [ "$(cat "$STATE/blocked" 2>/dev/null || true)" = "$after" ]; then
  exit 0
fi

echo "New commits ${last:0:7} -> ${after:0:7}, deploying."
bash deploy/deploy.sh
