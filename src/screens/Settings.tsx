import { errorMessage } from '../lib/supabase'
import { useEffect, useState } from 'react'
import { fetchOrgMembers, type Membership } from '../lib/org'
import { useThemePreference, THEME_CHOICES } from '../lib/theme'
import { LeaseTemplates } from './LeaseTemplates'
import { InviteMember } from './InviteMember'

type Props = {
  organizationId: string
  /** Admins invite staff; property managers can only invite tenants. */
  canInviteMembers: boolean
  onBack: () => void
}

const ROLE_LABEL: Record<Membership['role'], string> = {
  admin: 'Admin',
  property_manager: 'Property manager',
  technician: 'Technician',
  tenant: 'Tenant',
}

/**
 * The settings screen.
 *
 * /settings used to render the lease templates editor and nothing else,
 * which made "Settings" a synonym for one feature and left no home for
 * anything organization-wide that came after it. It is a hub now: the
 * templates are one entry in it rather than the whole of it.
 */
export function Settings({ organizationId, canInviteMembers, onBack }: Props) {
  const [showTemplates, setShowTemplates] = useState(false)
  const [inviting, setInviting] = useState(false)
  const [members, setMembers] = useState<Membership[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [theme, setTheme] = useThemePreference()

  function loadMembers() {
    fetchOrgMembers(organizationId)
      .then(setMembers)
      .catch((e) => setError(errorMessage(e)))
  }

  useEffect(loadMembers, [organizationId])

  if (showTemplates) {
    return (
      <LeaseTemplates
        organizationId={organizationId}
        onBack={() => setShowTemplates(false)}
      />
    )
  }

  // Tenants are left out. They arrive through a lease, they are listed on
  // the property they rent, and a roster of everyone who has ever rented
  // from you is a different screen than "who works here".
  const staff = (members ?? []).filter((m) => m.role !== 'tenant')

  return (
    <div>
      <button className="link" onClick={onBack}>← Back</button>
      <h2>Settings</h2>

      <h3 style={{ marginTop: '1.5rem' }}>Appearance</h3>
      <p className="muted" style={{ marginTop: 0 }}>
        System follows whatever your phone or computer is set to.
      </p>
      <div className="seg" role="radiogroup" aria-label="Appearance">
        {THEME_CHOICES.map((choice) => (
          <button
            key={choice.value}
            type="button"
            role="radio"
            aria-checked={theme === choice.value}
            className={theme === choice.value ? 'seg-item is-current' : 'seg-item'}
            onClick={() => setTheme(choice.value)}
          >
            {choice.label}
          </button>
        ))}
      </div>

      <div style={{ display: 'flex', justifyContent: 'space-between',
                    alignItems: 'center', marginTop: '2rem' }}>
        <h3 style={{ margin: 0 }}>Your team</h3>
        {canInviteMembers && !inviting && (
          <button className="link" onClick={() => setInviting(true)}>
            + Invite someone
          </button>
        )}
      </div>

      {inviting && (
        <InviteMember onDone={() => { setInviting(false); loadMembers() }} />
      )}

      {error && <p className="error-text">{error}</p>}
      {members === null && !error && <p className="muted">Loading…</p>}
      {members !== null && staff.length === 0 && (
        <p className="empty-state">
          It's just you so far
          {canInviteMembers ? ' — invite someone above.' : '.'}
        </p>
      )}

      {staff.length > 0 && (
        <div className="card-list">
          {staff.map((m) => (
            <div key={m.id}>
              <div style={{ display: 'flex', justifyContent: 'space-between',
                            alignItems: 'baseline', gap: '0.5rem' }}>
                <strong>{m.full_name ?? 'Unnamed'}</strong>
                <span className="muted" style={{ margin: 0 }}>
                  {ROLE_LABEL[m.role]}
                </span>
              </div>
              {/* Only worth a line when it isn't the normal case. */}
              {m.status !== 'active' && (
                <div className="muted">
                  {m.status === 'disabled'
                    ? 'Disabled — cannot sign in.'
                    : 'Invited, but has not joined yet.'}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      <h3 style={{ marginTop: '2rem' }}>Documents</h3>
      <div className="card-list">
        <div
          role="button"
          tabIndex={0}
          onClick={() => setShowTemplates(true)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault()
              setShowTemplates(true)
            }
          }}
          style={{ cursor: 'pointer' }}
        >
          <strong>Lease templates</strong>
          <div className="muted">
            The clause wording your leases are printed from.
          </div>
        </div>
      </div>
    </div>
  )
}
