import { useEffect, useState } from 'react'
import { supabase, errorMessage } from '../lib/supabase'
import { fetchMyMemberships, fetchOrganizationName, type Membership } from '../lib/org'
import { navigate } from '../lib/route'
import { pushSupported, pushPermission, enablePushNotifications } from '../lib/push'
import { AdminDashboard } from './dashboards/AdminDashboard'
import { PropertyManagerDashboard } from './dashboards/PropertyManagerDashboard'
import { TechnicianDashboard } from './dashboards/TechnicianDashboard'
import { TenantDashboard } from './dashboards/TenantDashboard'

const ROLE_LABEL: Record<Membership['role'], string> = {
  admin: 'Admin',
  property_manager: 'Property Manager',
  technician: 'Technician',
  tenant: 'Tenant',
}

export function Dashboard() {
  const [membership, setMembership] = useState<Membership | null | 'none'>(null)
  const [orgName, setOrgName] = useState('')
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    fetchMyMemberships()
      .then(async (rows) => {
        if (rows.length === 0) {
          setMembership('none')
          navigate('/setup', { replace: true })
          return
        }
        // fetchMyMemberships sorts most-privileged first, so this lands on
        // the admin view for someone who is also a tenant somewhere rather
        // than on whichever row the database returned first. An org
        // switcher is still a real feature for later; deterministic
        // ordering is the part that had to exist now.
        const m = rows[0]
        setMembership(m)
        setOrgName(await fetchOrganizationName(m.organization_id))
      })
      .catch((err) => setError(errorMessage(err)))
  }, [])

  async function signOut() {
    await supabase?.auth.signOut()
    navigate('/login', { replace: true })
  }

  if (error) {
    return (
      <div className="auth-page">
        <div className="auth-card">
          <p className="error-text">{error}</p>
        </div>
      </div>
    )
  }

  if (membership === null || membership === 'none') {
    return (
      <div className="auth-page">
        <div className="auth-card">
          <p className="muted">Loading…</p>
        </div>
      </div>
    )
  }

  return (
    <div className="app-shell">
      <header className="app-header">
        <div>
          <strong>{orgName}</strong>
          <div className="role-badge">{ROLE_LABEL[membership.role]}</div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
          {(membership.role === 'admin' || membership.role === 'property_manager') && (
            <NotificationsToggle memberId={membership.id} />
          )}
          <button className="link" onClick={signOut}>
            Sign out
          </button>
        </div>
      </header>
      <main className="app-main">
        {membership.role === 'admin' && (
          <AdminDashboard
            organizationId={membership.organization_id}
            organizationName={orgName}
            memberId={membership.id}
          />
        )}
        {membership.role === 'property_manager' && (
          <PropertyManagerDashboard
            organizationId={membership.organization_id}
            organizationName={orgName}
            memberId={membership.id}
          />
        )}
        {membership.role === 'technician' && (
          <TechnicianDashboard memberId={membership.id} />
        )}
        {membership.role === 'tenant' && <TenantDashboard memberId={membership.id} />}
      </main>
    </div>
  )
}

/** Lets an admin/PM opt into a browser push when a new request comes in. */
function NotificationsToggle({ memberId }: { memberId: string }) {
  const [permission, setPermission] = useState(pushPermission())
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (!pushSupported || permission === 'granted') return null

  if (permission === 'denied') {
    return (
      <span className="muted" style={{ fontSize: '0.85rem' }}>
        Notifications blocked — allow them in your browser's site settings.
      </span>
    )
  }

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
      <button
        className="link"
        disabled={busy}
        onClick={async () => {
          setBusy(true); setError(null)
          try {
            await enablePushNotifications(memberId)
            setPermission(pushPermission())
          } catch (err) {
            setError(errorMessage(err))
          }
          setBusy(false)
        }}
      >
        {busy ? 'Enabling…' : 'Enable notifications'}
      </button>
      {error && <span className="error-text" style={{ fontSize: '0.85rem' }}>{error}</span>}
    </div>
  )
}
