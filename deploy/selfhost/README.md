# Self-hosting PropertyManagement's backend

Same three pieces as FarmHand's self-hosted backend on this same VPS —
Postgres, its REST API, and Auth — running as a second, separate set of
Docker containers (see `docker-compose.yml`'s header for why this is a
fully separate stack rather than sharing FarmHand's Postgres). Swap and
Docker are already set up on this box from FarmHand's own bring-up, so
those steps aren't repeated here.

**TEMPORARY setup**: no domain is bought yet, so this is reached at
`http://15.204.120.16:8090` instead of a real domain over HTTPS. That's
fine for you testing solo right now — auth tokens travel unencrypted,
which is not acceptable once real tenant/technician/PM logins or Stripe
data are involved. See "Moving to a real domain later" at the bottom
before inviting anyone.

Go through this one step at a time rather than pasting it all into a
terminal at once, and check each "Sanity check" before moving on — same
advice as FarmHand's version of this file, for the same reason.

## 1. Secrets

```bash
cd ~/PropertyManagement/deploy/selfhost
cp .env.example .env
nano .env
```

Fill in `POSTGRES_PASSWORD` and `JWT_SECRET` (see the comments in
`.env.example` for the exact `openssl` commands — note `POSTGRES_PASSWORD`
needs `-hex`, not `-base64`). Then mint the two API keys using that same
`JWT_SECRET`:

```bash
node mint-jwt.mjs "<paste JWT_SECRET here>" anon
node mint-jwt.mjs "<paste JWT_SECRET here>" service_role
```

Paste each result into `.env` as `ANON_KEY` and `SERVICE_ROLE_KEY`. Leave
the `SMTP_*` values blank for now if you don't have them handy —
`GOTRUE_MAILER_AUTOCONFIRM` is `true` in `docker-compose.yml`, so nothing
tries to send mail yet. `API_HOST`, `API_PORT`, and `FRONTEND_DEV_URL` are
already filled in with sensible values in `.env.example`; only change them
if your setup differs.

## 2. Bring up Postgres

```bash
docker compose up -d db
docker compose logs -f db
```

Give it 20–30 seconds on first boot, then Ctrl-C out of the log follow
once it settles (stops printing new lines).

```bash
bash set-role-passwords.sh
```

## 3. Start Auth

```bash
docker compose up -d auth
docker compose logs -f auth
```

**Sanity check** — no errors in that log, and:

```bash
docker compose exec db psql -U postgres -d postgres -c "\dn"
```

should list an `auth` schema.

## 4. Load PropertyManagement's schema

```bash
bash apply-schema.sh
```

Runs `db/schema.sql`, `db/seed.sql`, and every file in `db/migrations/` (none
yet — that's expected). **Sanity check**: the script's last line runs
`select auth.uid();` — it should print a blank/null row, not an error.

This is for this brand-new database only, run once. See "Applying a new
migration" under Day to day for after this.

## 5. Start the REST API

```bash
docker compose up -d rest
docker compose logs -f rest
```

**Sanity check**, from inside the VPS (bypasses nginx entirely, so a
failure here is about the containers, not what's in front of them):

```bash
source .env
curl -i "http://127.0.0.1:8002/properties?select=id&limit=1" -H "apikey: $ANON_KEY"
```

Expect `HTTP/1.1 200` and `[]` (no rows yet — nothing's been created).

## 6. nginx (no certbot — see the TEMPORARY note above)

```bash
sudo cp nginx-property-management-api.conf /etc/nginx/sites-available/property-management-api
sudo cp nginx-property-management-cors.conf /etc/nginx/conf.d/property-management-cors.conf
sudo ln -s /etc/nginx/sites-available/property-management-api /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

**Sanity check**, this time through the public port:

```bash
curl -i "http://15.204.120.16:8090/rest/v1/properties?select=id&limit=1" -H "apikey: $ANON_KEY"
```

Same expectation as step 5 — `200` and `[]`.

## 7. Point the frontend at it (once it exists)

```
VITE_SUPABASE_URL=http://15.204.120.16:8090
VITE_SUPABASE_ANON_KEY=<the ANON_KEY from .env>
```

## Day to day

```bash
cd ~/PropertyManagement/deploy/selfhost
docker compose ps                  # is everything up?
docker compose logs -f auth        # or rest, or db
docker compose restart rest        # or auth, or db
```

### Applying a new migration

```bash
cd ~/PropertyManagement
git pull
bash deploy/selfhost/apply-migrations.sh
```

Safe to run anytime, including when nothing's new.

## Backups

```bash
cd ~/PropertyManagement/deploy/selfhost
docker compose exec db pg_dump -U postgres postgres | gzip > ~/property-management-backup-$(date +%F).sql.gz
```

Worth a cron job or systemd timer once this is confirmed working — the
baseball site's `ibc-backup.timer` (in the IBC repo's `deploy/`) is a
working example to copy, and FarmHand's `check-disk.sh` timer already
watches this VPS's overall disk usage, which covers this stack's data too.

## Moving to a real domain later

Once a domain is bought and pointed at this VPS:

1. Add DNS: `api.<yourdomain> -> 15.204.120.16` (same pattern as
   `api.farmhandmanager.com`).
2. Update `.env`: `API_HOST=api.<yourdomain>`, drop `API_PORT` (or set it
   to 443), update `FRONTEND_DEV_URL` to the real deployed frontend
   origin. `docker compose up -d auth` to pick up the new
   `API_EXTERNAL_URL`/`GOTRUE_URI_ALLOW_LIST`.
3. Change `nginx-property-management-api.conf`'s `listen 8090` to
   `listen 80` and `server_name _;` to the real domain, then run
   `sudo certbot --nginx -d api.<yourdomain>` — certbot rewrites the file
   in place to add TLS and an http->https redirect, same as it did for
   FarmHand's.
4. Replace `nginx-property-management-cors.conf`'s permissive
   `default $http_origin;` with a real allowlist — copy FarmHand's
   `nginx-farmhand-cors.conf` as the template (apex + www each need their
   own map line).
5. Flip `GOTRUE_MAILER_AUTOCONFIRM` to `"false"` before any real tenant
   invite goes out, and fill in the `SMTP_*` values if not already done.
6. Update the frontend's `VITE_SUPABASE_URL` and redeploy it.
