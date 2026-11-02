import { useState } from 'react'
import { errorMessage } from '../lib/supabase'
import { confirmWithCode, resendConfirmation } from '../lib/authLinks'

/**
 * Confirming an email address with the 6-digit code from the confirmation
 * email — the fallback for a link that can't be used (opened on another
 * device, or already spent by a work email system's link scanner).
 *
 * Signing in is the success state: once verified there is a session, and
 * the screen this sits on (or App.tsx) moves on by itself.
 */
export function ConfirmCode({ initialEmail = '' }: { initialEmail?: string }) {
  const [email, setEmail] = useState(initialEmail)
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState<'verify' | 'resend' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [resent, setResent] = useState(false)

  async function verify(e: React.FormEvent) {
    e.preventDefault()
    setBusy('verify')
    setError(null)
    try {
      await confirmWithCode(email, code)
      // Stays "busy": the session change navigates away from here.
    } catch (err) {
      setError(friendly(errorMessage(err)))
      setBusy(null)
    }
  }

  async function resend() {
    if (!email.trim()) {
      setError('Enter your email address first.')
      return
    }
    setBusy('resend')
    setError(null)
    try {
      await resendConfirmation(email)
      setResent(true)
      setCode('')
    } catch (err) {
      setError(friendly(errorMessage(err)))
    }
    setBusy(null)
  }

  return (
    <form onSubmit={verify} style={{ marginTop: '1rem' }}>
      {!initialEmail && (
        <div className="field">
          <label htmlFor="cc-email">Email</label>
          <input id="cc-email" type="email" autoComplete="email" required value={email}
            onChange={(e) => setEmail(e.target.value)} />
        </div>
      )}
      <div className="field">
        <label htmlFor="cc-code">Code from the email</label>
        <input id="cc-code" inputMode="numeric" autoComplete="one-time-code" required
          pattern="[0-9 ]{6,8}" maxLength={8} placeholder="123456" value={code}
          onChange={(e) => setCode(e.target.value)}
          style={{ letterSpacing: '0.3em', fontSize: '1.2rem' }} />
      </div>
      {error && <p className="error-text">{error}</p>}
      {resent && !error && (
        <p className="muted">A new email is on its way — use the code in that one.</p>
      )}
      <button className="primary" type="submit" disabled={busy !== null}>
        {busy === 'verify' ? 'Checking…' : 'Confirm'}
      </button>
      <button className="link" type="button" disabled={busy !== null} onClick={resend}
        style={{ marginTop: '0.75rem' }}>
        {busy === 'resend' ? 'Sending…' : 'Send a new code'}
      </button>
    </form>
  )
}

function friendly(msg: string): string {
  if (/expired|invalid/i.test(msg)) {
    return 'That code has expired or was already used. Tap "Send a new code" for a fresh one.'
  }
  if (/rate|too many|seconds/i.test(msg)) {
    return 'Too many tries — wait a minute, then try again.'
  }
  return msg
}
