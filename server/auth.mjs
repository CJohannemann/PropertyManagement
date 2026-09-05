// Who is calling.
//
// The browser sends the same Supabase/GoTrue access token it already uses
// for PostgREST, signed HS256 with JWT_SECRET. Verifying it here gives a
// user id — and nothing more. Every route then re-derives that user's
// actual authority from the database, because a JWT says who someone is,
// not what they are allowed to do with someone else's rent.

import jwt from 'jsonwebtoken'
import { config } from './config.mjs'
import { query } from './db.mjs'

export class HttpError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

/** Populates req.userId, or throws 401. */
export function requireUser(req, _res, next) {
  const header = req.get('authorization') || ''
  const token = header.startsWith('Bearer ') ? header.slice(7) : null
  if (!token) throw new HttpError(401, 'Not signed in')

  let claims
  try {
    claims = jwt.verify(token, config.jwtSecret, { algorithms: ['HS256'] })
  } catch {
    // Deliberately not echoing the library's reason back to the caller —
    // "expired" vs "bad signature" is useful to an attacker and not to a
    // user, who needs to sign in again either way.
    throw new HttpError(401, 'Your session has expired — sign in again')
  }

  if (!claims.sub) throw new HttpError(401, 'Token has no subject')
  req.userId = claims.sub
  next()
}

/**
 * The caller's active membership of the organization that owns `orgId`,
 * or throws. Read from the database every time rather than from the
 * token: a role revoked a minute ago must not still work because the
 * token is good for another hour.
 */
export async function requireOrgRole(userId, orgId, roles) {
  const { rows } = await query(
    `select id, role from org_members
      where organization_id = $1 and user_id = $2 and status = 'active'`,
    [orgId, userId],
  )
  const member = rows[0]
  if (!member || !roles.includes(member.role)) {
    throw new HttpError(403, 'You do not have permission to do that')
  }
  return member
}
