#!/usr/bin/env node
//
// Mints an HS256 JWT for the self-hosted Supabase stack — the "anon" and
// "service_role" keys are just long-lived JWTs signed with JWT_SECRET, not
// anything issued by a service. No dependency needed: HS256 is a base64url
// header + payload, HMAC-SHA256 signed, which Node's own crypto covers.
//
//   node mint-jwt.mjs <jwt-secret> anon
//   node mint-jwt.mjs <jwt-secret> service_role
import crypto from 'crypto'

const [, , secret, role] = process.argv
if (!secret || !role) {
  console.error('Usage: node mint-jwt.mjs <jwt-secret> <anon|service_role>')
  process.exit(1)
}

const b64url = (buf) =>
  buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

const now = Math.floor(Date.now() / 1000)
const header = { alg: 'HS256', typ: 'JWT' }
const payload = {
  role,
  iss: 'supabase',
  iat: now,
  // 10 years — this is a self-hosted personal instance, not a fleet of
  // rotating credentials. Regenerate (and redeploy the frontend with the
  // new anon key) if JWT_SECRET is ever rotated.
  exp: now + 60 * 60 * 24 * 365 * 10,
}

const signingInput = `${b64url(Buffer.from(JSON.stringify(header)))}.${b64url(Buffer.from(JSON.stringify(payload)))}`
const signature = b64url(crypto.createHmac('sha256', secret).update(signingInput).digest())

console.log(`${signingInput}.${signature}`)
