#!/usr/bin/env node
//
// Checks for maintenance requests nobody has been alerted to yet and pushes
// a browser notification to every admin/property manager in that org. Run
// on a timer by property-management-notify.{service,timer} (see
// deploy/README.md) — checking every couple of minutes rather than trying
// to react instantly, since this runs as a server-side script rather than
// something a phone can be trusted to do for itself in the background.
//
// Talks to Postgres the same way deploy/create-test-user.sh does — through
// `docker compose exec db psql`, SQL on stdin, values passed as `-v`
// variables and referenced as :'name', never interpolated into the SQL
// string. See that script's header for why interpolation is the trap here.
//
//   node send-request-notifications.mjs
//
// Exits silently (status 0) when there's nothing new to send, so a cron
// log only carries entries for runs that actually pushed something.

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import webpush from 'web-push'

const HERE = dirname(fileURLToPath(import.meta.url))

function loadEnv(path) {
  const env = {}
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/)
    if (m) env[m[1]] = m[2]
  }
  return env
}

const env = loadEnv(join(HERE, '.env'))
if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY || !env.VAPID_SUBJECT) {
  console.error('VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY / VAPID_SUBJECT are not all set in .env — nothing to send with.')
  process.exit(1)
}
webpush.setVapidDetails(env.VAPID_SUBJECT, env.VAPID_PUBLIC_KEY, env.VAPID_PRIVATE_KEY)

function psql(sql, vars = {}) {
  const args = ['compose', 'exec', '-T', 'db', 'psql', '-U', 'postgres', '-d', 'postgres', '-qtAX']
  for (const [key, value] of Object.entries(vars)) args.push('-v', `${key}=${value}`)
  return execFileSync('docker', args, { cwd: HERE, input: sql, encoding: 'utf8' })
}

const requests = JSON.parse(psql(`
  select coalesce(jsonb_agg(row), '[]') from (
    select mr.id, mr.priority, mr.category, u.label as unit_label, p.name as property_name,
           (select coalesce(jsonb_agg(jsonb_build_object(
                     'id', ps.id, 'endpoint', ps.endpoint, 'p256dh', ps.p256dh, 'auth', ps.auth
                   )), '[]')
              from push_subscriptions ps
              join org_members om on om.id = ps.org_member_id
             where om.organization_id = p.organization_id
               and om.role in ('admin', 'property_manager')
               and om.status = 'active') as subscriptions
      from maintenance_requests mr
      join units u on u.id = mr.unit_id
      join properties p on p.id = u.property_id
     where mr.status = 'open' and mr.notified_at is null
  ) row;
`).trim())

if (requests.length === 0) process.exit(0)

for (const request of requests) {
  const title = request.priority === 'urgent'
    ? 'Urgent maintenance request'
    : 'New maintenance request'
  const location = [request.property_name, request.unit_label].filter(Boolean).join(' · ')
  const payload = JSON.stringify({
    title,
    body: `${location} — ${request.category}`,
    requestId: request.id,
  })

  for (const sub of request.subscriptions) {
    try {
      await webpush.sendNotification(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        payload,
      )
    } catch (err) {
      // 404/410 means the push service itself says this subscription is
      // gone (browser data cleared, notifications revoked, etc.) — remove
      // it. Anything else (a momentary network or 5xx failure) is left
      // alone so one bad tick doesn't silently unsubscribe someone.
      if (err.statusCode === 404 || err.statusCode === 410) {
        psql(`delete from push_subscriptions where id = :'id';`, { id: sub.id })
      } else {
        console.error(`push to subscription ${sub.id} failed: ${err.statusCode ?? err.message}`)
      }
    }
  }

  psql(`update maintenance_requests set notified_at = now() where id = :'id';`, { id: request.id })
  console.log(`notified ${request.subscriptions.length} subscriber(s) about request ${request.id}`)
}
