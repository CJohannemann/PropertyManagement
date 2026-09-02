import { useState } from 'react'
import { createInvite } from '../lib/org'

type Props = { leaseId: string; onDone: () => void }

export function InviteTenant({ leaseId, onDone }: Props) {
  const [email, setEmail] = useState('')
  const [link, setLink] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const { token } = await createInvite(email, 'tenant', leaseId)
      // Shown as a copyable link rather than emailed: GoTrue's SMTP isn't
      // configured yet, and an invite that silently fails to send is worse
      // than one you hand over yourself.
      setLink(`${window.location.origin}/accept-invite?token=${token}`)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
    setBusy(false)
  }

  if (link) {
    return (
      <div className="card-list" style={{ marginTop: '1rem' }}>
        <div>
          <h3 style={{ marginTop: 0 }}>Invite created</h3>
          <p className="muted">
            Send this link to {email}. It expires in 7 days and can only be
            used once.
          </p>
          <input readOnly value={link} onClick={(e) => e.currentTarget.select()}
            style={{ width: '100%', padding: '0.5rem' }} />
          <button className="primary" style={{ marginTop: '0.75rem' }} onClick={onDone}>
            Done
          </button>
        </div>
      </div>
    )
  }

  return (
    <form onSubmit={submit} className="card-list" style={{ marginTop: '1rem' }}>
      <div>
        <h3 style={{ marginTop: 0 }}>Invite a tenant</h3>
        <div className="field">
          <label htmlFor="inv-email">Tenant's email</label>
          <input id="inv-email" type="email" required value={email}
            onChange={(e) => setEmail(e.target.value)} />
        </div>
        {error && <p className="error-text">{error}</p>}
        <button className="primary" type="submit" disabled={busy}>
          {busy ? 'Creating…' : 'Create invite link'}
        </button>
        <button className="link" type="button" onClick={onDone} style={{ marginTop: '0.5rem' }}>
          Cancel
        </button>
      </div>
    </form>
  )
}
