// Carries an invite token from the URL (?token=...) through the sign-up or
// login flow it triggers — including the round trip out to a confirmation
// email and back.
//
// localStorage, not sessionStorage, which is what this used to be.
// sessionStorage is scoped to one tab, and GOTRUE_MAILER_AUTOCONFIRM is
// "false" (deploy/selfhost/docker-compose.yml), so signing up does not
// produce a session: the tenant confirms from their mail app, which opens
// a new tab and often a different browser entirely. The token stored while
// signing up was therefore gone by the moment a session finally existed to
// accept it with. The invite stayed pending, the tenant arrived with no
// membership, and Dashboard.tsx sent them to /setup — where they were told
// they are not permitted to create an organization. A dead end, reached by
// following the instructions exactly.
//
// localStorage fixes the same-browser case. The different-browser case is
// covered separately by SignUp.tsx, which points the confirmation email
// back at the invite link itself so the token returns in the URL.
const KEY = 'pm_pending_invite_token'

/** The invite link a token belongs in — the one thing that always works. */
export function inviteUrlFor(token: string): string {
  return `${window.location.origin}/accept-invite?token=${encodeURIComponent(token)}`
}

export function getUrlInviteToken(): string | null {
  return new URLSearchParams(window.location.search).get('token')
}

export function storePendingInviteToken(token: string): void {
  localStorage.setItem(KEY, token)
}

/**
 * The stored token without consuming it — for screens that need to know an
 * invite is in flight (to say so, or to aim a confirmation email at it)
 * but are not the ones accepting it.
 */
export function peekPendingInviteToken(): string | null {
  return localStorage.getItem(KEY)
}

export function takePendingInviteToken(): string | null {
  const t = localStorage.getItem(KEY)
  if (t) localStorage.removeItem(KEY)
  return t
}

export function clearPendingInviteToken(): void {
  localStorage.removeItem(KEY)
}
