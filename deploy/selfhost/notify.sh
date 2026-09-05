#!/usr/bin/env bash
#
# Wrapper around send-request-notifications.mjs for systemd. Run directly,
# systemd's minimal PATH won't include an nvm-installed node — the same
# problem deploy/auto-deploy.sh already works around for npm, so this uses
# the identical fallback rather than inventing a second way to find it.
#
#   bash notify.sh

set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

if ! command -v node >/dev/null 2>&1; then
  for nvm_sh in "${NVM_DIR:-$HOME/.nvm}/nvm.sh" /usr/local/nvm/nvm.sh; do
    # shellcheck disable=SC1090
    [ -s "$nvm_sh" ] && . "$nvm_sh" && break
  done
fi
if ! command -v node >/dev/null 2>&1; then
  echo "node not on PATH and no nvm found — cannot check for notifications." >&2
  exit 1
fi

exec node send-request-notifications.mjs
