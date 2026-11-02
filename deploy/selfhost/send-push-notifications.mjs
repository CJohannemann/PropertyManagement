#!/usr/bin/env node
//
// Pushes a browser/phone notification for every notification that hasn't
// been pushed yet, to the devices of whoever it is for — the same rule as
// send-email-notifications.mjs:
//   - addressed to a member (a technician told about a repair at their
//     property or offered a job, a tenant told their repair is booked)
//     → that member's devices
//   - addressed to nobody in particular → every active admin and property
//     manager's devices
// Only people who turned notifications on in the app have a device to push
// to; everyone else still has the bell and the email.
//
// Run every two minutes by notify.sh. Same database access as the email
// sender: docker compose exec psql, values passed as -v variables and
// referenced as :'name', never interpolated into the SQL string.
//
//   node send-push-notifications.mjs
//
// Exits silently when there's nothing new to send.

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import webpush from 'web-push'

const HERE = dirname(fileURLToPath(import.meta.url))
const BATCH = 100

function loadEnv(path) {
  const env = {}
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/)
    if (m) env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2')
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

// A push about something from yesterday is noise, not an alert — if the
// box was down that long, the bell and the email have it. Those are marked
// done without buzzing anyone's phone.
psql(`update notifications set pushed_at = now()
       where pushed_at is null and created_at < now() - interval '1 day';`)

const due = JSON.parse(psql(`
  select coalesce(jsonb_agg(row order by row.created_at), '[]') from (
    select n.id, n.title, n.body, n.link, n.urgency, n.created_at,
           (select coalesce(jsonb_agg(jsonb_build_object(
                     'id', ps.id, 'endpoint', ps.endpoint, 'p256dh', ps.p256dh, 'auth', ps.auth
                   )), '[]')
              from push_subscriptions ps
              join org_members om on om.id = ps.org_member_id
             where om.organization_id = n.organization_id
               and om.status = 'active'
               and (case when n.org_member_id is not null
                         then om.id = n.org_member_id
                         else om.role in ('admin', 'property_manager') end)
           ) as subscriptions
      from notifications n
     where n.pushed_at is null
     order by n.created_at
     limit ${BATCH}
  ) row;
`).trim())

if (due.length === 0) process.exit(0)

let pushed = 0
for (const n of due) {
  const payload = JSON.stringify({
    title: n.title,
    body: n.body ?? '',
    link: n.link ?? '/dashboard',
    // Same id → a newer push replaces the older one on the lock screen
    // instead of stacking, should one ever be sent twice.
    tag: n.id,
    urgent: n.urgency === 'high',
  })

  for (const sub of n.subscriptions) {
    try {
      await webpush.sendNotification(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        payload,
        { TTL: 60 * 60 * 24, urgency: n.urgency === 'high' ? 'high' : 'normal' },
      )
      pushed++
    } catch (err) {
      // 404/410 means the push service itself says this subscription is
      // gone (browser data cleared, notifications revoked, app removed
      // from the home screen) — remove it. Anything else (a momentary
      // network or 5xx failure) is left alone so one bad tick doesn't
      // silently unsubscribe someone.
      if (err.statusCode === 404 || err.statusCode === 410) {
        psql(`delete from push_subscriptions where id = :'id';`, { id: sub.id })
      } else {
        console.error(`push to subscription ${sub.id} failed: ${err.statusCode ?? err.message}`)
      }
    }
  }

  // Marked whether or not anyone had a device: push is best-effort on top
  // of the bell and email, and retrying a dead push every two minutes
  // would only delay the alerts behind it.
  psql(`update notifications set pushed_at = now() where id = :'id';`, { id: n.id })
}

if (pushed > 0) console.log(`pushed ${pushed} notification(s) to devices`)
