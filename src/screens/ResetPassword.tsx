import { useState } from 'react'
import { supabase, describeError } from '../lib/supabase'

type Props = { onDone: () => void }

export function ResetPassword({ onDone }: Props) {
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!supabase) return
    setBusy(true)
    setError(null)
    const { error } = await supabase.auth.updateUser({ password })
    setBusy(false)
    if (error) setError(describeError(error))
    else onDone()
  }

  return (
    <div className="auth-page">
      <div className="auth-card">
        <h1>Choose a new password</h1>
        <form onSubmit={submit}>
          <div className="field">
            <label htmlFor="password">New password</label>
            <input
              id="password"
              type="password"
              autoComplete="new-password"
              required
              minLength={8}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>
          {error && <p className="error-text">{error}</p>}
          <button className="primary" type="submit" disabled={busy}>
            {busy ? 'Saving…' : 'Save password'}
          </button>
        </form>
      </div>
    </div>
  )
}
