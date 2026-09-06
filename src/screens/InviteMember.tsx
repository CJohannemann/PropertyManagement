import { errorMessage } from '../lib/supabase'
import { useState } from 'react'
import { createInvite, type OrgRole } from '../lib/org'
import { inviteUrlFor } from '../lib/inviteLink'

type Props = { onDone: () => void }

/**
 * Inviting someone to help run the organization — another admin, a
 * property manager, or a technician.
 *
 * Tenants are not offered here. A tenant invite has to be bound to a
 * lease (create_invite() refuses one without), which is why it lives on
 * the lease itself in InviteTenant.tsx. The two look similar and are not
 * the same act: this one hands over the keys to the business.
 *
 * Only shown to admins. create_invite() enforces that server-side too — a
 * property manager may invite tenants and nothing else — so this is the
 * polite half of a rule that holds without it.
 */
const ROLES: { value: OrgRole; label: string; blurb: string }[] = [
  {
    value: 'admin',
    label: 'Admin',
    blurb: 'Full access, including properties, money, and inviting others.',
  },
  {
    value: 'property_manager',
    label: 'Property manager',
    blurb: 'Runs the day to day: leases, tenants, rent, and repairs. Cannot add or remove units.',
  },
  {
    value: 'technician',
    label: 'Technician',
    blurb: 'Sees only the repair jobs assigned to them.',
  },
]

export function InviteMember({ onDone }: Props) {
  const [email, setEmail] = useState('')
  const [fullName, setFullName] = useState('')
  const [role, setRole] = useState<OrgRole>('property_manager')
  const [link, setLink] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      // No lease id: only a tenant invite is bound to one.
      const { token } = await createInvite(email, role, undefined, fullName)
      setLink(inviteUrlFor(token))
    } catch (err) {
      setError(errorMessage(err))
    }
    setBusy(false)
  }

  if (link) {
    return (
      <div className="card-list">
        <div>
          <h3 style={{ marginTop: 0 }}>Invite created</h3>
          <p className="muted">
            Send this link to {email}. It expires in 7 days and can only be
            used once. They need to open it with the same email address —
            creating an account on its own won't join them to anything.
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

  const chosen = ROLES.find((r) => r.value === role)!

  return (
    <form onSubmit={submit} className="card-list">
      <div>
        <h3 style={{ marginTop: 0 }}>Invite someone to the team</h3>
        <div className="field">
          <label htmlFor="im-name">Their full name</label>
          <input id="im-name" type="text" required value={fullName}
            onChange={(e) => setFullName(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="im-email">Their email</label>
          <input id="im-email" type="email" required value={email}
            onChange={(e) => setEmail(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="im-role">Role</label>
          <select id="im-role" value={role}
            onChange={(e) => setRole(e.target.value as OrgRole)}>
            {ROLES.map((r) => (
              <option key={r.value} value={r.value}>{r.label}</option>
            ))}
          </select>
          {/* What the role actually means, next to the choice. Picking
              "Admin" from a bare list gives no hint that it hands over
              everything. */}
          <span className="muted">{chosen.blurb}</span>
        </div>
        {role === 'admin' && (
          <p className="muted">
            An admin can do everything you can, including inviting and
            removing other people.
          </p>
        )}
        {error && <p className="error-text">{error}</p>}
        <button className="primary" type="submit" disabled={busy}>
          {busy ? 'Creating…' : 'Create invite link'}
        </button>
        <button className="link" type="button" onClick={onDone}
          style={{ marginTop: '0.5rem' }}>
          Cancel
        </button>
      </div>
    </form>
  )
}
