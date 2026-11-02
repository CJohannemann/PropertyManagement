#!/usr/bin/env bash
#
# Run every two minutes by property-management-notify.timer. Sends two
# things, independently:
#
#   send-push-notifications.mjs   phone/browser push for every
#                                 notification, to whoever turned
#                                 notifications on in the app
#   send-email-notifications.mjs  email for every notification
#
# Both follow the same rule for who hears about what: the office, the
# technicians who service the property, the tenant — see either script.
#
# Each runs even if the other fails (push not set up must not stop email),
# and the script still exits non-zero if either did, so the failure shows
# in `systemctl status`.
#
# Run directly, systemd's minimal PATH won't include an nvm-installed node
# — the same problem deploy/auto-deploy.sh already works around for npm, so
# this uses the identical fallback rather than inventing a second way to
# find it.
#
#   bash notify.sh

set -uo pipefail
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

status=0
node send-push-notifications.mjs || status=1
node send-email-notifications.mjs || status=1
exit "$status"
