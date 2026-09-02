# Self-hosting PropertyManagement's backend

Postgres, its REST API, and Auth, running as Docker containers on the same
VPS as FarmHand and the baseball site — a separate stack from FarmHand's,
on its own ports, sharing nothing. Swap and Docker are already set up on
this box from FarmHand's bring-up, so those steps aren't repeated here.

nginx and the frontend build are covered by [`../README.md`](../README.md).
This file is only the containers and the database.

## First-time setup

```bash
cd ~/PropertyManagement/deploy/selfhost
cp .env.example .env
bash generate-secrets.sh        # fills in the four secrets
bash ../set-domain.sh           # sets APP_URL (and the frontend's URL)
nano .env                       # fill in the SMTP_* values
```

SMTP is **required**, not optional: `GOTRUE_MAILER_AUTOCONFIRM` is `false`,
so an account can't finish signing up until it confirms its email address.
The same Brevo credentials FarmHand uses work here.

Then:

```bash
bash bring-up.sh
```

That starts Postgres, waits for it to settle, sets the role passwords,
starts Auth, loads `db/schema.sql` + `db/seed.sql` + every migration, and
starts PostgREST — checking each step before moving on. It prints the
remaining nginx/TLS commands when it finishes.

## Day to day

```bash
cd ~/PropertyManagement/deploy/selfhost
docker compose ps                  # is everything up?
docker compose logs -f auth        # or rest, or db
docker compose restart rest        # or auth, or db
```

### Applying a new migration

Auto-deploy rebuilds the frontend but deliberately never touches the
database, so a commit that adds a `db/migrations/` file needs this by hand:

```bash
cd ~/PropertyManagement
git pull
bash deploy/selfhost/apply-migrations.sh
```

Safe to run anytime, including when nothing is new — every migration file
guards against being applied twice.

### Letting someone create an organization

Organization creation is allowlisted (see
`db/migrations/003_restrict_org_creation.sql`) — without this, anyone who
signs up could create their own organization on this server.

```bash
docker compose exec -T db psql -U postgres -d postgres \
  -c "insert into org_creation_allowlist (email, note) values ('them@example.com', 'why') on conflict do nothing;"
```

Existing org admins were added automatically when that migration ran.
Tenants, technicians and property managers don't need this — they join an
existing organization through an invite.

### Rent billing

`pg_cron` runs `run_rent_billing()` daily at 06:00 UTC: it generates each
month's rent charges, marks overdue ones, and applies late fees on leases
that opted in. To check on it, or to run it by hand:

```bash
docker compose exec -T db psql -U postgres -d postgres -c "select * from cron.job;"
docker compose exec -T db psql -U postgres -d postgres -c "select run_rent_billing();"
```

It's safe to run by hand at any time — it won't double-bill.

## Backups

```bash
cd ~/PropertyManagement/deploy/selfhost
docker compose exec db pg_dump -U postgres postgres | gzip > ~/property-management-backup-$(date +%F).sql.gz
tar czf ~/property-management-receipts-$(date +%F).tar.gz data/storage
```

Both halves matter: the dump holds the records, `data/storage` holds the
receipt photos those records refer to. A receipt is a tax document, and
backing up only the database leaves rows pointing at files that are gone.

Worth a systemd timer once real tenant data is in here — the baseball
site's `ibc-backup.timer` is a working example to copy, and FarmHand's
`check-disk.sh` timer already watches this VPS's overall disk usage, which
covers this stack's data too.
