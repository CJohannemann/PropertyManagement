import { useEffect, useState } from 'react'
import { supabase, errorMessage } from '../lib/supabase'
import { fetchMyMemberships, fetchOrganizationName, type Membership } from '../lib/org'
import { navigate, APP_SECTIONS, type Route } from '../lib/route'
import { greeting, todayLong } from '../lib/dashboard'
import { NotificationBell } from './NotificationBell'
import { SettingsMenu } from './SettingsMenu'
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

type Props = {
  /** Which section the URL is asking for. */
  section: Route
  /** The property id, when the URL carries one (/properties/<id>). */
  propertyId?: string
}

export function Dashboard({ section, propertyId }: Props) {
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
          {/* Greets by first name when there is one. A landlord who never
              recorded a name gets the organization, which is still better
              than "Good morning, null". */}
          <strong>
            {membership.full_name
              ? `${greeting()}, ${membership.full_name.split(' ')[0]}`
              : orgName}
          </strong>
          {/* One line, not three. The organization keeps its place —
              someone managing for more than one landlord needs to know
              whose books they are looking at — but the role badge joins it
              rather than taking a line of its own, which left "Sign out"
              floating beside a three-line block. */}
          <div className="muted" style={{ fontSize: '0.85rem' }}>
            {membership.full_name ? `${orgName} · ` : ''}
            {ROLE_LABEL[membership.role]} · {todayLong()}
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
          {/* The bell is for everyone. It was admin/PM-only because every
              notification was raised with org_member_id null, so those
              were the only rows anyone could read. Migration 027 raises
              notifications addressed to a single member — a tenant told
              their repair is booked in, a technician offered a job — and
              hiding the bell from them would mean writing those rows and
              then never showing them. The RLS policy in 023 already
              scopes it: an unaddressed notification stays management-only. */}
          <NotificationBell organizationId={membership.organization_id} />
          {(membership.role === 'admin' || membership.role === 'property_manager') && (
            <NotificationsToggle memberId={membership.id} />
          )}
          {/* Only admins and property managers have a /settings screen —
              the other two dashboards ignore the section entirely — so
              only they are offered the way in. Appearance and sign out
              are in the menu itself, so everyone still gets those. */}
          <SettingsMenu
            canOpenSettings={
              membership.role === 'admin' || membership.role === 'property_manager'
            }
            onSignOut={signOut}
          />
        </div>
      </header>
      <main className="app-main">
        {membership.role === 'admin' && (
          <AdminDashboard
            organizationId={membership.organization_id}
            organizationName={orgName}
            memberId={membership.id}
            section={section}
            propertyId={propertyId}
          />
        )}
        {membership.role === 'property_manager' && (
          <PropertyManagerDashboard
            organizationId={membership.organization_id}
            organizationName={orgName}
            memberId={membership.id}
            section={section}
            propertyId={propertyId}
          />
        )}
        {membership.role === 'technician' && (
          <TechnicianDashboard memberId={membership.id} />
        )}
        {membership.role === 'tenant' && <TenantDashboard memberId={membership.id} />}
      </main>

      {/* Only the roles that have more than one section. A tenant and a
          technician each have a single screen, and a nav bar with one tab
          is furniture. */}
      {(membership.role === 'admin' || membership.role === 'property_manager') && (
        <nav className="app-nav" aria-label="Sections">
          {APP_SECTIONS.map((s) => (
            <button
              key={s.route}
              className={section === s.route ? 'app-nav-item is-current' : 'app-nav-item'}
              aria-current={section === s.route ? 'page' : undefined}
              onClick={() => navigate(s.route)}
            >
              {s.label}
            </button>
          ))}
        </nav>
      )}
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
