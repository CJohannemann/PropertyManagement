#!/usr/bin/env bash
#
# Wrapper around the payments API for systemd. Run directly, systemd's
# minimal PATH won't include an nvm-installed node — the same problem
# deploy/auto-deploy.sh already works around for npm, so this uses the
# identical fallback rather than inventing a second way to find it.
#
#   bash deploy/api.sh

set -euo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO"

if ! command -v node >/dev/null 2>&1; then
  for nvm_sh in "${NVM_DIR:-$HOME/.nvm}/nvm.sh" /usr/local/nvm/nvm.sh; do
    # shellcheck disable=SC1090
    [ -s "$nvm_sh" ] && . "$nvm_sh" && break
  done
fi
if ! command -v node >/dev/null 2>&1; then
  echo "node not on PATH and no nvm found — cannot start the API." >&2
  exit 1
fi

exec node server/index.mjs
