# Deploying the frontend

The backend (Postgres/PostgREST/GoTrue) is a separate thing entirely —
see `selfhost/README.md` for that.

## One-time setup on the VPS

```bash
cd ~
git clone https://github.com/CJohannemann/PropertyManagement.git
cd ~/PropertyManagement
bash deploy/link-env.sh          # fills .env from deploy/selfhost/.env
bash deploy/deploy.sh            # install + build
```

Then nginx, which serves `dist/` on port 8080:

```bash
sudo cp deploy/nginx-property-management.conf /etc/nginx/sites-available/property-management
sudo ln -s /etc/nginx/sites-available/property-management /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

The site is then at `http://15.204.120.16:8080`.

## Automatic deploys

A systemd timer checks GitHub every 2 minutes and rebuilds when there are
new commits, so pushing is all that's needed — no command on the server.
This is scoped entirely to this app; FarmHand and the baseball site are
untouched by it.

```bash
sudo cp deploy/property-management-deploy.service /etc/systemd/system/
sudo cp deploy/property-management-deploy.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now property-management-deploy.timer
```

**Sanity check** — run it once by hand and read the log:

```bash
sudo systemctl start property-management-deploy.service
journalctl -u property-management-deploy.service -n 30 --no-pager
```

With nothing new to deploy it exits silently, so an empty log here is the
correct result, not a failure. To see it actually do something, push a
commit and check again a couple of minutes later.

Useful afterwards:

```bash
systemctl list-timers property-management-deploy.timer   # when does it next run?
journalctl -u property-management-deploy.service -f      # watch deploys live
sudo systemctl disable --now property-management-deploy.timer   # turn it off
```

### It does not apply database migrations

Deliberately. A frontend rebuild is safe unattended; a schema change
against a live database with real tenant and payment data is not. When a
pulled commit adds files under `db/migrations/`, the deploy log says so
loudly and leaves them for you:

```bash
cd ~/PropertyManagement && bash deploy/selfhost/apply-migrations.sh
```

### If deploys stop happening

The timer runs `deploy/auto-deploy.sh`, which needs `npm` on PATH.
systemd uses a minimal PATH, so the script looks for npm and falls back to
sourcing nvm; if neither is found it fails loudly rather than quietly
doing nothing. Check the journal first — a failed run is recorded there,
not anywhere visible in the app.

## Still to do before real users

- **HTTPS.** Everything is plain HTTP on a bare IP right now, so auth
  tokens travel unencrypted. See `selfhost/README.md`'s "Moving to a real
  domain later" — it covers both the API and this frontend config.
- **Close signup.** `GOTRUE_DISABLE_SIGNUP` is `false` and
  `GOTRUE_MAILER_AUTOCONFIRM` is `true`, so anyone who finds the IP can
  create an account. Fine while it's empty and unknown; not fine with real
  tenant data in it.
- **Password-reset links point at localhost.** `FRONTEND_DEV_URL` in
  `selfhost/.env` is still Vite's dev URL, and GoTrue builds reset links
  from it — so those emails would send people to their own machine. Update
  it to the real frontend URL (`http://15.204.120.16:8080` for now) and
  `docker compose up -d auth` to pick it up.
