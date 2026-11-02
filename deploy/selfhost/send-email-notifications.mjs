#!/usr/bin/env node
//
// Emails every notification that hasn't been emailed yet, through the same
// Brevo SMTP account GoTrue already uses for sign-up and password-reset mail
// (SMTP_* in this folder's .env). Run every two minutes by notify.sh, next
// to the push sender.
//
//   node send-email-notifications.mjs                     # send what's due
//   node send-email-notifications.mjs --test you@x.com    # check SMTP works
//
// Who gets each one follows who the notification is for (see
// db/migrations/023 and 031):
//   - addressed to a member (a technician told about a repair, a tenant
//     told their repair is booked) → that person
//   - addressed to nobody in particular → every active admin and property
//     manager in the organization
// Disabled members are never emailed.
//
// Same database access as send-request-notifications.mjs: docker compose
// exec psql, values passed as -v variables and referenced as :'name'.
//
// A failed send is retried on later ticks, up to MAX_ATTEMPTS, rather than
// marked done — Brevo having a bad minute shouldn't lose a repair alert.
// Exits silently when there's nothing to send.

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import nodemailer from 'nodemailer'

const HERE = dirname(fileURLToPath(import.meta.url))
const MAX_ATTEMPTS = 5
const BATCH = 50

function loadEnv(path) {
  const env = {}
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/)
    if (m) env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2')
  }
  return env
}

const env = loadEnv(join(HERE, '.env'))
for (const key of ['SMTP_HOST', 'SMTP_USER', 'SMTP_PASS', 'SMTP_ADMIN_EMAIL']) {
  if (!env[key]) {
    console.error(`${key} is not set in deploy/selfhost/.env — cannot send email.`)
    process.exit(1)
  }
}

const port = Number(env.SMTP_PORT || 587)
const transport = nodemailer.createTransport({
  host: env.SMTP_HOST,
  port,
  // 465 is TLS from the first byte; 587 (Brevo's default) upgrades with
  // STARTTLS, which nodemailer does on its own when secure is false.
  secure: port === 465,
  auth: { user: env.SMTP_USER, pass: env.SMTP_PASS },
})

const appUrl = (env.APP_URL || '').replace(/\/+$/, '')

function psql(sql, vars = {}) {
  const args = ['compose', 'exec', '-T', 'db', 'psql', '-U', 'postgres', '-d', 'postgres', '-qtAX']
  for (const [key, value] of Object.entries(vars)) args.push('-v', `${key}=${value}`)
  return execFileSync('docker', args, { cwd: HERE, input: sql, encoding: 'utf8' })
}

const escapeHtml = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

function compose({ orgName, title, body, link, urgency }) {
  const url = link && appUrl ? `${appUrl}${link}` : appUrl || null
  const text = [body, url ? `Open: ${url}` : null,
    '', `— ${orgName}`].filter((l) => l !== null).join('\n\n')
  const html = `<!doctype html><html><body style="margin:0;padding:24px;background:#f5f6f8;font-family:-apple-system,Segoe UI,Roboto,sans-serif;color:#1d2330">
  <div style="max-width:520px;margin:0 auto;background:#fff;border:1px solid #e3e6ec;border-radius:10px;padding:24px">
    ${urgency === 'high' ? '<div style="color:#b42318;font-weight:600;font-size:13px;text-transform:uppercase;letter-spacing:.04em;margin-bottom:8px">Urgent</div>' : ''}
    <h1 style="font-size:18px;margin:0 0 12px">${escapeHtml(title)}</h1>
    ${body ? `<p style="font-size:15px;line-height:1.5;margin:0 0 20px">${escapeHtml(body)}</p>` : ''}
    ${url ? `<a href="${escapeHtml(url)}" style="display:inline-block;background:#3d63dd;color:#fff;text-decoration:none;font-weight:600;padding:10px 18px;border-radius:8px">Open in the app</a>` : ''}
    <p style="font-size:12px;color:#6b7280;margin:24px 0 0">${escapeHtml(orgName)}</p>
  </div></body></html>`
  return { text, html }
}

function from(orgName) {
  // The organization's name as the sender name, so the inbox says who it's
  // from; the address must be the Brevo-verified SMTP_ADMIN_EMAIL.
  return { name: orgName || 'Property Management', address: env.SMTP_ADMIN_EMAIL }
}

// ------------------------------------------------------------- --test --

const testIdx = process.argv.indexOf('--test')
if (testIdx !== -1) {
  const to = process.argv[testIdx + 1]
  if (!to) {
    console.error('Usage: node send-email-notifications.mjs --test you@example.com')
    process.exit(1)
  }
  const { text, html } = compose({
    orgName: 'Property Management', title: 'Test email',
    body: 'If you can read this, notification emails are working.', link: '/dashboard',
  })
  await transport.sendMail({ from: from('Property Management'), to, subject: 'Test email', text, html })
  console.log(`Sent a test email to ${to}.`)
  process.exit(0)
}

// ----------------------------------------------------------- the queue --

const due = JSON.parse(psql(`
  select coalesce(jsonb_agg(row order by row.created_at), '[]') from (
    select n.id, n.title, n.body, n.link, n.urgency, n.created_at, n.email_attempts,
           o.name as org_name,
           (select coalesce(jsonb_agg(distinct u.email), '[]')
              from org_members om
              join auth.users u on u.id = om.user_id
             where om.organization_id = n.organization_id
               and om.status = 'active'
               and u.email is not null
               and (case when n.org_member_id is not null
                         then om.id = n.org_member_id
                         else om.role in ('admin', 'property_manager') end)
           ) as recipients
      from notifications n
      join organizations o on o.id = n.organization_id
     where n.emailed_at is null
       and n.email_attempts < ${MAX_ATTEMPTS}
     order by n.created_at
     limit ${BATCH}
  ) row;
`).trim())

if (due.length === 0) process.exit(0)

let sent = 0
for (const n of due) {
  const { text, html } = compose({
    orgName: n.org_name, title: n.title, body: n.body, link: n.link, urgency: n.urgency,
  })
  const subject = n.urgency === 'high' && !/urgent/i.test(n.title) ? `[Urgent] ${n.title}` : n.title

  let failed = false
  // One message per person, so nobody sees who else was told.
  for (const to of n.recipients) {
    try {
      await transport.sendMail({ from: from(n.org_name), to, subject, text, html })
      sent++
    } catch (err) {
      failed = true
      console.error(`email for notification ${n.id} to ${to} failed: ${err.message}`)
    }
  }

  if (failed) {
    psql(`update notifications set email_attempts = email_attempts + 1 where id = :'id';`, { id: n.id })
    if (n.email_attempts + 1 >= MAX_ATTEMPTS) {
      console.error(`giving up on emailing notification ${n.id} after ${MAX_ATTEMPTS} attempts`)
    }
  } else {
    psql(`update notifications set emailed_at = now() where id = :'id';`, { id: n.id })
  }
}

if (sent > 0) console.log(`emailed ${sent} message(s) for ${due.length} notification(s)`)
