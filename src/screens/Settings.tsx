import { errorMessage, supabase } from '../lib/supabase'
import { useEffect, useState } from 'react'
import { fetchOrgMembers, setMemberStatus, type Membership } from '../lib/org'
import {
  fetchTechnicianAccess, setTechnicianAccess, type TechnicianAccess,
} from '../lib/equipment'
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
  const [properties, setProperties] = useState<PropertyOption[]>([])

  function loadMembers() {
    fetchOrgMembers(organizationId)
      .then(setMembers)
      .catch((e) => setError(errorMessage(e)))
  }

  useEffect(loadMembers, [organizationId])

  // For choosing which properties each technician services.
  useEffect(() => {
    supabase?.from('properties').select('id, name')
      .eq('organization_id', organizationId).order('name')
      .then(({ data }) => setProperties((data ?? []) as PropertyOption[]))
  }, [organizationId])

  if (showTemplates) {
    return (
      <LeaseTemplates
        organizationId={organizationId}
        onBack={() => setShowTemplates(false)}
      />
    )
  }

  const staff = (members ?? []).filter((m) => m.role !== 'tenant')
  const renters = (members ?? []).filter((m) => m.role === 'tenant')

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
      {staff.length > 0 && (
        <div className="card-list">
          {staff.map((m) => (
            <MemberRow key={m.id} member={m} onChanged={loadMembers}
              properties={properties} />
          ))}
        </div>
      )}

      {/* The viewer is always in the list above, so "empty" here means
          "nobody but you" rather than nothing at all. */}
      {members !== null && staff.length <= 1 && canInviteMembers && (
        <p className="muted" style={{ marginTop: '0.75rem' }}>
          It's just you so far.
        </p>
      )}

      {/* Tenants are listed separately rather than mixed into the team.
          They are here at all because taking a renter's access away has to
          be possible somewhere, and the lease screen is about the tenancy
          — which outlives the login. */}
      {renters.length > 0 && (
        <>
          <h3 style={{ marginTop: '2rem' }}>Tenants</h3>
          <p className="muted" style={{ marginTop: 0 }}>
            Removing access signs someone out of the app. It does not end
            their lease or clear what they owe.
          </p>
          <div className="card-list">
            {renters.map((m) => (
              <MemberRow key={m.id} member={m} onChanged={loadMembers} />
            ))}
          </div>
        </>
      )}

      <h3 style={{ marginTop: '2.5rem' }}>Documents</h3>
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

/**
 * One person, and the one thing you can do to them.
 *
 * Confirming before removing access, because it is not obvious from the
 * outside that this is reversible — and because doing it to the wrong row
 * locks a real person out of their own lease.
 */
function MemberRow({
  member, onChanged, properties,
}: { member: Membership; onChanged: () => void; properties?: PropertyOption[] }) {
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const disabled = member.status === 'disabled'

  async function change(status: 'active' | 'disabled') {
    setBusy(true)
    setError(null)
    try {
      await setMemberStatus(member.id, status)
      setConfirming(false)
      onChanged()
    } catch (e) {
      setError(errorMessage(e))
    }
    setBusy(false)
  }

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between',
                    alignItems: 'baseline', gap: '0.5rem' }}>
        <strong>{member.full_name ?? 'Unnamed'}</strong>
        <span className="muted" style={{ margin: 0 }}>
          {ROLE_LABEL[member.role]}
        </span>
      </div>

      {/* Only worth a line when it isn't the normal case. */}
      {member.status === 'invited' && (
        <div className="muted">Invited, but has not joined yet.</div>
      )}
      {disabled && <div className="muted">Access removed — cannot sign in.</div>}

      {member.role === 'technician' && properties && (
        <TechnicianAccessEditor memberId={member.id} properties={properties} />
      )}

      {error && <p className="error-text">{error}</p>}

      {disabled ? (
        <button className="link" disabled={busy} onClick={() => change('active')}>
          {busy ? 'Restoring…' : 'Restore access'}
        </button>
      ) : confirming ? (
        <div style={{ display: 'flex', gap: '1rem', alignItems: 'center' }}>
          <button className="link" disabled={busy} onClick={() => change('disabled')}
            style={{ color: 'var(--danger)' }}>
            {busy ? 'Removing…' : 'Yes, remove access'}
          </button>
          <button className="link" onClick={() => setConfirming(false)}>Cancel</button>
        </div>
      ) : (
        <button className="link" onClick={() => setConfirming(true)}>
          Remove access
        </button>
      )}
    </div>
  )
}

type PropertyOption = { id: string; name: string }

/**
 * Which properties a technician services. That decides what they see in
 * the app — the properties, their units and equipment — and which jobs
 * they can be offered. A technician starts with none, so nothing is
 * visible to them until somebody sets this.
 */
function TechnicianAccessEditor({
  memberId, properties,
}: { memberId: string; properties: PropertyOption[] }) {
  const [access, setAccess] = useState<TechnicianAccess | null>(null)
  const [draft, setDraft] = useState<TechnicianAccess | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    fetchTechnicianAccess(memberId)
      .then(setAccess)
      .catch((e) => setError(errorMessage(e)))
  }, [memberId])

  async function save() {
    if (!draft) return
    setBusy(true)
    setError(null)
    try {
      await setTechnicianAccess(memberId, draft)
      setAccess(draft)
      setDraft(null)
    } catch (e) {
      setError(errorMessage(e))
    }
    setBusy(false)
  }

  if (error && !access) return <p className="error-text">{error}</p>
  if (!access) return null

  const names = properties
    .filter((p) => access.propertyIds.includes(p.id))
    .map((p) => p.name)
  const summary = access.all
    ? 'All properties'
    : names.length > 0
      ? names.join(', ')
      : 'No properties yet — they cannot see any'

  if (!draft) {
    return (
      <div className="muted" style={{ margin: '0.25rem 0' }}>
        Services: {summary}
        {' · '}
        <button className="link" onClick={() => setDraft(access)}>Change</button>
      </div>
    )
  }

  function toggle(id: string) {
    setDraft((d) => d && {
      ...d,
      propertyIds: d.propertyIds.includes(id)
        ? d.propertyIds.filter((x) => x !== id)
        : [...d.propertyIds, id],
    })
  }

  return (
    <fieldset style={{ border: '1px solid var(--line)', borderRadius: 8,
                       padding: '0.75rem', margin: '0.5rem 0' }}>
      <legend className="muted">Properties they service</legend>
      <label style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
        <input type="checkbox" checked={draft.all}
          onChange={(e) => setDraft({ ...draft, all: e.target.checked })} />
        All properties, including ones added later
      </label>
      {!draft.all && properties.map((p) => (
        <label key={p.id}
          style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', marginTop: '0.4rem' }}>
          <input type="checkbox" checked={draft.propertyIds.includes(p.id)}
            onChange={() => toggle(p.id)} />
          {p.name}
        </label>
      ))}
      {error && <p className="error-text">{error}</p>}
      <div style={{ display: 'flex', gap: '1rem', marginTop: '0.75rem' }}>
        <button className="link" disabled={busy} onClick={save}>
          {busy ? 'Saving…' : 'Save'}
        </button>
        <button className="link" onClick={() => { setDraft(null); setError(null) }}>Cancel</button>
      </div>
    </fieldset>
  )
}
