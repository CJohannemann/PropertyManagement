import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { fetchMyMemberships, fetchOrganizationName, type Membership } from '../lib/org'
import { navigate } from '../lib/route'
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
        // A user with more than one active membership (multi-org, future
        // multi-landlord case) just sees the first one for now — an org
        // switcher is a real feature to build later, not a v1 concern.
        const m = rows[0]
        setMembership(m)
        setOrgName(await fetchOrganizationName(m.organization_id))
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
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
        <button className="link" onClick={signOut}>
          Sign out
        </button>
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
