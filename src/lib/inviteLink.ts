// Carries an invite token from the URL (?token=...) through the sign-up/
// login flow it triggers. sessionStorage rather than the URL itself, since
// the token needs to survive a redirect to /signup or /login and back.
const KEY = 'pm_pending_invite_token'

export function getUrlInviteToken(): string | null {
  return new URLSearchParams(window.location.search).get('token')
}

export function storePendingInviteToken(token: string): void {
  sessionStorage.setItem(KEY, token)
}

export function takePendingInviteToken(): string | null {
  const t = sessionStorage.getItem(KEY)
  if (t) sessionStorage.removeItem(KEY)
  return t
}
