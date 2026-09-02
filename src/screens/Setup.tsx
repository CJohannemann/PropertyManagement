import { useState } from 'react'
import { createOrganization } from '../lib/org'
import { navigate } from '../lib/route'

/** First-run screen for a brand-new account with no organization yet. */
export function Setup() {
  const [name, setName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await createOrganization(name)
      navigate('/dashboard', { replace: true })
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setBusy(false)
    }
  }

  return (
    <div className="auth-page">
      <div className="auth-card">
        <h1>Name your organization</h1>
        <p className="muted" style={{ marginBottom: '1rem' }}>
          This is the account your properties, staff, and tenants will all
          live under — e.g. your name or the name of your rental business.
        </p>
        <form onSubmit={submit}>
          <div className="field">
            <label htmlFor="org-name">Organization name</label>
            <input
              id="org-name"
              type="text"
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          {error && <p className="error-text">{error}</p>}
          <button className="primary" type="submit" disabled={busy}>
            {busy ? 'Creating…' : 'Create organization'}
          </button>
        </form>
      </div>
    </div>
  )
}
