#!/usr/bin/env bash
#
# Dumps the self-hosted Postgres to a timestamped file, and keeps the most
# recent few. deploy.sh runs this before every migration, so a migration
# that does something unexpected to real tenant and payment data can be
# undone from a copy taken seconds earlier.
#
#   bash deploy/selfhost/backup-db.sh
#
# Written OUTSIDE the repo on purpose (default ~/property-management-backups):
# a dump holds tenant names, leases and payment history, and anything inside
# the working tree is one careless `git add -A` away from GitHub.
#
#   PM_BACKUP_DIR   where dumps go          (default ~/property-management-backups)
#   PM_BACKUP_KEEP  how many to keep        (default 20)
#
# To restore one (stops nothing; run while the app is quiet):
#   docker compose exec -T db pg_restore -U postgres -d postgres --clean --if-exists < FILE

set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

DIR="${PM_BACKUP_DIR:-$HOME/property-management-backups}"
KEEP="${PM_BACKUP_KEEP:-20}"
mkdir -p "$DIR"
chmod 700 "$DIR"

# The PID keeps two runs in the same second from overwriting each other.
file="$DIR/pm-$(date -u +%Y%m%dT%H%M%SZ)-$$.dump"
tmp="$file.partial"

# Custom format (-Fc): compressed, and pg_restore can pick out one table
# if only part of a migration needs undoing. Written to .partial first so a
# dump that dies halfway is never mistaken for a good one.
docker compose exec -T db pg_dump -U postgres -d postgres -Fc > "$tmp"
if [ ! -s "$tmp" ]; then
  rm -f "$tmp"
  echo "Backup came out empty — refusing to continue." >&2
  exit 1
fi
mv "$tmp" "$file"
chmod 600 "$file"
echo "Backed up to $file ($(du -h "$file" | cut -f1))"

# Oldest first, drop all but the newest $KEEP.
ls -1t "$DIR"/pm-*.dump 2>/dev/null | tail -n +"$((KEEP + 1))" | while read -r old; do
  rm -f "$old"
done
