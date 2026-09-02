# Deploying

The app is served entirely from **one** hostname:
`https://properties.farmhandmanager.com` — the site at `/`, PostgREST at
`/rest/v1`, GoTrue at `/auth/v1`. One origin means no CORS at all, which
removes a whole category of bug rather than configuring around it (see the
header of `nginx-property-management.conf`).

The backend containers are [`selfhost/README.md`](selfhost/README.md).
This file covers nginx, TLS, and the frontend build.

## Moving to (or setting up) the domain

**1. DNS.** At the registrar holding `farmhandmanager.com`, add:

```
properties.farmhandmanager.com   A   15.204.120.16
```

Wait for it to resolve before continuing — certbot proves domain ownership
over HTTP and will fail if DNS hasn't propagated:

```bash
dig +short properties.farmhandmanager.com
```

**2. Point both .env files at it** (they must agree, and the old
`API_HOST`/`API_PORT` variables were replaced by a single `APP_URL`):

```bash
cd ~/PropertyManagement
bash deploy/set-domain.sh
bash deploy/link-env.sh
```

**3. Build the site** — nginx serves `dist/` directly, so this has to
exist before nginx is pointed at it:

```bash
bash deploy/deploy.sh
```

**4. nginx, then the certificate:**

```bash
sudo cp deploy/nginx-property-management.conf /etc/nginx/sites-available/property-management
sudo ln -sf /etc/nginx/sites-available/property-management /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d properties.farmhandmanager.com
```

**5. Remove the old plain-HTTP listeners.** Until this is done the API is
still reachable unencrypted on port 8090, which defeats the point of the
certificate:

```bash
sudo rm -f /etc/nginx/sites-enabled/property-management-api
sudo rm -f /etc/nginx/conf.d/property-management-cors.conf
sudo nginx -t && sudo systemctl reload nginx
```

**6. Restart Auth** so GoTrue picks up the new `APP_URL` — it builds
confirmation and password-reset links from it:

```bash
cd ~/PropertyManagement/deploy/selfhost && docker compose up -d auth
```

**Sanity check:**

```bash
curl -sI https://properties.farmhandmanager.com | head -1
curl -s https://properties.farmhandmanager.com/auth/v1/health
```

Expect `HTTP/2 200` and GoTrue's version JSON.

## Automatic deploys

A systemd timer checks GitHub every 2 minutes and rebuilds when there are
new commits, so pushing is all that's needed. Scoped entirely to this app;
FarmHand and the baseball site are untouched.

```bash
sudo cp deploy/property-management-deploy.service /etc/systemd/system/
sudo cp deploy/property-management-deploy.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now property-management-deploy.timer
```

Useful afterwards:

```bash
systemctl list-timers property-management-deploy.timer   # next run
journalctl -u property-management-deploy.service -f      # watch deploys
sudo systemctl disable --now property-management-deploy.timer
```

With nothing new to deploy it exits silently, so an empty log is the
correct result, not a failure.

### It does not apply database migrations

Deliberately. Rebuilding a frontend unattended is safe; changing a live
schema holding tenant and payment data is not — an unattended migration
that goes wrong at 3am gets discovered by a tenant, not by you. When a
pulled commit adds files under `db/migrations/`, the deploy log says so
loudly and leaves them:

```bash
cd ~/PropertyManagement && bash deploy/selfhost/apply-migrations.sh
```

### If deploys stop happening

`auto-deploy.sh` needs `npm` on PATH; systemd's PATH is minimal, so it
looks for npm and falls back to sourcing nvm, failing loudly rather than
quietly doing nothing. A failed run is recorded in the journal and nowhere
else — check there first.

## Security posture

Done:

- **HTTPS** on one origin, with the plain-HTTP listeners removed.
- **Organization creation is allowlisted** in the database
  (`db/migrations/003_restrict_org_creation.sql`), so a stranger who signs
  up lands on a dead end instead of getting their own org on this server.
- **Email confirmation required** (`GOTRUE_MAILER_AUTOCONFIRM=false`).
- **The frontend refuses a non-https backend URL** unless it's localhost,
  so a misconfigured deploy fails visibly instead of sending session
  tokens in the clear.
- **Nothing binds publicly except nginx** — Postgres, PostgREST and GoTrue
  all listen on 127.0.0.1 only.

Still open:

- **Backups aren't automated.** See `selfhost/README.md`; worth a systemd
  timer before real tenant data lands.
- **`payments` has no client-facing insert policy**, which is correct —
  but it means the Stripe webhook handler must run server-side with the
  service-role key. That service doesn't exist yet.
