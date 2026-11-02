import { supabase } from './supabase'
import { inviteUrlFor, getUrlInviteToken, peekPendingInviteToken } from './inviteLink'

/**
 * What GoTrue said when an email link didn't work.
 *
 * A confirmation or reset link that has expired or was already used comes
 * back with the reason in the URL fragment — #error=access_denied
 * &error_code=otp_expired&error_description=... — and no session. Nothing
 * read it, so the visitor landed on a screen offering "Create account" for
 * an account they had already created.
 *
 * The usual cause is not the visitor at all: work email systems (Outlook
 * Safe Links, Mimecast, Proofpoint) open every link in a message to scan
 * it, which spends a one-time link before a person ever clicks it.
 *
 * Read once, when the app loads, because navigate() replaces the URL
 * without its fragment and the reason would be gone by the time the
 * screen that needs it renders.
 */
export type AuthLinkError = { code: string; description: string }

function readHashError(): AuthLinkError | null {
  if (typeof window === 'undefined') return null
  const hash = new URLSearchParams(window.location.hash.replace(/^#/, ''))
  const code = hash.get('error_code') ?? hash.get('error')
  if (!code) return null
  return {
    code,
    description: (hash.get('error_description') ?? '').replace(/\+/g, ' '),
  }
}

// Not consumed on read: StrictMode runs state initializers twice, and a
// take-once getter handed the second render nothing. It lasts until the
// next page load, which is the life of the link that caused it.
const linkError: AuthLinkError | null = readHashError()

/** The link error the app was opened with, if any. */
export function authLinkError(): AuthLinkError | null {
  return linkError
}

/** Plain words for it — the raw descriptions read like server logs. */
export function describeLinkError(e: AuthLinkError): string {
  if (/expired|invalid|otp/i.test(`${e.code} ${e.description}`)) {
    return 'That email link has expired or was already used. Work email systems '
      + 'often open links to scan them, which uses up a one-time link before you '
      + 'click it. Use the code from the same email instead, or get a new one.'
  }
  return e.description || 'That email link didn\u2019t work.'
}

/** Where a confirmation email should send someone back to. */
function confirmRedirect(): string | undefined {
  const token = getUrlInviteToken() ?? peekPendingInviteToken()
  return token ? inviteUrlFor(token) : undefined
}

/**
 * Confirms an address with the 6-digit code from the email, for when the
 * link can't be used — opened on another device, or already spent by a
 * mail scanner. Success signs the person in; App.tsx and AcceptInvite take
 * it from there, including accepting a pending invite.
 */
export async function confirmWithCode(email: string, code: string): Promise<void> {
  if (!supabase) throw new Error('Supabase not configured')
  const { error } = await supabase.auth.verifyOtp({
    email: email.trim(), token: code.replace(/\s+/g, ''), type: 'signup',
  })
  if (error) throw error
}

/** Sends a fresh confirmation email (new link, new code). */
export async function resendConfirmation(email: string): Promise<void> {
  if (!supabase) throw new Error('Supabase not configured')
  const redirect = confirmRedirect()
  const { error } = await supabase.auth.resend({
    type: 'signup',
    email: email.trim(),
    options: redirect ? { emailRedirectTo: redirect } : undefined,
  })
  if (error) throw error
}

/**
 * Emails a password-reset link. The link signs the person in and fires
 * PASSWORD_RECOVERY, which useSession turns into the ResetPassword screen.
 */
export async function sendPasswordReset(email: string): Promise<void> {
  if (!supabase) throw new Error('Supabase not configured')
  const { error } = await supabase.auth.resetPasswordForEmail(email.trim(), {
    redirectTo: `${window.location.origin}/login`,
  })
  if (error) throw error
}
